import { inArray, sql } from "drizzle-orm";
import type { DB } from "../core/hono-types";
import { analyticsDaily, analyticsDimDaily, feeds, visitStats } from "../db/schema";
import { utcDateString } from "../utils/analytics";
import {
    ANALYTICS_DATASET,
    AnalyticsUnavailableError,
    queryAnalyticsEngine,
} from "../utils/analytics-query";

export const ANALYTICS_CURSOR_KEY = "analytics.last_rollup";

/** AE 保留 3 个月；90 天是可安全查询的窗口。 */
export const ANALYTICS_WINDOW_DAYS = 90;

/**
 * 单次 cron 调用最多聚合的日期数。
 * 每个日期要发 2 个 AE 请求，空游标会一次性排到 89 天；
 * 游标逐日推进，超出部分留给下一轮（20 分钟一次）自愈。
 */
export const MAX_ROLLUP_DATES_PER_RUN = 10;

/** inArray 的分片大小，避免一次绑定过多参数。 */
const ID_CHUNK_SIZE = 50;

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

export interface ParsedFeedRollupRow {
    feedId: number;
    pv: number;
    uv: number;
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

/** 规整 AE 返回的 feed 行：丢弃非法 feed_id，并合并重复的 feed_id。 */
export function parseFeedRollupRows(rows: FeedRollupRow[]): ParsedFeedRollupRow[] {
    const byFeed = new Map<number, ParsedFeedRollupRow>();

    for (const row of rows) {
        const feedId = Number(row.feed_id);
        if (!Number.isSafeInteger(feedId) || feedId <= 0) {
            continue;
        }

        const pv = Number(row.pv) || 0;
        const uv = Number(row.uv) || 0;
        const existing = byFeed.get(feedId);

        if (existing) {
            existing.pv += pv;
            existing.uv += uv;
        } else {
            byFeed.set(feedId, { feedId, pv, uv });
        }
    }

    return [...byFeed.values()];
}

/** 仍然存在于 feeds 表中的 id。AE 保留 3 个月，期间文章可能已被删除。 */
async function selectExistingFeedIds(db: DB, feedIds: number[]): Promise<Set<number>> {
    const found = new Set<number>();

    for (const ids of chunk(feedIds, ID_CHUNK_SIZE)) {
        const rows = await db.select({ id: feeds.id }).from(feeds).where(inArray(feeds.id, ids));
        for (const row of rows) {
            found.add(row.id);
        }
    }

    return found;
}

/**
 * 由 baseline + analytics_daily 全量聚合重算 visit_stats。
 * baseline 冻结了本功能上线前的历史累计值；重算（而非累加）保证幂等：
 * 同一天重复聚合不会重复计数。
 */
export async function recomputeVisitStats(db: DB, feedIds: number[]): Promise<void> {
    if (feedIds.length === 0) {
        return;
    }

    const aggregated = new Map<number, { pv: number; uv: number }>();
    const existingStats = new Map<number, typeof visitStats.$inferSelect>();

    for (const ids of chunk(feedIds, ID_CHUNK_SIZE)) {
        const totals = await db
            .select({
                feedId: analyticsDaily.feedId,
                pv: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)`,
                uv: sql<number>`COALESCE(SUM(${analyticsDaily.uv}), 0)`,
            })
            .from(analyticsDaily)
            .where(inArray(analyticsDaily.feedId, ids))
            .groupBy(analyticsDaily.feedId);

        for (const row of totals) {
            aggregated.set(row.feedId, { pv: Number(row.pv) || 0, uv: Number(row.uv) || 0 });
        }

        const stats = await db.select().from(visitStats).where(inArray(visitStats.feedId, ids));
        for (const row of stats) {
            existingStats.set(row.feedId, row);
        }
    }

    const updatedAt = new Date();

    for (const ids of chunk(feedIds, ID_CHUNK_SIZE)) {
        const values = ids.map((feedId) => {
            const totals = aggregated.get(feedId) ?? { pv: 0, uv: 0 };
            const existing = existingStats.get(feedId);
            const pvBaseline = existing?.pvBaseline ?? 0;
            const uvBaseline = existing?.uvBaseline ?? 0;

            return {
                feedId,
                pv: pvBaseline + totals.pv,
                uv: uvBaseline + totals.uv,
                pvBaseline,
                uvBaseline,
                hllData: existing?.hllData ?? "",
                updatedAt,
            };
        });

        // 一条 upsert 覆盖整批：只改 pv/uv，baseline 与 hll_data 原样保留。
        await db.insert(visitStats).values(values).onConflictDoUpdate({
            target: visitStats.feedId,
            set: { pv: sql`excluded.pv`, uv: sql`excluded.uv`, updatedAt },
        });
    }
}

async function rollupFeedRows(db: DB, date: string, rows: FeedRollupRow[]): Promise<void> {
    const parsed = parseFeedRollupRows(rows);
    if (parsed.length === 0) {
        return;
    }

    // visit_stats.feed_id 是 feeds.id 的外键，D1 会强制执行。
    // 已删除的文章在 AE 里仍有数据，直接写入会抛 FOREIGN KEY constraint failed
    // 并卡死游标，因此这里先过滤掉不存在的 feed。
    const existingFeedIds = await selectExistingFeedIds(db, parsed.map((row) => row.feedId));
    const live = parsed.filter((row) => existingFeedIds.has(row.feedId));
    const skipped = parsed.length - live.length;

    if (skipped > 0) {
        console.warn(`analytics: rollup for ${date} skipped ${skipped} row(s) whose feed no longer exists`);
    }

    if (live.length === 0) {
        return;
    }

    for (const batch of chunk(live, ID_CHUNK_SIZE)) {
        await db.insert(analyticsDaily)
            .values(batch.map((row) => ({ date, feedId: row.feedId, pv: row.pv, uv: row.uv })))
            .onConflictDoUpdate({
                target: [analyticsDaily.date, analyticsDaily.feedId],
                set: { pv: sql`excluded.pv`, uv: sql`excluded.uv` },
            });
    }

    await recomputeVisitStats(db, live.map((row) => row.feedId));
}

async function rollupDimensionRows(db: DB, date: string, rows: DimensionRollupRow[]): Promise<void> {
    const byKey = new Map<string, { dimType: string; dimValue: string; count: number }>();

    for (const row of rows) {
        const dimValue = (row.dim_value || "").slice(0, 200);
        if (!dimValue) {
            continue;
        }

        const key = `${row.dim_type}\u0000${dimValue}`;
        const count = Number(row.count) || 0;
        const existing = byKey.get(key);

        if (existing) {
            existing.count += count;
        } else {
            byKey.set(key, { dimType: row.dim_type, dimValue, count });
        }
    }

    for (const batch of chunk([...byKey.values()], ID_CHUNK_SIZE)) {
        await db.insert(analyticsDimDaily)
            .values(batch.map((row) => ({ date, dimType: row.dimType, dimValue: row.dimValue, count: row.count })))
            .onConflictDoUpdate({
                target: [analyticsDimDaily.date, analyticsDimDaily.dimType, analyticsDimDaily.dimValue],
                set: { count: sql`excluded.count` },
            });
    }
}

async function rollupDate(env: Env, db: DB, date: string): Promise<void> {
    const feedRows = await queryAnalyticsEngine<FeedRollupRow>(env, buildFeedRollupSql(date));
    const dimRows = await queryAnalyticsEngine<DimensionRollupRow>(env, buildDimensionRollupSql(date));

    await rollupFeedRows(db, date, feedRows);
    await rollupDimensionRows(db, date, dimRows);
}

/**
 * 每日聚合。cron 每 20 分钟调用，无待聚合日期时立即返回。
 * AE 不可用时记录告警并保持游标不动，下一轮重试。
 */
export async function analyticsCrontab(env: Env, db: DB, serverConfig: RollupConfig): Promise<void> {
    const today = utcDateString(new Date());
    const cursor = await serverConfig.getOrDefault<string>(ANALYTICS_CURSOR_KEY, "");
    const pending = pendingRollupDates(cursor || null, today, analyticsWindowStart(today));
    // 超出上限的日期留给下一轮 cron：游标逐日推进，不会丢数据。
    const dates = pending.slice(0, MAX_ROLLUP_DATES_PER_RUN);

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
