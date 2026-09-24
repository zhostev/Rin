import { describe, expect, it } from "bun:test";
import {
  diffJsonLeaves,
  diffTextLines,
  extractDraftText,
  flattenJson,
} from "../ai-studio-diff";

describe("flattenJson", () => {
  it("flattens nested objects and arrays into dot-path leaves", () => {
    const leaves = flattenJson({ a: { b: "x" }, list: [1, { c: true }] });
    const paths = leaves.map((leaf) => leaf.path).sort();
    expect(paths).toEqual(["a.b", "list[0]", "list[1].c"]);
    expect(leaves.find((leaf) => leaf.path === "a.b")?.value).toBe("x");
  });

  it("handles scalar roots", () => {
    expect(flattenJson("hi")).toEqual([{ path: "(root)", value: "hi" }]);
  });
});

describe("diffTextLines", () => {
  it("marks identical texts as all-same", () => {
    const lines = diffTextLines("a\nb", "a\nb");
    expect(lines.every((line) => line.type === "same")).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("detects a changed middle line", () => {
    const lines = diffTextLines("a\nb\nc", "a\nB\nc");
    expect(lines.map((line) => line.type)).toEqual(["same", "del", "add", "same"]);
    expect(lines[1].text).toBe("b");
    expect(lines[2].text).toBe("B");
  });

  it("handles insertions at the end", () => {
    const lines = diffTextLines("a", "a\nb");
    expect(lines.map((line) => line.type)).toEqual(["same", "add"]);
  });

  it("handles empty old text", () => {
    const lines = diffTextLines("", "hello");
    expect(lines.map((line) => line.type)).toEqual(["add"]);
  });
});

describe("diffJsonLeaves", () => {
  it("reports added, removed, changed and same leaves", () => {
    const rows = diffJsonLeaves(
      { keep: 1, change: "old", gone: true },
      { keep: 1, change: "new", added: "x" },
    );
    const byPath = new Map(rows.map((row) => [row.path, row]));
    expect(byPath.get("keep")?.change).toBe("same");
    expect(byPath.get("change")?.change).toBe("changed");
    expect(byPath.get("change")?.oldValue).toBe("old");
    expect(byPath.get("change")?.newValue).toBe("new");
    expect(byPath.get("gone")?.change).toBe("removed");
    expect(byPath.get("added")?.change).toBe("added");
  });
});

describe("extractDraftText", () => {
  it("prefers a draft-named long string field", () => {
    const text = extractDraftText({
      summary: "short",
      draft: "a".repeat(100),
      other: "b".repeat(100),
    });
    expect(text).toBe("a".repeat(100));
  });

  it("falls back to the first long string", () => {
    const text = extractDraftText({ notes: "c".repeat(50) });
    expect(text).toBe("c".repeat(50));
  });

  it("returns null when there is no long text", () => {
    expect(extractDraftText({ a: 1, b: "short" })).toBeNull();
    expect(extractDraftText(null)).toBeNull();
  });
});
