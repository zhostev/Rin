import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AnalyticsVisitsResponse } from "@rin/api";
import { createMockEnv } from "../../../tests/fixtures";
import type { Variables } from "../../core/hono-types";
import {
    AnalyticsService,
    buildLiveTotalsSql,
    buildLiveYesterdaySql,
    buildVisitDetailSql,
    normalizeAeTimestamp,
    parseDays,
    parseDimensionType,
    parseLimit,
    parseVisitLimit,
    previousWindow,
    zeroFillSeries,
} from "../analytics";

describe("parseDays", () => {
    it("accepts only the three supported ranges", () => {
        expect(parseDays("7")).toBe(7);
        expect(parseDays("30")).toBe(30);
        expect(parseDays("90")).toBe(90);
    });

    it("falls back to 30 for anything else", () => {
        expect(parseDays(undefined)).toBe(30);
        expect(parseDays("")).toBe(30);
        expect(parseDays("365")).toBe(30);
        expect(parseDays("-1")).toBe(30);
        expect(parseDays("abc")).toBe(30);
    });
});

describe("parseLimit", () => {
    it("defaults to 20", () => {
        expect(parseLimit(undefined)).toBe(20);
    });

    it("caps at 100", () => {
        expect(parseLimit("5000")).toBe(100);
    });

    it("rejects non-positive values", () => {
        expect(parseLimit("0")).toBe(20);
        expect(parseLimit("-3")).toBe(20);
    });
});

describe("parseDimensionType", () => {
    it("accepts the three known dimensions", () => {
        expect(parseDimensionType("referrer")).toBe("referrer");
        expect(parseDimensionType("country")).toBe("country");
        expect(parseDimensionType("device")).toBe("device");
    });

    it("falls back to referrer", () => {
        expect(parseDimensionType("browser")).toBe("referrer");
        expect(parseDimensionType(undefined)).toBe("referrer");
    });
});

describe("zeroFillSeries", () => {
    it("fills every day of the range, so the chart cannot imply traffic on silent days", () => {
        const series = zeroFillSeries(
            [
                { date: "2026-09-01", pv: 10, uv: 4 },
                { date: "2026-09-05", pv: 3, uv: 1 },
            ],
            "2026-09-01",
            5,
        );

        expect(series).toEqual([
            { date: "2026-09-01", pv: 10, uv: 4 },
            { date: "2026-09-02", pv: 0, uv: 0 },
            { date: "2026-09-03", pv: 0, uv: 0 },
            { date: "2026-09-04", pv: 0, uv: 0 },
            { date: "2026-09-05", pv: 3, uv: 1 },
        ]);
    });

    it("returns one point per requested day even with no data at all", () => {
        const series = zeroFillSeries([], "2026-09-01", 7);
        expect(series).toHaveLength(7);
        expect(series.every((point) => point.pv === 0 && point.uv === 0)).toBe(true);
        expect(series.at(-1)?.date).toBe("2026-09-07");
    });
});

describe("AnalyticsService admin guard", () => {
    // 挂载真实的 AnalyticsService，确保测的是本服务的接线，
    // 而不是 adminOnly 本身（那已由 core/route-boundaries.test.ts 覆盖）。
    function mount(admin: boolean) {
        const app = new Hono<{ Bindings: Env; Variables: Variables }>();
        app.use("*", async (c, next) => {
            c.set("admin", admin);
            await next();
        });
        app.route("/analytics", AnalyticsService());
        return app;
    }

    const paths = [
        "/analytics/overview",
        "/analytics/top-feeds",
        "/analytics/dimensions",
        "/analytics/live",
        "/analytics/visits",
    ];

    it("rejects every endpoint for non-admins with 403", async () => {
        const app = mount(false);
        for (const path of paths) {
            const response = await app.request(path);
            expect(response.status).toBe(403);
        }
    });

    it("does not reject admins at the guard", async () => {
        // 没有挂 db，处理器会在访问 db 时抛错——但那说明请求已通过守卫。
        // 这里只断言「不是 403」。
        const app = mount(true);
        const response = await Promise.resolve(app.request("/analytics/overview")).catch(() => null);
        expect(response?.status).not.toBe(403);
    });

    it("never leaks an ip to a non-admin", async () => {
        const app = mount(false);
        const response = await app.request("/analytics/visits");
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(body).not.toContain("ip");
    });
});

describe("AnalyticsService IP exposure (admin routes)", () => {
    // 上面「never leaks an ip to a non-admin」测的是 403 守卫拦截，guard body 本身
    // 就是 `{"error":"Unauthorized"}`，不可能包含 ip —— 断言恒真，测不出「/visits
    // 真的把 ip 吐出来」这件事。这里补一个正向用例：真正挂路由、真正跑一遍
    // queryAnalyticsEngine，断言 /visits 对 admin 吐出 ip，而 /live 不吐。
    const originalFetch = globalThis.fetch;
    let env: Env;

    beforeEach(() => {
        env = createMockEnv({
            CLOUDFLARE_ACCOUNT_ID: "acct-123",
            CLOUDFLARE_API_TOKEN: "token-abc",
        } as Partial<Env>);
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function mountAdmin() {
        const app = new Hono<{ Bindings: Env; Variables: Variables }>();
        app.use("*", async (c, next) => {
            c.set("admin", true);
            await next();
        });
        app.route("/analytics", AnalyticsService());
        return app;
    }

    /** One raw AE row for a single visit, with a real client IP in blob8. */
    function stubAnalyticsFetchWithOneVisit(ip: string) {
        globalThis.fetch = (async () => {
            const row = {
                timestamp: "2026-09-21 02:31:07",
                index1: "1",
                blob1: "/feed/1",
                blob2: "https://example.com/",
                blob3: "US",
                blob4: "New York",
                blob5: "desktop",
                blob6: "visitor-hash",
                blob7: "Feed Title",
                blob8: ip,
                _sample_interval: 1,
            };
            return new Response(JSON.stringify({ data: [row] }), { status: 200 });
        }) as unknown as typeof fetch;
    }

    it("returns the raw ip to an admin on /analytics/visits", async () => {
        stubAnalyticsFetchWithOneVisit("203.0.113.7");
        const app = mountAdmin();

        const response = await app.request("/analytics/visits", { method: "GET" }, env);

        expect(response.status).toBe(200);
        const body = (await response.json()) as AnalyticsVisitsResponse;
        expect(body.available).toBe(true);
        expect(body.items[0].ip).toBe("203.0.113.7");
    });

    it("does not include an ip field anywhere in the /analytics/live response for an admin", async () => {
        stubAnalyticsFetchWithOneVisit("203.0.113.7");
        const app = mountAdmin();

        const response = await app.request("/analytics/live", { method: "GET" }, env);

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("203.0.113.7");
        expect(text).not.toContain('"ip"');
    });
});

describe("live totals SQL", () => {
    it("aggregates the whole site for the current UTC day — no per-feed grouping, no row limit", () => {
        const text = buildLiveTotalsSql("ds");
        expect(text).toContain("toDate(timestamp) = toDate(now())");
        expect(text).toContain("COUNT(DISTINCT blob6)");
        expect(text).not.toContain("GROUP BY");
        expect(text).not.toContain("LIMIT");
        expect(text).not.toContain("index1");
    });

    it("cuts yesterday off at the same elapsed hour so the comparison windows match", () => {
        const text = buildLiveYesterdaySql("ds");
        expect(text).toContain("toDate(now() - INTERVAL '1' DAY)");
        expect(text).toContain("toHour(timestamp) <= toHour(now())");
        expect(text).not.toContain("GROUP BY");
    });
});

describe("previousWindow", () => {
    it("is contiguous with the current range and never overlaps it", () => {
        const { from, to } = previousWindow("2026-08-22", 30);
        expect(to).toBe("2026-08-21");
        expect(from).toBe("2026-07-24");
    });

    it("matches the number of COMPLETE days in the current range, not `days`", () => {
        // days=30 starting 2026-08-22 covers through today 2026-09-20, but today is
        // never aggregated, so only 29 days carry data. previous must be 29 too.
        const { from, to } = previousWindow("2026-08-22", 30);
        const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
        expect(span).toBe(29);
    });

    it("spans 6 days for a 7-day range", () => {
        const { from, to } = previousWindow("2026-09-14", 7);
        expect(to).toBe("2026-09-13");
        expect(from).toBe("2026-09-08");
        const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
        expect(span).toBe(6);
    });

    it("spans 89 days for a 90-day range", () => {
        const { from, to } = previousWindow("2026-06-23", 90);
        const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
        expect(span).toBe(89);
        expect(to).toBe("2026-06-22");
    });

    it("crosses a month boundary", () => {
        expect(previousWindow("2026-03-01", 7)).toEqual({ from: "2026-02-23", to: "2026-02-28" });
    });

    it("crosses a leap-day boundary", () => {
        // 2028 is a leap year, so February has 29 days.
        expect(previousWindow("2028-03-01", 7)).toEqual({ from: "2028-02-24", to: "2028-02-29" });
    });

    it("crosses a year boundary", () => {
        expect(previousWindow("2026-01-03", 7)).toEqual({ from: "2025-12-28", to: "2026-01-02" });
    });

    it("never returns an empty window", () => {
        const { from, to } = previousWindow("2026-09-20", 1);
        expect(from).toBe("2026-09-19");
        expect(to).toBe("2026-09-19");
    });
});

describe("parseVisitLimit", () => {
    it("defaults to 100", () => {
        expect(parseVisitLimit(undefined)).toBe(100);
        expect(parseVisitLimit("")).toBe(100);
        expect(parseVisitLimit("abc")).toBe(100);
    });

    it("caps at 500", () => {
        expect(parseVisitLimit("5000")).toBe(500);
        expect(parseVisitLimit("501")).toBe(500);
    });

    it("rejects non-positive values", () => {
        expect(parseVisitLimit("0")).toBe(100);
        expect(parseVisitLimit("-7")).toBe(100);
    });

    it("accepts a value inside the range", () => {
        expect(parseVisitLimit("250")).toBe(250);
    });

    // /top-feeds 的 parseLimit 是默认 20 / 上限 100，两者不可混用。
    it("is not the same bounds as parseLimit", () => {
        expect(parseVisitLimit(undefined)).not.toBe(parseLimit(undefined));
    });
});

describe("normalizeAeTimestamp", () => {
    it("converts a space-separated AE timestamp to ISO, treating it as UTC", () => {
        expect(normalizeAeTimestamp("2026-09-21 02:31:07")).toBe("2026-09-21T02:31:07.000Z");
    });

    it("passes an already-ISO timestamp through unchanged in value", () => {
        expect(normalizeAeTimestamp("2026-09-21T02:31:07Z")).toBe("2026-09-21T02:31:07.000Z");
    });

    it("returns an empty string for unparseable input", () => {
        expect(normalizeAeTimestamp("")).toBe("");
        expect(normalizeAeTimestamp("not a date")).toBe("");
    });
});

describe("buildVisitDetailSql", () => {
    it("selects every blob including blob8 and the sample interval", () => {
        const sql = buildVisitDetailSql(100);
        for (const column of ["timestamp", "index1", "blob1", "blob6", "blob7", "blob8", "_sample_interval"]) {
            expect(sql).toContain(column);
        }
        expect(sql).toContain("rin_analytics");
    });

    it("orders newest first and applies the limit", () => {
        const sql = buildVisitDetailSql(250);
        expect(sql).toContain("ORDER BY timestamp DESC");
        expect(sql).toContain("LIMIT 250");
    });

    it("does not group or aggregate — it is a raw row listing", () => {
        const sql = buildVisitDetailSql(100);
        expect(sql).not.toContain("GROUP BY");
        expect(sql).not.toContain("SUM(");
    });

    it("refuses a non-integer limit instead of interpolating it", () => {
        expect(() => buildVisitDetailSql(Number.NaN)).toThrow();
        expect(() => buildVisitDetailSql(1.5)).toThrow();
        expect(() => buildVisitDetailSql(-1)).toThrow();
        expect(() => buildVisitDetailSql("100; DROP TABLE x--" as unknown as number)).toThrow();
    });
});
