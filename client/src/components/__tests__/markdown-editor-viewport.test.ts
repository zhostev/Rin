import { describe, expect, it } from "bun:test";
import {
  EditorVisibilityResetTracker,
  resetEditorViewportToStart,
} from "../markdown-editor-viewport";

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

describe("EditorVisibilityResetTracker", () => {
  it("fires once on the first visible entry with an editor, not on re-entry", () => {
    const tracker = new EditorVisibilityResetTracker();
    expect(tracker.noteIntersection(false, true)).toBe(false);
    expect(tracker.noteIntersection(true, true)).toBe(true);
    expect(tracker.noteIntersection(true, true)).toBe(false);
    expect(tracker.noteIntersection(false, true)).toBe(false);
    // Scrolling away and back does not re-fire: editing must not be
    // yanked back to (1, 1).
    expect(tracker.noteIntersection(true, true)).toBe(false);
  });

  it("records visibility without an editor, so a mount while visible can count its own reset", () => {
    const tracker = new EditorVisibilityResetTracker();
    expect(tracker.noteIntersection(true, false)).toBe(false);
    expect(tracker.isVisible).toBe(true);
    tracker.noteResetDone();
    expect(tracker.noteIntersection(true, true)).toBe(false);
  });

  it("re-arms when hidden, so the next visible session can fire again", () => {
    const tracker = new EditorVisibilityResetTracker();
    expect(tracker.noteIntersection(true, true)).toBe(true);
    tracker.noteHidden();
    expect(tracker.isVisible).toBe(false);
    expect(tracker.noteIntersection(true, true)).toBe(true);
  });
});
