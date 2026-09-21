import type {
    AnalyticsDailyPoint,
    AnalyticsDimensionItem,
    AnalyticsDimensionType,
    AnalyticsDimensionsResponse,
    AnalyticsLiveTotals,
    AnalyticsLiveResponse,
    AnalyticsOverview,
    AnalyticsTopFeed,
    AnalyticsTopFeedsResponse,
    AnalyticsVisit,
    AnalyticsVisitsResponse,
} from "@rin/api";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import { analyticsDaily, analyticsDimDaily, feeds } from "../db/schema";
import { utcDateString } from "../utils/analytics";
import {
    ANALYTICS_DATASET,
    AnalyticsUnavailableError,
    queryAnalyticsEngine,
} from "../utils/analytics-query";
import { addDays } from "./analytics-rollup";

const SUPPORTED_DAYS = [7, 30, 90] as const;
const DIMENSION_TYPES: AnalyticsDimensionType[] = ["referrer", "country", "device"];

const guard = { status: 403, format: "json" } as const;

export function parseDays(value: string | undefined): 7 | 30 | 90 {
    const parsed = Number.parseInt(value ?? "", 10);
    return (SUPPORTED_DAYS as readonly number[]).includes(parsed) ? (parsed as 7 | 30 | 90) : 30;
}

export function parseLimit(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 20;
    }
    return Math.min(parsed, 100);
}

export function parseDimensionType(value: string | undefined): AnalyticsDimensionType {
    return DIMENSION_TYPES.includes(value as AnalyticsDimensionType)
        ? (value as AnalyticsDimensionType)
        : "referrer";
}

export function parseVisitLimit(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 100;
    }
    return Math.min(parsed, 500);
}

/**
 * AE SQL API 的时间戳格式不保证是 ISO(可能是 `YYYY-MM-DD HH:MM:SS`)。
 * 客户端要 `new Date(ts)` 解析,而 Safari 与 Chrome 对非 ISO 字符串的行为不一致,
 * 透传会变成只在部分浏览器出现的空白时间列 —— 所以在服务端归一化。
 */
export function normalizeAeTimestamp(raw: string): string {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) {
        return "";
    }

    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
    const candidate = hasZone ? trimmed : `${trimmed.replace(" ", "T")}Z`;
    const date = new Date(candidate);

    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function buildVisitDetailSql(limit: number, dataset: string = ANALYTICS_DATASET): string {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new Error(`Refusing to build SQL with a non-integer limit: ${limit}`);
    }

    return [
        "SELECT timestamp, index1, blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, _sample_interval",
        `FROM ${dataset}`,
        "ORDER BY timestamp DESC",
        `LIMIT ${limit}`,
        "FORMAT JSON",
    ].join(" ");
}

/**
 * analytics_daily 只为有访问的日期建行，而折线图按下标等距排点：
 * 30 天区间里只有首尾两天有数据时会画成一条匀速上升的斜线。
 * 这里在服务端把区间补齐，缺失的日期填 0。
 */
/**
 * 紧邻当前区间之前的等长窗口，用于区间卡环比。
 *
 * 长度取当前区间里**已完结**的天数（days - 1），不是 days：当前区间的最后一天
 * 是今天，而 cron 从不聚合未完结的当天，所以它在 analytics_daily 里恒为 0。
 * 若 previous 取满 days 天，就是拿 days 天的历史去比 days-1 天的当前值，
 * 箭头会系统性地永远指向下降。
 *
 * 返回的窗口两端闭合，且整体早于今天，因此数据必然完整。
 */
export function previousWindow(from: string, days: number): { from: string; to: string } {
    const completeDays = Math.max(days - 1, 1);
    return { from: addDays(from, -completeDays), to: addDays(from, -1) };
}

export function zeroFillSeries(points: AnalyticsDailyPoint[], from: string, days: number): AnalyticsDailyPoint[] {
    const byDate = new Map(points.map((point) => [point.date, point]));
    const filled: AnalyticsDailyPoint[] = [];

    for (let offset = 0; offset < days; offset++) {
        const date = addDays(from, offset);
        filled.push(byDate.get(date) ?? { date, pv: 0, uv: 0 });
    }

    return filled;
}

/**
 * /live 的两个查询窗口。做成纯函数是为了能离线断言 SQL 形状
 * （AE 的方言本身无法离线执行，见计划 Ruling E）。
 *
 * 站点级、UTC 当日、不做任何分组或截断：
 * 昨日窗口刻意加 `toHour(timestamp) <= toHour(now())`，让分子分母的
 * 「已过小时数」一致 —— 否则拿今天 3 小时去比昨天一整天。
 */
export function buildLiveTotalsSql(dataset: string = ANALYTICS_DATASET): string {
    return [
        "SELECT SUM(_sample_interval) AS pv, COUNT(DISTINCT blob6) AS uv",
        `FROM ${dataset}`,
        "WHERE toDate(timestamp) = toDate(now())",
        "FORMAT JSON",
    ].join(" ");
}

export function buildLiveYesterdaySql(dataset: string = ANALYTICS_DATASET): string {
    return [
        "SELECT SUM(_sample_interval) AS pv, COUNT(DISTINCT blob6) AS uv",
        `FROM ${dataset}`,
        "WHERE toDate(timestamp) = toDate(now() - INTERVAL '1' DAY)",
        "AND toHour(timestamp) <= toHour(now())",
        "FORMAT JSON",
    ].join(" ");
}

function pickLiveTotals(rows: Array<{ pv?: unknown; uv?: unknown }>): AnalyticsLiveTotals {
    const row = rows[0];
    return { pv: Number(row?.pv) || 0, uv: Number(row?.uv) || 0 };
}

export function AnalyticsService() {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();

    // GET /analytics/overview?days=30
    app.get("/overview", adminOnly(async (c) => {
        const db = c.get("db");
        const days = parseDays(c.req.query("days"));
        const today = utcDateString(new Date());
        const yesterday = addDays(today, -1);
        const from = addDays(today, -(days - 1));

        const rows = await db
            .select({
                date: analyticsDaily.date,
                pv: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)`,
                uv: sql<number>`COALESCE(SUM(${analyticsDaily.uv}), 0)`,
            })
            .from(analyticsDaily)
            .where(gte(analyticsDaily.date, from))
            .groupBy(analyticsDaily.date)
            .orderBy(analyticsDaily.date);

        const series = zeroFillSeries(
            rows.map((row) => ({
                date: row.date,
                pv: Number(row.pv) || 0,
                uv: Number(row.uv) || 0,
            })),
            from,
            days,
        );

        const { from: previousFrom, to: previousTo } = previousWindow(from, days);

        const previousRows = await db
            .select({
                pv: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)`,
                uv: sql<number>`COALESCE(SUM(${analyticsDaily.uv}), 0)`,
            })
            .from(analyticsDaily)
            .where(and(gte(analyticsDaily.date, previousFrom), lte(analyticsDaily.date, previousTo)));

        const empty = { pv: 0, uv: 0 };
        const overview: AnalyticsOverview = {
            range: { days, from, to: today },
            totals: {
                pv: series.reduce((sum, point) => sum + point.pv, 0),
                uv: series.reduce((sum, point) => sum + point.uv, 0),
                // 每日轮换盐 → 跨日 UV 只能取各日之和，是高估的近似值。
                uvApproximate: days > 1,
            },
            today: series.find((point) => point.date === today) ?? { date: today, ...empty },
            yesterday: series.find((point) => point.date === yesterday) ?? { date: yesterday, ...empty },
            series,
            previous: {
                from: previousFrom,
                to: previousTo,
                pv: Number(previousRows[0]?.pv) || 0,
                uv: Number(previousRows[0]?.uv) || 0,
            },
        };

        return c.json(overview);
    }, guard));

    // GET /analytics/top-feeds?days=30&limit=20
    app.get("/top-feeds", adminOnly(async (c) => {
        const db = c.get("db");
        const days = parseDays(c.req.query("days"));
        const limit = parseLimit(c.req.query("limit"));
        const from = addDays(utcDateString(new Date()), -(days - 1));

        const rows = await db
            .select({
                feedId: analyticsDaily.feedId,
                title: feeds.title,
                pv: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)`,
                uv: sql<number>`COALESCE(SUM(${analyticsDaily.uv}), 0)`,
            })
            .from(analyticsDaily)
            .leftJoin(feeds, eq(feeds.id, analyticsDaily.feedId))
            .where(gte(analyticsDaily.date, from))
            .groupBy(analyticsDaily.feedId, feeds.title)
            .orderBy(desc(sql`SUM(${analyticsDaily.pv})`))
            .limit(limit);

        const response: AnalyticsTopFeedsResponse = {
            items: rows.map<AnalyticsTopFeed>((row) => ({
                feedId: row.feedId,
                title: row.title ?? null,
                pv: Number(row.pv) || 0,
                uv: Number(row.uv) || 0,
            })),
        };

        return c.json(response);
    }, guard));

    // GET /analytics/dimensions?days=30&type=referrer
    app.get("/dimensions", adminOnly(async (c) => {
        const db = c.get("db");
        const days = parseDays(c.req.query("days"));
        const type = parseDimensionType(c.req.query("type"));
        const from = addDays(utcDateString(new Date()), -(days - 1));

        const rows = await db
            .select({
                value: analyticsDimDaily.dimValue,
                count: sql<number>`COALESCE(SUM(${analyticsDimDaily.count}), 0)`,
            })
            .from(analyticsDimDaily)
            .where(and(gte(analyticsDimDaily.date, from), eq(analyticsDimDaily.dimType, type)))
            .groupBy(analyticsDimDaily.dimValue)
            .orderBy(desc(sql`SUM(${analyticsDimDaily.count})`))
            .limit(20);

        const response: AnalyticsDimensionsResponse = {
            type,
            items: rows.map<AnalyticsDimensionItem>((row) => ({
                value: row.value,
                count: Number(row.count) || 0,
            })),
        };

        return c.json(response);
    }, guard));

    // GET /analytics/live — 站点级「UTC 当日」累计；唯一直接查 Analytics Engine 的端点。
    app.get("/live", adminOnly(async (c) => {
        const now = new Date();
        const date = utcDateString(now);
        const elapsedHours = now.getUTCHours();

        try {
            const [todayRows, yesterdayRows] = await Promise.all([
                queryAnalyticsEngine<{ pv: unknown; uv: unknown }>(c.env, buildLiveTotalsSql()),
                queryAnalyticsEngine<{ pv: unknown; uv: unknown }>(c.env, buildLiveYesterdaySql()),
            ]);

            const response: AnalyticsLiveResponse = {
                available: true,
                date,
                totals: pickLiveTotals(todayRows),
                yesterday: pickLiveTotals(yesterdayRows),
                uvApproximate: true,
                elapsedHours,
            };

            return c.json(response);
        } catch (error) {
            if (error instanceof AnalyticsUnavailableError) {
                // 未配置 token 或 token 缺少 Account Analytics Read 权限 → 降级，不是 500。
                console.warn("analytics: live query unavailable", error.reason, error.message);
                return c.json<AnalyticsLiveResponse>({
                    available: false,
                    date,
                    totals: { pv: 0, uv: 0 },
                    yesterday: { pv: 0, uv: 0 },
                    uvApproximate: true,
                    elapsedHours,
                });
            }
            throw error;
        }
    }, guard));

    // GET /analytics/visits?limit=100 — 唯一返回原始 IP 的路径。
    app.get("/visits", adminOnly(async (c) => {
        const limit = parseVisitLimit(c.req.query("limit"));

        try {
            const rows = await queryAnalyticsEngine<Record<string, unknown>>(
                c.env,
                buildVisitDetailSql(limit),
            );

            const items = rows.map<AnalyticsVisit>((row) => ({
                timestamp: normalizeAeTimestamp(String(row.timestamp ?? "")),
                feedId: Number(row.index1) || 0,
                title: String(row.blob7 ?? "") || null,
                path: String(row.blob1 ?? ""),
                referrer: String(row.blob2 ?? ""),
                country: String(row.blob3 ?? ""),
                city: String(row.blob4 ?? ""),
                device: String(row.blob5 ?? ""),
                visitor: String(row.blob6 ?? ""),
                // Task 1 之前写入的数据点没有 blob8，查出来是空字符串。
                ip: String(row.blob8 ?? ""),
            }));

            const response: AnalyticsVisitsResponse = {
                available: true,
                items,
                // 采样后列表不完整；UI 据此提示，避免流量涨上来后悄悄误导人。
                sampled: rows.some((row) => (Number(row._sample_interval) || 1) > 1),
            };

            return c.json(response);
        } catch (error) {
            if (error instanceof AnalyticsUnavailableError) {
                console.warn("analytics: visit detail unavailable", error.reason, error.message);
                return c.json<AnalyticsVisitsResponse>({ available: false, items: [], sampled: false });
            }
            throw error;
        }
    }, guard));

    return app;
}
