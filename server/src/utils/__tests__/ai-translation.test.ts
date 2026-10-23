import { describe, expect, it } from "bun:test";
import {
    chunkMarkdownForTranslation,
    parseHeadingTranslation,
    resolveTranslationMaxTokens,
    TRANSLATION_THINKING_TOKEN_HEADROOM,
} from "../ai-translation";

describe("chunkMarkdownForTranslation", () => {
    it("keeps short content in one chunk", () => {
        expect(chunkMarkdownForTranslation("第一段\n\n第二段")).toEqual(["第一段\n\n第二段"]);
    });

    it("splits on paragraph boundaries over the limit", () => {
        const para = "x".repeat(100);
        const chunks = chunkMarkdownForTranslation([para, para, para].join("\n\n"), 150);
        expect(chunks.length).toBe(3);
        expect(chunks.every((chunk) => chunk.length <= 150)).toBe(true);
    });

    it("never splits inside a fenced code block", () => {
        const code = "```ts\n" + "const a = 1;\n".repeat(50) + "```";
        const content = `前文\n\n${code}\n\n后文`;
        const chunks = chunkMarkdownForTranslation(content, 100);
        const codeChunk = chunks.find((chunk) => chunk.includes("```ts"));
        expect(codeChunk?.endsWith("```")).toBe(true);
        expect(codeChunk?.match(/```/g)?.length).toBe(2);
    });

    it("returns no chunks for empty content", () => {
        expect(chunkMarkdownForTranslation("")).toEqual([]);
        expect(chunkMarkdownForTranslation("\n\n")).toEqual([]);
    });
});

describe("parseHeadingTranslation", () => {
    it("parses TITLE/SUMMARY marker lines", () => {
        expect(parseHeadingTranslation("TITLE: Hello World\nSUMMARY: A summary")).toEqual({
            title: "Hello World",
            summary: "A summary",
        });
    });

    it("treats an empty summary marker as an empty summary", () => {
        expect(parseHeadingTranslation("TITLE: Hello\nSUMMARY:")).toEqual({ title: "Hello", summary: "" });
    });

    it("falls back to the first non-empty line as the title", () => {
        expect(parseHeadingTranslation("\nJust a title").title).toBe("Just a title");
    });
});

describe("resolveTranslationMaxTokens", () => {
    it("adds thinking headroom on top of the chunk size", () => {
        expect(resolveTranslationMaxTokens("x".repeat(2000))).toBe(2000 + TRANSLATION_THINKING_TOKEN_HEADROOM);
        expect(resolveTranslationMaxTokens("")).toBe(TRANSLATION_THINKING_TOKEN_HEADROOM);
    });
});
