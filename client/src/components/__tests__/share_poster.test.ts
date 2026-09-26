import { describe, expect, test } from "bun:test";
import { articleImageScale, parseArticleBlocks, stripMarkdown, wrapText } from "../share_poster";

describe("stripMarkdown", () => {
  test("removes code blocks, links, and formatting", () => {
    const src = "# Title\n\n```js\nconst a = 1;\n```\n\nHello [world](https://x.com) *em* `code` ![img](/a.png)";
    const out = stripMarkdown(src);
    expect(out).not.toContain("```");
    expect(out).not.toContain("https://x.com");
    expect(out).not.toContain("*");
    expect(out).toContain("Title");
    expect(out).toContain("Hello world em code img");
  });

  test("collapses whitespace", () => {
    expect(stripMarkdown("a\n\n\nb")).toBe("a b");
  });
});

describe("wrapText", () => {
  // measureText stub: 10px per char
  const ctx = {
    measureText: (s: string) => ({ width: s.length * 10 }),
  } as unknown as CanvasRenderingContext2D;

  test("wraps long text at maxWidth", () => {
    const lines = wrapText(ctx, "abcdefghij", 25, 10);
    expect(lines).toEqual(["ab", "cd", "ef", "gh", "ij"]);
  });

  test("truncates with ellipsis at maxLines", () => {
    const lines = wrapText(ctx, "abcdefghij", 25, 2);
    expect(lines).toEqual(["ab", "c…"]);
  });

  test("short text stays on one line", () => {
    expect(wrapText(ctx, "ab", 25, 3)).toEqual(["ab"]);
  });
});

describe("parseArticleBlocks", () => {
  test("parses headings, paragraphs, images, code, lists, quotes", () => {
    const md = [
      "# Title",
      "",
      "Hello **world**.",
      "",
      "## Sub",
      "",
      "![alt](/img.png)",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "- one",
      "- two",
      "",
      "> quoted text",
    ].join("\n");
    const blocks = parseArticleBlocks(md);
    expect(blocks).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", text: "Hello world." },
      { type: "heading", level: 2, text: "Sub" },
      { type: "image", alt: "alt", src: "/img.png" },
      { type: "code", text: "const a = 1;" },
      { type: "list", items: ["one", "two"] },
      { type: "quote", text: "quoted text" },
    ]);
  });

  test("merges consecutive paragraph lines and skips empties", () => {
    const blocks = parseArticleBlocks("a\nb\n\n\nc");
    expect(blocks).toEqual([
      { type: "paragraph", text: "a b" },
      { type: "paragraph", text: "c" },
    ]);
  });

  test("empty input yields no blocks", () => {
    expect(parseArticleBlocks("")).toEqual([]);
    expect(parseArticleBlocks("   \n\n ")).toEqual([]);
  });

  test("extracts inline images from paragraph lines", () => {
    const blocks = parseArticleBlocks(
      "before ![](/api/media/10/playback) after\nnext line\n\n![](/img.png)",
    );
    expect(blocks).toEqual([
      { type: "paragraph", text: "before" },
      { type: "image", alt: "", src: "/api/media/10/playback" },
      { type: "paragraph", text: "after" },
      { type: "paragraph", text: "next line" },
      { type: "image", alt: "", src: "/img.png" },
    ]);
  });

  test("inline image alone on a line stays a single image block", () => {
    const blocks = parseArticleBlocks("text\n![](a.jpg)\nmore");
    expect(blocks).toEqual([
      { type: "paragraph", text: "text" },
      { type: "image", alt: "", src: "a.jpg" },
      { type: "paragraph", text: "more" },
    ]);
  });
});


describe("articleImageScale", () => {
  test("keeps full 2x scale for short articles", () => {
    expect(articleImageScale(1000)).toBe(2);
    expect(articleImageScale(8192)).toBe(2);
  });

  test("scales down so device height stays within the cap", () => {
    // 16384 / 10000 = 1.6384
    expect(articleImageScale(10000)).toBeCloseTo(1.6384, 4);
    // very long article: 16384 / 40000 = 0.4096
    expect(articleImageScale(40000)).toBeCloseTo(0.4096, 4);
  });

  test("falls back to full scale for invalid heights", () => {
    expect(articleImageScale(0)).toBe(2);
    expect(articleImageScale(-5)).toBe(2);
    expect(articleImageScale(NaN)).toBe(2);
  });
});
