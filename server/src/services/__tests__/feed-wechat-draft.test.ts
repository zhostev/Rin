import { describe, expect, it } from "bun:test";
import { normalizeRelayUrl, wechatTitleByteLength } from "../feed-wechat-draft";

describe("wechatTitleByteLength", () => {
    it("counts UTF-8 bytes, not chars", () => {
        expect(wechatTitleByteLength("hello")).toBe(5);
        expect(wechatTitleByteLength("标题")).toBe(6);
        expect(wechatTitleByteLength("中".repeat(21))).toBe(63);
        expect(wechatTitleByteLength("中".repeat(22))).toBe(66);
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

    it("treats empty or whitespace-only values as unconfigured", () => {
        expect(normalizeRelayUrl(undefined)).toBeUndefined();
        expect(normalizeRelayUrl("")).toBeUndefined();
        expect(normalizeRelayUrl("   \n ")).toBeUndefined();
    });

    it("keeps a clean URL untouched", () => {
        expect(normalizeRelayUrl("http://116.62.59.244:18080")).toBe("http://116.62.59.244:18080");
    });
});
