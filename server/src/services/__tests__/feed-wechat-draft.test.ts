import { describe, expect, it } from "bun:test";
import { wechatTitleByteLength } from "../feed-wechat-draft";

describe("wechatTitleByteLength", () => {
    it("counts UTF-8 bytes, not chars", () => {
        expect(wechatTitleByteLength("hello")).toBe(5);
        expect(wechatTitleByteLength("标题")).toBe(6);
        expect(wechatTitleByteLength("中".repeat(21))).toBe(63);
        expect(wechatTitleByteLength("中".repeat(22))).toBe(66);
    });
});
