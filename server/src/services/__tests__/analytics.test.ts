import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import {
    AnalyticsService,
    buildLiveTotalsSql,
    buildLiveYesterdaySql,
    parseDays,
    parseDimensionType,
    parseLimit,
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

    const paths = ["/analytics/overview", "/analytics/top-feeds", "/analytics/dimensions", "/analytics/live"];

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
