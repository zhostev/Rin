import { describe, expect, it } from "bun:test";
import { normalizeRelayUrl, stripInvisibleChars, wechatTitleByteLength } from "../feed-wechat-draft";

describe("wechatTitleByteLength", () => {
    it("counts UTF-8 bytes, not chars", () => {
        expect(wechatTitleByteLength("hello")).toBe(5);
        expect(wechatTitleByteLength("标题")).toBe(6);
        expect(wechatTitleByteLength("中".repeat(21))).toBe(63);
        expect(wechatTitleByteLength("中".repeat(22))).toBe(66);
    });
});

describe("stripInvisibleChars", () => {
    it("removes zero-width chars that trim() cannot (iOS paste from web pages)", () => {
        // U+200B zero-width space: survives trim(), breaks new URL() with "Invalid URL".
        expect(stripInvisibleChars("http://116.62.59.244:18080\u200B")).toBe("http://116.62.59.244:18080");
        expect(stripInvisibleChars("http://116.62.59.\u200B244:18080")).toBe("http://116.62.59.244:18080");
        expect(stripInvisibleChars("Bearer\u00A0abc")).toBe("Bearerabc");
    });

    it("removes other format characters (ZWJ/ZWNJ/word joiner/soft hyphen)", () => {
        expect(stripInvisibleChars("a\u200Cb\u200Dc\u2060d\u00ADe")).toBe("abcde");
    });

    it("removes ordinary whitespace anywhere in the string", () => {
        expect(stripInvisibleChars("  http://x:1\u00A0\n")).toBe("http://x:1");
    });

    it("leaves clean strings untouched", () => {
        expect(stripInvisibleChars("http://116.62.59.244:18080")).toBe("http://116.62.59.244:18080");
        expect(stripInvisibleChars("")).toBe("");
    });
});

describe("normalizeRelayUrl", () => {
    it("trims surrounding whitespace that breaks fetch with Invalid URL", () => {
        expect(normalizeRelayUrl("http://116.62.59.244:18080 ")).toBe("http://116.62.59.244:18080");
        expect(normalizeRelayUrl("  http://116.62.59.244:18080\n")).toBe("http://116.62.59.244:18080");
        expect(normalizeRelayUrl("\thttp://116.62.59.244:18080/\n")).toBe("http://116.62.59.244:18080");
    });

    it("strips trailing slashes", () => {
        expect(normalizeRelayUrl("http://116.62.59.244:18080///")).toBe("http://116.62.59.244:18080");
    });

    it("strips zero-width chars that trim() cannot (iOS paste from web pages)", () => {
        expect(normalizeRelayUrl("http://116.62.59.244:18080\u200B/")).toBe("http://116.62.59.244:18080");
        expect(normalizeRelayUrl("http://116.62.59.\u200B244:18080")).toBe("http://116.62.59.244:18080");
    });

    it("treats empty or whitespace-only values as unconfigured", () => {
        expect(normalizeRelayUrl(undefined)).toBeUndefined();
        expect(normalizeRelayUrl("")).toBeUndefined();
        expect(normalizeRelayUrl("   \n ")).toBeUndefined();
    });

    it("keeps a clean URL untouched", () => {
        expect(normalizeRelayUrl("http://116.62.59.244:18080")).toBe("http://116.62.59.244:18080");
    });
});
