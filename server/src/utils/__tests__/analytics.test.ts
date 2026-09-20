import { describe, expect, it } from "bun:test";
import {
    buildPageViewDataPoint,
    detectDevice,
    isBotUserAgent,
    normalizeReferrer,
    resolveDailySalt,
    utcDateString,
    visitorFingerprint,
} from "../analytics";

describe("isBotUserAgent", () => {
    it("detects common crawlers", () => {
        expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
        expect(isBotUserAgent("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(true);
        expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    });

    it("treats real browsers as non-bots", () => {
        expect(isBotUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120")).toBe(false);
    });

    it("treats an empty user agent as a bot", () => {
        expect(isBotUserAgent("")).toBe(true);
    });
});

describe("detectDevice", () => {
    it("classifies mobile user agents", () => {
        expect(detectDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148")).toBe("mobile");
        expect(detectDevice("Mozilla/5.0 (Linux; Android 14) Mobile Safari")).toBe("mobile");
    });

    it("defaults to desktop", () => {
        expect(detectDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120")).toBe("desktop");
    });
});

describe("normalizeReferrer", () => {
    it("keeps only the host", () => {
        expect(normalizeReferrer("https://www.google.com/search?q=rin", "blog.example.com")).toBe("www.google.com");
    });

    it("maps same-origin referrers to direct", () => {
        expect(normalizeReferrer("https://blog.example.com/feed/1", "blog.example.com")).toBe("direct");
    });

    it("maps missing or malformed referrers to direct", () => {
        expect(normalizeReferrer(null, "blog.example.com")).toBe("direct");
        expect(normalizeReferrer("", "blog.example.com")).toBe("direct");
        expect(normalizeReferrer("not a url", "blog.example.com")).toBe("direct");
    });
});

describe("utcDateString", () => {
    it("formats as UTC YYYY-MM-DD regardless of local offset", () => {
        expect(utcDateString(new Date("2026-09-20T23:59:59.000Z"))).toBe("2026-09-20");
        expect(utcDateString(new Date("2026-09-21T00:00:00.000Z"))).toBe("2026-09-21");
    });
});

describe("visitorFingerprint", () => {
    const base = { ip: "1.2.3.4", userAgent: "Chrome/120", feedId: 7 };

    it("is stable for the same input and salt", async () => {
        const a = await visitorFingerprint({ ...base, salt: "salt-a" });
        const b = await visitorFingerprint({ ...base, salt: "salt-a" });
        expect(a).toBe(b);
        expect(a).toHaveLength(16);
    });

    it("changes when the daily salt rotates", async () => {
        const day1 = await visitorFingerprint({ ...base, salt: "salt-a" });
        const day2 = await visitorFingerprint({ ...base, salt: "salt-b" });
        expect(day1).not.toBe(day2);
    });

    it("differs between visitors on the same day", async () => {
        const a = await visitorFingerprint({ ...base, salt: "salt-a" });
        const b = await visitorFingerprint({ ...base, ip: "5.6.7.8", salt: "salt-a" });
        expect(a).not.toBe(b);
    });

    it("does not contain the raw ip", async () => {
        const hash = await visitorFingerprint({ ...base, salt: "salt-a" });
        expect(hash).not.toContain("1.2.3.4");
    });
});

describe("resolveDailySalt", () => {
    function fakeConfig(initial: Record<string, unknown> = {}) {
        const store = new Map(Object.entries(initial));
        return {
            store,
            async getOrDefault<T>(key: string, defaultValue: T): Promise<T> {
                return (store.has(key) ? store.get(key) : defaultValue) as T;
            },
            async set(key: string, value: unknown) {
                store.set(key, value);
            },
        };
    }

    it("generates and persists a seed on first use", async () => {
        const config = fakeConfig();
        const salt = await resolveDailySalt(config, "2026-09-20");
        expect(salt.length).toBeGreaterThan(0);
        expect(config.store.get("analytics.salt_seed")).toBeTruthy();
    });

    it("derives different salts for different dates from one seed", async () => {
        const config = fakeConfig();
        const day1 = await resolveDailySalt(config, "2026-09-20");
        const seed = config.store.get("analytics.salt_seed");
        const day2 = await resolveDailySalt(config, "2026-09-21");
        expect(config.store.get("analytics.salt_seed")).toBe(seed);
        expect(day1).not.toBe(day2);
    });
});

describe("buildPageViewDataPoint", () => {
    const input = {
        feedId: 42,
        title: "Hello",
        path: "/feed/42",
        referrerHost: "www.google.com",
        country: "JP",
        city: "Tokyo",
        device: "mobile" as const,
        fingerprint: "abcdef0123456789",
    };

    it("uses feed id as the single index", () => {
        const point = buildPageViewDataPoint(input);
        expect(point.indexes).toEqual(["42"]);
        expect(point.indexes).toHaveLength(1);
    });

    it("places dimensions in the documented blob order", () => {
        const point = buildPageViewDataPoint(input);
        expect(point.blobs[0]).toBe("/feed/42");
        expect(point.blobs[1]).toBe("www.google.com");
        expect(point.blobs[2]).toBe("JP");
        expect(point.blobs[3]).toBe("Tokyo");
        expect(point.blobs[4]).toBe("mobile");
        expect(point.blobs[5]).toBe("abcdef0123456789");
        expect(point.blobs[6]).toBe("Hello");
    });

    it("counts one view", () => {
        expect(buildPageViewDataPoint(input).doubles).toEqual([1]);
    });

    it("keeps the index within the 96 byte limit", () => {
        const point = buildPageViewDataPoint({ ...input, feedId: Number.MAX_SAFE_INTEGER });
        expect(new TextEncoder().encode(point.indexes[0]).length).toBeLessThanOrEqual(96);
    });

    it("keeps total blob size within 16 KB", () => {
        const point = buildPageViewDataPoint({ ...input, title: "x".repeat(50_000) });
        const total = point.blobs.reduce((sum, b) => sum + new TextEncoder().encode(b).length, 0);
        expect(total).toBeLessThanOrEqual(16 * 1024);
    });

    it("tolerates a null title", () => {
        const point = buildPageViewDataPoint({ ...input, title: null });
        expect(point.blobs[6]).toBe("");
    });
});
