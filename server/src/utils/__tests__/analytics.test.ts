import { describe, expect, it } from "bun:test";
import type { AppContext } from "../../core/hono-types";
import {
    buildPageViewDataPoint,
    detectDevice,
    isBotUserAgent,
    normalizeReferrer,
    recordPageView,
    resolveDailySalt,
    truncateToBytes,
    utcDateString,
    visitorFingerprint,
} from "../analytics";
import type { PageViewDataPoint } from "../analytics";

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
        ip: "203.0.113.7",
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

    it("puts the raw ip in blob8", () => {
        expect(buildPageViewDataPoint(input).blobs[7]).toBe("203.0.113.7");
    });

    it("handles an IPv6 address without truncating it", () => {
        const v6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
        expect(buildPageViewDataPoint({ ...input, ip: v6 }).blobs[7]).toBe(v6);
    });

    it("tolerates a missing ip", () => {
        expect(buildPageViewDataPoint({ ...input, ip: "" }).blobs[7]).toBe("");
    });

    // 位置锁：rollup 与 /live 的 SQL 按下标读 blob2/3/5/6，
    // 任何位移都不会报错，只会静默产出错误数字。
    it("keeps blob1..blob7 at their contracted positions", () => {
        const point = buildPageViewDataPoint(input);
        expect(point.blobs.slice(0, 7)).toEqual([
            "/feed/42",
            "www.google.com",
            "JP",
            "Tokyo",
            "mobile",
            "abcdef0123456789",
            "Hello",
        ]);
        expect(point.blobs).toHaveLength(8);
        expect(point.indexes).toEqual(["42"]);
        expect(point.doubles).toEqual([1]);
    });
});

describe("recordPageView", () => {
    function fakeAnalyticsDataset(options: { throwOnWrite?: boolean } = {}) {
        const points: PageViewDataPoint[] = [];
        return {
            points,
            writeDataPoint(point: PageViewDataPoint) {
                if (options.throwOnWrite) {
                    throw new Error("writeDataPoint boom");
                }
                points.push(point);
            },
        };
    }

    function fakeServerConfig() {
        const store = new Map<string, unknown>();
        return {
            async getOrDefault<T>(key: string, defaultValue: T): Promise<T> {
                return (store.has(key) ? store.get(key) : defaultValue) as T;
            },
            async set(key: string, value: unknown) {
                store.set(key, value);
            },
        };
    }

    function fakeContext(options: {
        analytics?: ReturnType<typeof fakeAnalyticsDataset>;
        userAgent?: string;
        url?: string;
        headers?: Record<string, string>;
    }): AppContext {
        const userAgent = options.userAgent ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120";
        const url = options.url ?? "https://blog.example.com/feed/42";
        const headers = options.headers;

        const req = {
            header(name: string) {
                return name.toLowerCase() === "user-agent" ? userAgent : undefined;
            },
            raw: {
                headers: {
                    get: (name: string) => {
                        if (!headers) return null;
                        const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
                        return key ? headers[key] : null;
                    },
                },
                cf: {},
            },
            url,
        };

        const context = {
            env: { ANALYTICS: options.analytics },
            req,
            get(key: string) {
                return key === "serverConfig" ? fakeServerConfig() : undefined;
            },
        };

        return context as unknown as AppContext;
    }

    it("writes exactly one data point for a normal request", async () => {
        const dataset = fakeAnalyticsDataset();
        const c = fakeContext({ analytics: dataset });

        await recordPageView(c, { feedId: 42, title: "Hello" });

        expect(dataset.points).toHaveLength(1);
        expect(dataset.points[0].indexes[0]).toBe("42");
        expect(dataset.points[0].blobs[6]).toBe("Hello");
    });

    it("records the client ip in blob8", async () => {
        const dataset = fakeAnalyticsDataset();
        const c = fakeContext({ analytics: dataset, headers: { "cf-connecting-ip": "198.51.100.9" } });

        await recordPageView(c, { feedId: 42, title: "Hello" });

        expect(dataset.points[0].blobs[7]).toBe("198.51.100.9");
    });

    it("writes nothing for a bot user agent", async () => {
        const dataset = fakeAnalyticsDataset();
        const c = fakeContext({ analytics: dataset, userAgent: "curl/8.4.0" });

        await recordPageView(c, { feedId: 42, title: "Hello" });

        expect(dataset.points).toHaveLength(0);
    });

    it("writes nothing and does not throw when the ANALYTICS binding is missing", async () => {
        const c = fakeContext({ analytics: undefined });

        await expect(recordPageView(c, { feedId: 42, title: "Hello" })).resolves.toBeUndefined();
    });

    it("does not propagate an error thrown while writing the data point", async () => {
        const dataset = fakeAnalyticsDataset({ throwOnWrite: true });
        const c = fakeContext({ analytics: dataset });

        await expect(recordPageView(c, { feedId: 42, title: "Hello" })).resolves.toBeUndefined();
    });
});

describe("truncateToBytes", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });

    function byteLength(value: string) {
        return encoder.encode(value).length;
    }

    /** Re-decoding with fatal:true throws if truncation produced invalid UTF-8. */
    function isValidUtf8(value: string) {
        try {
            decoder.decode(encoder.encode(value));
            return true;
        } catch {
            return false;
        }
    }

    it("returns the input untouched when it already fits", () => {
        expect(truncateToBytes("hello", 256)).toBe("hello");
        expect(truncateToBytes("", 256)).toBe("");
    });

    it("truncates pure ASCII at the byte budget", () => {
        expect(truncateToBytes("abcdefghij", 4)).toBe("abcd");
        expect(byteLength(truncateToBytes("abcdefghij", 4))).toBe(4);
    });

    it("keeps whole 3-byte CJK characters", () => {
        // 你好世界 is 4 chars / 12 bytes.
        expect(truncateToBytes("你好世界", 12)).toBe("你好世界");
        expect(truncateToBytes("你好世界", 11)).toBe("你好世");
        expect(truncateToBytes("你好世界", 6)).toBe("你好");
        expect(byteLength(truncateToBytes("你好世界", 11))).toBeLessThanOrEqual(11);
    });

    it("never splits a 4-byte emoji surrogate pair", () => {
        // Each emoji is one code point, two UTF-16 units, four UTF-8 bytes.
        expect(truncateToBytes("😀😀😀", 12)).toBe("😀😀😀");
        expect(truncateToBytes("😀😀😀", 11)).toBe("😀😀");
        expect(truncateToBytes("😀😀😀", 7)).toBe("😀");
        for (const limit of [1, 2, 3, 4, 5, 6, 7, 8, 11, 12]) {
            const result = truncateToBytes("😀😀😀", limit);
            expect(byteLength(result)).toBeLessThanOrEqual(limit);
            expect(isValidUtf8(result)).toBe(true);
            // A split surrogate would survive as a lone half.
            expect(result.length % 2).toBe(0);
        }
    });

    it("handles a budget exactly equal to the input", () => {
        expect(truncateToBytes("abcd", 4)).toBe("abcd");
        expect(truncateToBytes("你", 3)).toBe("你");
        expect(truncateToBytes("😀", 4)).toBe("😀");
    });

    it("returns empty when the budget is smaller than the first character", () => {
        expect(truncateToBytes("你好", 2)).toBe("");
        expect(truncateToBytes("😀", 3)).toBe("");
        expect(truncateToBytes("abc", 0)).toBe("");
        expect(truncateToBytes("abc", -1)).toBe("");
    });

    it("handles mixed-width input", () => {
        const mixed = "a你😀b";
        expect(byteLength(mixed)).toBe(9);
        expect(truncateToBytes(mixed, 9)).toBe(mixed);
        expect(truncateToBytes(mixed, 8)).toBe("a你😀");
        expect(truncateToBytes(mixed, 7)).toBe("a你");
        // 4 bytes is exactly "a" + "你"; "a" alone needs the budget to stop at 3.
        expect(truncateToBytes(mixed, 4)).toBe("a你");
        expect(truncateToBytes(mixed, 3)).toBe("a");
    });

    it("stays within budget for every prefix of a long mixed string", () => {
        const long = "国際化テスト😀".repeat(80);
        for (let limit = 0; limit <= 64; limit++) {
            const result = truncateToBytes(long, limit);
            expect(byteLength(result)).toBeLessThanOrEqual(limit);
            expect(isValidUtf8(result)).toBe(true);
            expect(long.startsWith(result)).toBe(true);
        }
    });
});
