import { describe, expect, it } from "bun:test";
import {
    ANALYTICS_CURSOR_KEY,
    addDays,
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
