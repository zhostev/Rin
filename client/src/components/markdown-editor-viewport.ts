// Minimal viewport reset for a Monaco editor instance.
//
// Kept dependency-free (no React, no Monaco import) so it can be unit-tested
// with a recording fake: Monaco's canvas rendering cannot be covered by
// bun/jsdom tests, but the reset sequence itself can.

/** The subset of the Monaco editor API the reset needs. */
export interface ViewportResettableEditor {
  layout(): void;
  setPosition(position: { lineNumber: number; column: number }): void;
  setScrollTop(scrollTop: number): void;
}

/**
 * Move the viewport deterministically to the start of the document.
 *
 * Order matters: lay out first so dimensions are current, move the cursor to
 * (1, 1) and the scroll offset to 0, then lay out again so the lines at the
 * top are painted at the correct width. Cursor/scroll changes do not touch
 * model content, so IME composition and onDidChangeModelContent sync are
 * unaffected. A null/undefined editor is a no-op (e.g. a pending
 * requestAnimationFrame firing after unmount).
 */
export function resetEditorViewportToStart(
  editor: ViewportResettableEditor | undefined | null,
): void {
  if (!editor) return;
  editor.layout();
  editor.setPosition({ lineNumber: 1, column: 1 });
  editor.setScrollTop(0);
  editor.layout();
}
