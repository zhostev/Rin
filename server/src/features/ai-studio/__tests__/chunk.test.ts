import { describe, it, expect } from "bun:test";
import {
    chunkText,
    extractAssetIds,
    extractBlockText,
    extractUrls,
} from "../chunk";

describe("extractBlockText", () => {
    it("extracts markdown payloads", () => {
        expect(extractBlockText(JSON.stringify({ markdown: "# 标题\n正文" }))).toBe("# 标题\n正文");
    });

    it("prefers known text keys and dedupes", () => {
        const text = extractBlockText(JSON.stringify({ markdown: "你好", text: "你好" }));
        expect(text).toBe("你好");
    });

    it("handles non-JSON input as plain text", () => {
        expect(extractBlockText("纯文本")).toBe("纯文本");
    });

    it("returns empty string for empty/invalid input", () => {
        expect(extractBlockText("")).toBe("");
        expect(extractBlockText(null)).toBe("");
        expect(extractBlockText(JSON.stringify({ assetId: 3 }))).toBe("");
    });
});

describe("extractAssetIds", () => {
    it("collects assetId references", () => {
        const ids = extractAssetIds(JSON.stringify({ assetId: 7, caption: "图" }));
        expect(ids).toEqual([7]);
    });

    it("collects nested asset ids", () => {
        const ids = extractAssetIds(JSON.stringify({ gallery: [{ asset_id: 1 }, { asset_id: 2 }] }));
        expect(ids.sort()).toEqual([1, 2]);
    });

    it("returns empty for text blocks", () => {
        expect(extractAssetIds(JSON.stringify({ markdown: "hi" }))).toEqual([]);
    });
});

describe("extractUrls", () => {
    it("extracts http(s) urls and strips trailing punctuation", () => {
        const urls = extractUrls("看这里 https://example.com/a， 还有 http://x.io/b。");
        expect(urls).toEqual(["https://example.com/a", "http://x.io/b"]);
    });

    it("dedupes", () => {
        expect(extractUrls("https://a.com https://a.com")).toEqual(["https://a.com"]);
    });
});

describe("chunkText", () => {
    it("returns a single chunk for short text", () => {
        const chunks = chunkText("你好世界");
        expect(chunks).toEqual([{ text: "你好世界", chunkIndex: 0 }]);
    });

    it("splits long text at sentence boundaries", () => {
        const text = "第一句。第二句！第三句？第四句。".repeat(60);
        const chunks = chunkText(text, 100, 10);
        expect(chunks.length).toBeGreaterThan(1);
        // 每个块都不应超过 size 太多（断句只向前找）
        for (const c of chunks) {
            expect(c.text.length).toBeLessThanOrEqual(100);
        }
        // 块索引连续
        expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    });

    it("returns empty for blank text", () => {
        expect(chunkText("   ")).toEqual([]);
    });
});
