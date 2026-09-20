import type {
    AnalyticsDimensionItem,
    AnalyticsDimensionType,
    AnalyticsDimensionsResponse,
    AnalyticsLiveResponse,
    AnalyticsOverview,
    AnalyticsTopFeed,
    AnalyticsTopFeedsResponse,
} from "@rin/api";
import { and, desc, eq, gte, sql } from "drizzle-orm";
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
const SUPPORTED_HOURS = [1, 24] as const;
const DIMENSION_TYPES: AnalyticsDimensionType[] = ["referrer", "country", "device"];

const guard = { status: 403, format: "json" } as const;

export function parseDays(value: string | undefined): 7 | 30 | 90 {
    const parsed = Number.parseInt(value ?? "", 10);
    return (SUPPORTED_DAYS as readonly number[]).includes(parsed) ? (parsed as 7 | 30 | 90) : 30;
}

export function parseHours(value: string | undefined): 1 | 24 {
    const parsed = Number.parseInt(value ?? "", 10);
    return (SUPPORTED_HOURS as readonly number[]).includes(parsed) ? (parsed as 1 | 24) : 24;
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

        const series = rows.map((row) => ({
            date: row.date,
            pv: Number(row.pv) || 0,
            uv: Number(row.uv) || 0,
        }));

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

    // GET /analytics/live?hours=24 — the only endpoint that reaches Analytics Engine.
    app.get("/live", adminOnly(async (c) => {
        const hours = parseHours(c.req.query("hours"));

        try {
            const rows = await queryAnalyticsEngine<{ feed_id: string; title: string; pv: number; uv: number }>(
                c.env,
                `
                    SELECT index1 AS feed_id,
                           any(blob7) AS title,
                           SUM(_sample_interval) AS pv,
                           COUNT(DISTINCT blob6) AS uv
                    FROM ${ANALYTICS_DATASET}
                    WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
                    GROUP BY index1
                    ORDER BY pv DESC
                    LIMIT 20
                    FORMAT JSON
                `.trim(),
            );

            const response: AnalyticsLiveResponse = {
                available: true,
                hours,
                items: rows.map<AnalyticsTopFeed>((row) => ({
                    feedId: Number(row.feed_id),
                    title: row.title || null,
                    pv: Number(row.pv) || 0,
                    uv: Number(row.uv) || 0,
                })),
            };

            return c.json(response);
        } catch (error) {
            if (error instanceof AnalyticsUnavailableError) {
                // 未配置 token 或 token 缺少 Account Analytics Read 权限 → 降级，不是 500。
                console.warn("analytics: live query unavailable", error.reason, error.message);
                return c.json<AnalyticsLiveResponse>({ available: false, hours, items: [] });
            }
            throw error;
        }
    }, guard));

    return app;
}
