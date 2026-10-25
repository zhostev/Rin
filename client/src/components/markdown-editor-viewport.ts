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

/**
 * Tracks whether a Monaco editor has already been laid out and reset for
 * its current visible session, so an IntersectionObserver can fire the
 * reset exactly when the editor first becomes visible — not at mount time
 * while it is still below the fold.
 *
 * Why this exists: PR #78 reset on mount and PR #79 reset whenever the
 * edit pane became visible again, but both resets can run while the editor
 * container is still off-screen (story pages put title/summary/AI panels
 * above the first block, so it mounts below the fold). A reset applied to
 * an invisible container does not fix the viewport; only a reset applied
 * once the container actually enters the viewport does. Re-entering the
 * viewport by scrolling the page does not re-reset: yanking the cursor
 * back to (1, 1) while the user is editing would be worse than the bug.
 * The flag is re-armed explicitly when the edit pane is hidden (switching
 * to preview), so the next time the pane becomes visible the observer can
 * fire again alongside the existing preview-switch reset.
 */
export class EditorVisibilityResetTracker {
  private visible = false;
  private resetDone = false;

  /** Whether the observed container is currently intersecting. */
  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * Record an IntersectionObserver entry. Returns true only when a reset
   * should run now: the container is intersecting, an editor instance
   * exists, and no reset has run yet for this visible session. Visibility
   * itself is always recorded, even without an editor, so a mount that
   * happens while visible can still count its own reset via
   * noteResetDone().
   */
  noteIntersection(isIntersecting: boolean, hasEditor: boolean): boolean {
    this.visible = isIntersecting;
    if (!isIntersecting || !hasEditor || this.resetDone) return false;
    this.resetDone = true;
    return true;
  }

  /** Mark the mount/preview-switch reset as done (editor was visible). */
  noteResetDone(): void {
    this.resetDone = true;
  }

  /** Re-arm for the next visible session (edit pane hidden). */
  noteHidden(): void {
    this.visible = false;
    this.resetDone = false;
  }
}
