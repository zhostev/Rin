import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { eq } from "drizzle-orm";
import { createMockDB, createMockEnv, cleanupTestDB } from "../../../tests/fixtures";
import { analyticsDaily, analyticsDimDaily, visitStats } from "../../db/schema";
import {
    ANALYTICS_CURSOR_KEY,
    addDays,
    analyticsCrontab,
    analyticsWindowStart,
    buildDimensionRollupSql,
    buildFeedRollupSql,
    pendingRollupDates,
} from "../analytics-rollup";

describe("addDays", () => {
    it("advances a date in UTC", () => {
        expect(addDays("2026-09-20", 1)).toBe("2026-09-21");
    });

    it("crosses month and year boundaries", () => {
        expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
        expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    });

    it("goes backwards with a negative offset", () => {
        expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    });
});

describe("analyticsWindowStart", () => {
    it("is 90 days before today", () => {
        expect(analyticsWindowStart("2026-09-20")).toBe(addDays("2026-09-20", -90));
    });
});

describe("pendingRollupDates", () => {
    const today = "2026-09-20";
    const windowStart = analyticsWindowStart(today);

    it("returns nothing when the cursor is already at yesterday", () => {
        expect(pendingRollupDates("2026-09-19", today, windowStart)).toEqual([]);
    });

    it("never includes today, since the day is not over", () => {
        const dates = pendingRollupDates("2026-09-17", today, windowStart);
        expect(dates).toEqual(["2026-09-18", "2026-09-19"]);
        expect(dates).not.toContain(today);
    });

    it("starts at the window start when there is no cursor", () => {
        const dates = pendingRollupDates(null, today, windowStart);
        expect(dates[0]).toBe(addDays(windowStart, 1));
        expect(dates.at(-1)).toBe("2026-09-19");
    });

    it("clamps a cursor older than the analytics engine window", () => {
        const dates = pendingRollupDates("2020-01-01", today, windowStart);
        expect(dates[0]).toBe(addDays(windowStart, 1));
        expect(dates.length).toBeLessThanOrEqual(90);
    });

    it("returns nothing when the cursor is in the future", () => {
        expect(pendingRollupDates("2026-09-25", today, windowStart)).toEqual([]);
    });
});

describe("buildFeedRollupSql", () => {
    it("aggregates pv and distinct uv per feed for one day", () => {
        const sql = buildFeedRollupSql("2026-09-20");
        expect(sql).toContain("rin_analytics");
        expect(sql).toContain("index1");
        expect(sql).toContain("COUNT(DISTINCT blob6)");
        expect(sql).toContain("'2026-09-20'");
        expect(sql).toContain("GROUP BY");
    });

    it("rejects a malformed date instead of interpolating it", () => {
        expect(() => buildFeedRollupSql("2026-09-20'; DROP TABLE x--")).toThrow();
    });
});

describe("buildDimensionRollupSql", () => {
    it("unions the three dimensions for one day", () => {
        const sql = buildDimensionRollupSql("2026-09-20");
        expect(sql).toContain("blob2");
        expect(sql).toContain("blob3");
        expect(sql).toContain("blob5");
        expect(sql).toContain("'2026-09-20'");
    });

    it("rejects a malformed date", () => {
        expect(() => buildDimensionRollupSql("nope")).toThrow();
    });
});

describe("ANALYTICS_CURSOR_KEY", () => {
    it("matches the key documented in the spec", () => {
        expect(ANALYTICS_CURSOR_KEY).toBe("analytics.last_rollup");
    });
});

describe("analyticsCrontab (D1/cursor integration)", () => {
    const originalFetch = globalThis.fetch;
    let db: any;
    let sqlite: Database;
    let env: Env;

    beforeEach(() => {
        const mock = createMockDB();
        db = mock.db;
        sqlite = mock.sqlite;
        env = createMockEnv({
            CLOUDFLARE_ACCOUNT_ID: "acct-123",
            CLOUDFLARE_API_TOKEN: "token-abc",
        } as Partial<Env>);
        setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        setSystemTime();
        cleanupTestDB(sqlite);
    });

    function createTestServerConfig(initial: Record<string, unknown> = {}) {
        const store = new Map<string, unknown>(Object.entries(initial));
        return {
            async getOrDefault<T>(key: string, defaultValue: T): Promise<T> {
                return store.has(key) ? (store.get(key) as T) : defaultValue;
            },
            async set(key: string, value: unknown): Promise<void> {
                store.set(key, value);
            },
            store,
        };
    }

    /** Routes the feed-rollup SQL and the dimension-rollup SQL to different canned responses. */
    function stubAnalyticsFetch(rows: { feed?: unknown[]; dim?: unknown[] }, opts: { fail?: boolean } = {}) {
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            if (opts.fail) {
                return new Response("boom", { status: 500 });
            }
            const body = String(init?.body ?? "");
            if (body.includes("dim_type")) {
                return new Response(JSON.stringify({ data: rows.dim ?? [] }), { status: 200 });
            }
            return new Response(JSON.stringify({ data: rows.feed ?? [] }), { status: 200 });
        }) as unknown as typeof fetch;
    }

    function insertFeed(id: number) {
        sqlite.exec(
            `INSERT OR IGNORE INTO users (id, username, avatar, openid, permission) VALUES (1, 'tester', 'a.png', 'gh_1', 1)`,
        );
        sqlite.exec(
            `INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (${id}, 'Feed ${id}', 'content', 1, 0, 1)`,
        );
    }

    it("recomputes visit_stats from pv_baseline + aggregated pv, preserving pre-feature history", async () => {
        insertFeed(1);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (1, 0, 0, 100, 10, '')`,
        );

        const serverConfig = createTestServerConfig({ [ANALYTICS_CURSOR_KEY]: "2026-09-18" });
        stubAnalyticsFetch({ feed: [{ feed_id: "1", pv: 7, uv: 3 }], dim: [] });

        await analyticsCrontab(env, db, serverConfig);

        const stats = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));
        expect(stats).toHaveLength(1);
        // This must fail if the production code were changed to `pv = SUM(...)` (destroys baseline)
        // or to an increment (`pv = existing.pv + pv`, breaks idempotency).
        expect(stats[0].pv).toBe(107);
        expect(stats[0].uv).toBe(13);

        const daily = await db.select().from(analyticsDaily).where(eq(analyticsDaily.feedId, 1));
        expect(daily).toEqual([{ date: "2026-09-19", feedId: 1, pv: 7, uv: 3 }]);
    });

    it("is idempotent: re-rolling the same day leaves visit_stats and analytics_daily unchanged", async () => {
        insertFeed(1);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (1, 0, 0, 100, 10, '')`,
        );

        const serverConfig = createTestServerConfig({ [ANALYTICS_CURSOR_KEY]: "2026-09-18" });
        stubAnalyticsFetch({ feed: [{ feed_id: "1", pv: 7, uv: 3 }], dim: [] });

        await analyticsCrontab(env, db, serverConfig);
        const afterFirst = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));
        const dailyAfterFirst = await db.select().from(analyticsDaily).where(eq(analyticsDaily.feedId, 1));

        // Simulate a replay of the same day (e.g. cursor reset after a redeploy or manual retry).
        serverConfig.store.set(ANALYTICS_CURSOR_KEY, "2026-09-18");
        stubAnalyticsFetch({ feed: [{ feed_id: "1", pv: 7, uv: 3 }], dim: [] });

        await analyticsCrontab(env, db, serverConfig);
        const afterSecond = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));
        const dailyAfterSecond = await db.select().from(analyticsDaily).where(eq(analyticsDaily.feedId, 1));

        // This must fail if the recompute were changed to an increment (pv would double to 114).
        expect(afterSecond).toEqual(afterFirst);
        expect(dailyAfterSecond).toEqual(dailyAfterFirst);
        expect(afterSecond[0].pv).toBe(107);
    });

    it("advances the cursor past each successfully rolled-up date", async () => {
        const serverConfig = createTestServerConfig({ [ANALYTICS_CURSOR_KEY]: "2026-09-16" });
        stubAnalyticsFetch({ feed: [], dim: [] });

        await analyticsCrontab(env, db, serverConfig);

        expect(serverConfig.store.get(ANALYTICS_CURSOR_KEY)).toBe("2026-09-19");
    });

    it("does not advance the cursor when the Analytics Engine query fails", async () => {
        const serverConfig = createTestServerConfig({ [ANALYTICS_CURSOR_KEY]: "2026-09-18" });
        stubAnalyticsFetch({}, { fail: true });

        await analyticsCrontab(env, db, serverConfig);

        expect(serverConfig.store.get(ANALYTICS_CURSOR_KEY)).toBe("2026-09-18");
    });

    it("writes dimension rows into analytics_dim_daily with the right dim_type", async () => {
        const serverConfig = createTestServerConfig({ [ANALYTICS_CURSOR_KEY]: "2026-09-18" });
        stubAnalyticsFetch({
            feed: [],
            dim: [
                { dim_type: "referrer", dim_value: "example.com", count: 5 },
                { dim_type: "country", dim_value: "US", count: 9 },
                { dim_type: "device", dim_value: "desktop", count: 3 },
            ],
        });

        await analyticsCrontab(env, db, serverConfig);

        const rows = await db.select().from(analyticsDimDaily).where(eq(analyticsDimDaily.date, "2026-09-19"));
        const byType = Object.fromEntries(rows.map((row: typeof analyticsDimDaily.$inferSelect) => [row.dimType, row]));

        expect(rows).toHaveLength(3);
        expect(byType.referrer).toMatchObject({ dimValue: "example.com", count: 5 });
        expect(byType.country).toMatchObject({ dimValue: "US", count: 9 });
        expect(byType.device).toMatchObject({ dimValue: "desktop", count: 3 });
    });

    it("creates a visit_stats row with zero baselines for a feed with no prior row", async () => {
        insertFeed(2);

        const serverConfig = createTestServerConfig({ [ANALYTICS_CURSOR_KEY]: "2026-09-18" });
        stubAnalyticsFetch({ feed: [{ feed_id: "2", pv: 4, uv: 2 }], dim: [] });

        await analyticsCrontab(env, db, serverConfig);

        const stats = await db.select().from(visitStats).where(eq(visitStats.feedId, 2));
        expect(stats).toHaveLength(1);
        expect(stats[0].pvBaseline).toBe(0);
        expect(stats[0].uvBaseline).toBe(0);
        expect(stats[0].pv).toBe(4);
        expect(stats[0].uv).toBe(2);
    });
});
