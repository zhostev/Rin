import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanupTestDB, createMockDB } from "../../../tests/fixtures";
import { visitStats } from "../../db/schema";
import { HyperLogLog } from "../../utils/hyperloglog";
import { ANALYTICS_UV_BACKFILL_KEY, backfillUvBaseline } from "../analytics-backfill";

describe("backfillUvBaseline", () => {
    let db: any;
    let sqlite: Database;

    beforeEach(() => {
        const mock = createMockDB();
        db = mock.db;
        sqlite = mock.sqlite;
        sqlite.exec(
            `INSERT INTO users (id, username, avatar, openid, permission) VALUES (1, 'tester', 'a.png', 'gh_1', 1)`,
        );
    });

    afterEach(() => {
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

    function insertFeed(id: number) {
        sqlite.exec(
            `INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES (${id}, 'Feed ${id}', 'content', 1, 0, 1)`,
        );
    }

    /** A serialized HLL holding `visitors` distinct values, as the old request-path code wrote it. */
    function serializedHll(visitors: number): { data: string; estimate: number } {
        const hll = new HyperLogLog();
        for (let i = 0; i < visitors; i++) {
            hll.add(`192.0.2.${i}|ua-${i}`);
        }
        const data = hll.serialize();
        return { data, estimate: Math.round(new HyperLogLog(data).count()) };
    }

    it("seeds uv_baseline from hll_data and recomputes uv", async () => {
        insertFeed(1);
        const { data, estimate } = serializedHll(40);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (1, 500, 0, 500, 0, '${data}')`,
        );
        sqlite.exec(`INSERT INTO analytics_daily (date, feed_id, pv, uv) VALUES ('2026-09-19', 1, 7, 3)`);

        const serverConfig = createTestServerConfig();
        const seeded = await backfillUvBaseline(db, serverConfig);

        expect(seeded).toBe(1);
        expect(estimate).toBeGreaterThan(0);

        const [row] = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));
        expect(row.uvBaseline).toBe(estimate);
        expect(row.uv).toBe(estimate + 3);
        expect(row.pv).toBe(507);
        // The module that produced the estimate stays in the tree as this backfill's input.
        expect(row.hllData).toBe(data);
        expect(serverConfig.store.get(ANALYTICS_UV_BACKFILL_KEY)).toBe(true);
    });

    it("is idempotent: a second run does not double uv", async () => {
        insertFeed(1);
        const { data } = serializedHll(25);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (1, 0, 0, 0, 0, '${data}')`,
        );
        sqlite.exec(`INSERT INTO analytics_daily (date, feed_id, pv, uv) VALUES ('2026-09-19', 1, 7, 3)`);

        const serverConfig = createTestServerConfig();
        await backfillUvBaseline(db, serverConfig);
        const [afterFirst] = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));

        await backfillUvBaseline(db, serverConfig);
        const [afterSecond] = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));

        expect(afterSecond.uvBaseline).toBe(afterFirst.uvBaseline);
        expect(afterSecond.uv).toBe(afterFirst.uv);
        expect(afterSecond.pv).toBe(afterFirst.pv);
    });

    it("stays idempotent even if the guard flag is lost", async () => {
        insertFeed(1);
        const { data } = serializedHll(25);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (1, 0, 0, 0, 0, '${data}')`,
        );

        const serverConfig = createTestServerConfig();
        await backfillUvBaseline(db, serverConfig);
        const [afterFirst] = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));

        serverConfig.store.delete(ANALYTICS_UV_BACKFILL_KEY);
        const seeded = await backfillUvBaseline(db, serverConfig);
        const [afterSecond] = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));

        expect(seeded).toBe(1);
        expect(afterSecond.uvBaseline).toBe(afterFirst.uvBaseline);
        expect(afterSecond.uv).toBe(afterFirst.uv);
    });

    it("skips rows with empty hll_data", async () => {
        insertFeed(1);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (1, 10, 0, 10, 0, '')`,
        );

        const serverConfig = createTestServerConfig();
        expect(await backfillUvBaseline(db, serverConfig)).toBe(0);

        const [row] = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));
        expect(row.uvBaseline).toBe(0);
        expect(row.uv).toBe(0);
    });

    it("sets the guard flag once it has actually seeded a row", async () => {
        insertFeed(1);
        const { data, estimate } = serializedHll(25);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (1, 80, 0, 80, 0, '${data}')`,
        );

        const serverConfig = createTestServerConfig();
        expect(await backfillUvBaseline(db, serverConfig)).toBe(1);
        expect(serverConfig.store.get(ANALYTICS_UV_BACKFILL_KEY)).toBe(true);

        const [row] = await db.select().from(visitStats).where(eq(visitStats.feedId, 1));
        expect(row.uvBaseline).toBe(estimate);
    });

    it("leaves the guard flag unset when there was nothing to seed, and retries later", async () => {
        // A brand-new site, or a deploy that lands before any hll_data exists:
        // zero rows seeded means "nothing to backfill yet", not "backfill done".
        insertFeed(1);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (1, 10, 0, 10, 0, '')`,
        );

        const serverConfig = createTestServerConfig();
        expect(await backfillUvBaseline(db, serverConfig)).toBe(0);
        // The flag must NOT be set — otherwise the backfill never happens again.
        expect(serverConfig.store.has(ANALYTICS_UV_BACKFILL_KEY)).toBe(false);

        // A later row arrives with real hll_data; the next cron tick must still pick it up.
        insertFeed(2);
        const { data, estimate } = serializedHll(12);
        sqlite.exec(
            `INSERT INTO visit_stats (feed_id, pv, uv, pv_baseline, uv_baseline, hll_data) VALUES (2, 0, 0, 0, 0, '${data}')`,
        );

        expect(await backfillUvBaseline(db, serverConfig)).toBe(1);
        expect(serverConfig.store.get(ANALYTICS_UV_BACKFILL_KEY)).toBe(true);

        const [seeded] = await db.select().from(visitStats).where(eq(visitStats.feedId, 2));
        expect(seeded.uvBaseline).toBe(estimate);

        // And now that it has run for real, it stops scanning.
        expect(await backfillUvBaseline(db, serverConfig)).toBe(0);
    });
});
