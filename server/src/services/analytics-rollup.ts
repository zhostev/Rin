import { eq, sql } from "drizzle-orm";
import type { DB } from "../core/hono-types";
import { analyticsDaily, analyticsDimDaily, visitStats } from "../db/schema";
import {
    ANALYTICS_DATASET,
    AnalyticsUnavailableError,
    queryAnalyticsEngine,
} from "../utils/analytics-query";
import { utcDateString } from "../utils/analytics";

export const ANALYTICS_CURSOR_KEY = "analytics.last_rollup";

/** AE 保留 3 个月；90 天是可安全查询的窗口。 */
export const ANALYTICS_WINDOW_DAYS = 90;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type RollupConfig = {
    getOrDefault<T>(key: string, defaultValue: T): Promise<T>;
    set(key: string, value: unknown, save?: boolean): Promise<void>;
};

export function addDays(date: string, days: number): string {
    const base = new Date(`${date}T00:00:00.000Z`);
    base.setUTCDate(base.getUTCDate() + days);
    return utcDateString(base);
}

export function analyticsWindowStart(today: string): string {
    return addDays(today, -ANALYTICS_WINDOW_DAYS);
}

/**
 * 待聚合的已完结日期列表（不含今天）。
 * 游标早于 AE 窗口时直接跳到窗口起点，跳过的区间不再重试。
 */
export function pendingRollupDates(cursor: string | null, today: string, windowStart: string): string[] {
    const effectiveCursor = cursor && cursor > windowStart ? cursor : windowStart;
    const dates: string[] = [];

    let current = addDays(effectiveCursor, 1);
    while (current < today) {
        dates.push(current);
        current = addDays(current, 1);
    }

    return dates;
}

function assertDate(date: string): string {
    if (!DATE_PATTERN.test(date)) {
        throw new Error(`Refusing to build SQL with a malformed date: ${date}`);
    }
    return date;
}

export function buildFeedRollupSql(date: string): string {
    const day = assertDate(date);
    return `
        SELECT index1 AS feed_id,
               SUM(_sample_interval) AS pv,
               COUNT(DISTINCT blob6) AS uv
        FROM ${ANALYTICS_DATASET}
        WHERE toDate(timestamp) = toDate('${day}')
        GROUP BY index1
        FORMAT JSON
    `.trim();
}

export function buildDimensionRollupSql(date: string): string {
    const day = assertDate(date);
    const dimension = (column: string, type: string) => `
        SELECT '${type}' AS dim_type, ${column} AS dim_value, SUM(_sample_interval) AS count
        FROM ${ANALYTICS_DATASET}
        WHERE toDate(timestamp) = toDate('${day}')
        GROUP BY ${column}
    `.trim();

    return `
        ${dimension("blob2", "referrer")}
        UNION ALL
        ${dimension("blob3", "country")}
        UNION ALL
        ${dimension("blob5", "device")}
        FORMAT JSON
    `.trim();
}

interface FeedRollupRow {
    feed_id: string;
    pv: number;
    uv: number;
}

interface DimensionRollupRow {
    dim_type: string;
    dim_value: string;
    count: number;
}

async function rollupDate(env: Env, db: DB, date: string): Promise<void> {
    const feedRows = await queryAnalyticsEngine<FeedRollupRow>(env, buildFeedRollupSql(date));
    const dimRows = await queryAnalyticsEngine<DimensionRollupRow>(env, buildDimensionRollupSql(date));

    for (const row of feedRows) {
        const feedId = Number(row.feed_id);
        if (!Number.isSafeInteger(feedId) || feedId <= 0) {
            continue;
        }

        const pv = Number(row.pv) || 0;
        const uv = Number(row.uv) || 0;

        await db.insert(analyticsDaily)
            .values({ date, feedId, pv, uv })
            .onConflictDoUpdate({
                target: [analyticsDaily.date, analyticsDaily.feedId],
                set: { pv, uv },
            });

        // visit_stats 是文章页读取的持久计数器。
        // 由 baseline + 聚合结果重算：baseline 冻结了本功能上线前的历史累计值，
        // 重算保证幂等（同一天重复聚合不会重复计数）。
        const totals = await db
            .select({
                pv: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)`,
                uv: sql<number>`COALESCE(SUM(${analyticsDaily.uv}), 0)`,
            })
            .from(analyticsDaily)
            .where(eq(analyticsDaily.feedId, feedId));

        const aggregatedPv = Number(totals[0]?.pv) || 0;
        const aggregatedUv = Number(totals[0]?.uv) || 0;

        const existing = await db.query.visitStats.findFirst({ where: eq(visitStats.feedId, feedId) });
        if (existing) {
            await db.update(visitStats)
                .set({
                    pv: existing.pvBaseline + aggregatedPv,
                    uv: existing.uvBaseline + aggregatedUv,
                    updatedAt: new Date(),
                })
                .where(eq(visitStats.feedId, feedId));
        } else {
            await db.insert(visitStats).values({
                feedId,
                pv: aggregatedPv,
                uv: aggregatedUv,
                pvBaseline: 0,
                uvBaseline: 0,
                hllData: "",
            });
        }
    }

    for (const row of dimRows) {
        const dimValue = (row.dim_value || "").slice(0, 200);
        if (!dimValue) {
            continue;
        }

        const count = Number(row.count) || 0;
        await db.insert(analyticsDimDaily)
            .values({ date, dimType: row.dim_type, dimValue, count })
            .onConflictDoUpdate({
                target: [analyticsDimDaily.date, analyticsDimDaily.dimType, analyticsDimDaily.dimValue],
                set: { count },
            });
    }
}

/**
 * 每日聚合。cron 每 20 分钟调用，无待聚合日期时立即返回。
 * AE 不可用时记录告警并保持游标不动，下一轮重试。
 */
export async function analyticsCrontab(env: Env, db: DB, serverConfig: RollupConfig): Promise<void> {
    const today = utcDateString(new Date());
    const cursor = await serverConfig.getOrDefault<string>(ANALYTICS_CURSOR_KEY, "");
    const dates = pendingRollupDates(cursor || null, today, analyticsWindowStart(today));

    if (dates.length === 0) {
        return;
    }

    for (const date of dates) {
        try {
            await rollupDate(env, db, date);
            await serverConfig.set(ANALYTICS_CURSOR_KEY, date, true);
        } catch (error) {
            if (error instanceof AnalyticsUnavailableError) {
                console.warn(`analytics: rollup skipped for ${date} (${error.reason})`, error.message);
            } else {
                console.error(`analytics: rollup failed for ${date}`, error);
            }
            return;
        }
    }
}
