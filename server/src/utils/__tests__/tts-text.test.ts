import { describe, expect, it } from "bun:test";
import { chunkSpeechText, markdownToSpeechText } from "../tts-text";

describe("markdownToSpeechText", () => {
    it("removes images entirely", () => {
        const out = markdownToSpeechText("看这张图\n\n![东京塔](https://x/y.jpg)\n\n很美");
        expect(out).not.toContain("东京塔");
        expect(out).not.toContain("https://x/y.jpg");
        expect(out).toContain("看这张图");
        expect(out).toContain("很美");
    });

    it("keeps link text but drops urls", () => {
        const out = markdownToSpeechText("参考[官方文档](https://example.com/a?b=1)写成");
        expect(out).toContain("官方文档");
        expect(out).not.toContain("example.com");
    });

    it("removes fenced code blocks", () => {
        const out = markdownToSpeechText("前面\n\n```ts\nconst a = 1;\n# 不是标题\n```\n\n后面");
        expect(out).toContain("前面");
        expect(out).toContain("后面");
        expect(out).not.toContain("const a");
        expect(out).not.toContain("不是标题");
    });

    it("removes [[media:N]] placeholders", () => {
        const out = markdownToSpeechText("第一段[[media:1]]第二段[[media:23]]");
        expect(out).not.toContain("[[media:");
        expect(out).toContain("第一段");
    });

    it("turns headings into pauses", () => {
        const out = markdownToSpeechText("# 大标题\n\n正文\n\n## 小标题");
        expect(out).toContain("大标题。");
        expect(out).toContain("小标题。");
    });

    it("flattens table rows and drops separator rows", () => {
        const out = markdownToSpeechText("| 名称 | 价格 |\n|---|---|\n| 苹果 | 5 元 |");
        expect(out).not.toContain("---");
        expect(out).not.toContain("|");
        expect(out).toContain("名称，价格");
        expect(out).toContain("苹果，5 元");
    });

    it("strips list markers and blockquotes", () => {
        const out = markdownToSpeechText("- 第一项\n* 第二项\n1. 第三项\n> 引用文字");
        expect(out).toContain("第一项");
        expect(out).toContain("引用文字");
        expect(out).not.toMatch(/^- /m);
    });

    it("strips inline code and emphasis markers", () => {
        const out = markdownToSpeechText("用 `bun test` 跑**加粗**和*斜体*");
        expect(out).toContain("bun test");
        expect(out).toContain("加粗");
        expect(out).not.toContain("`");
        expect(out).not.toContain("**");
    });

    it("collapses blank lines and trims", () => {
        const out = markdownToSpeechText("\n\n第一段\n\n\n\n第二段\n\n");
        expect(out).toBe("第一段\n第二段");
    });

    it("returns empty for empty input", () => {
        expect(markdownToSpeechText("")).toBe("");
        expect(markdownToSpeechText("   \n  ")).toBe("");
    });
});

describe("chunkSpeechText", () => {
    it("returns empty for blank input", () => {
        expect(chunkSpeechText("  \n ")).toEqual([]);
    });

    it("packs short paragraphs into maxChars chunks", () => {
        const chunks = chunkSpeechText("第一段\n第二段\n第三段", 10);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
        expect(chunks.join("")).toContain("第一段");
    });

    it("splits oversized paragraphs at sentence boundaries", () => {
        const p = "第一句。第二句！第三句？第四句；第X句。";
        const chunks = chunkSpeechText(p, 8);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8);
        // 句子不在中间被切断
        expect(chunks[0]).toMatch(/[。！？；]$/);
    });

    it("hard-cuts a single overlong sentence", () => {
        const p = "啊".repeat(100);
        const chunks = chunkSpeechText(p, 30);
        expect(chunks.length).toBe(4); // 30+30+30+10
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
        expect(chunks.join("")).toBe(p);
    });

    it("never emits empty chunks", () => {
        const chunks = chunkSpeechText("a\n\n\nb", 1500);
        expect(chunks).toEqual(["a\nb"]);
    });
});
