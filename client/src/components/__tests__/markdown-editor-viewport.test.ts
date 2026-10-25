import { describe, expect, it } from "bun:test";
import { resetEditorViewportToStart } from "../markdown-editor-viewport";

describe("resetEditorViewportToStart", () => {
  it("lays out, moves the cursor to (1, 1), scrolls to 0, then lays out again", () => {
    const calls: string[] = [];
    const editor = {
      layout: () => {
        calls.push("layout");
      },
      setPosition: (position: { lineNumber: number; column: number }) => {
        calls.push(`setPosition(${position.lineNumber},${position.column})`);
      },
      setScrollTop: (scrollTop: number) => {
        calls.push(`setScrollTop(${scrollTop})`);
      },
    };

    resetEditorViewportToStart(editor);

    expect(calls).toEqual([
      "layout",
      "setPosition(1,1)",
      "setScrollTop(0)",
      "layout",
    ]);
  });

  it("is a no-op for a missing editor (e.g. a pending frame after unmount)", () => {
    expect(() => resetEditorViewportToStart(undefined)).not.toThrow();
    expect(() => resetEditorViewportToStart(null)).not.toThrow();
  });
});
