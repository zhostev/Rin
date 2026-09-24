import { describe, it, expect } from "bun:test";
import { buildStoryChunks } from "../processors";

const story = { id: 7, slug: "hello", title: "标题", summary: "摘要" };

describe("buildStoryChunks", () => {
    it("builds deterministic chunk ids for header and blocks", () => {
        const chunks = buildStoryChunks(
            {
                story,
                blocks: [
                    { id: 11, payloadJson: JSON.stringify({ markdown: "正文一" }) },
                    { id: 12, payloadJson: JSON.stringify({ markdown: "正文二" }) },
                ],
                transcripts: [],
            },
            "/story/hello",
        );
        const ids = chunks.map((c) => c.id);
        expect(ids).toContain("s7h0");
        expect(ids).toContain("s7b11c0");
        expect(ids).toContain("s7b12c0");
        // 两次构造结果一致（删除路径与索引路径共用）
        const again = buildStoryChunks(
            {
                story,
                blocks: [
                    { id: 11, payloadJson: JSON.stringify({ markdown: "正文一" }) },
                    { id: 12, payloadJson: JSON.stringify({ markdown: "正文二" }) },
                ],
                transcripts: [],
            },
            "/story/hello",
        );
        expect(again.map((c) => c.id)).toEqual(ids);
    });

    it("includes transcript chunks keyed by asset id", () => {
        const chunks = buildStoryChunks(
            {
                story,
                blocks: [{ id: 11, payloadJson: JSON.stringify({ assetId: 42 }) }],
                transcripts: [{ assetId: 42, text: "转写文本内容" }],
            },
            "/story/hello",
        );
        const ids = chunks.map((c) => c.id);
        expect(ids).toContain("s7t42c0");
        expect(chunks.find((c) => c.id === "s7t42c0")!.kind).toBe("transcript");
    });

    it("ignores transcripts not referenced by blocks", () => {
        const chunks = buildStoryChunks(
            {
                story,
                blocks: [{ id: 11, payloadJson: JSON.stringify({ markdown: "正文" }) }],
                transcripts: [{ assetId: 99, text: "无人引用的转写" }],
            },
            "/story/hello",
        );
        expect(chunks.some((c) => c.kind === "transcript")).toBe(false);
    });
});
