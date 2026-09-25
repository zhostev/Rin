import { describe, expect, test } from "bun:test";
import { stripMarkdown, wrapText } from "../share_poster";

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
