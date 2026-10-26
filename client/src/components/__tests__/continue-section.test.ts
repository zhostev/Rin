import { describe, expect, it } from "bun:test";
import {
  CONTINUE_SECTION_CLASS,
  continueGridClassName,
} from "../continue-section";

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

describe("ContinueSection layout classes", () => {
  it("section shares the article list's centered wauto column, not full width", () => {
    const classes = tokens(CONTINUE_SECTION_CLASS);
    expect(classes).toContain("wauto");
    expect(classes).not.toContain("w-full");
  });

  it("a single entry spans the whole column instead of sitting in the left grid column", () => {
    const classes = tokens(continueGridClassName(1));
    expect(classes).toContain("grid-cols-1");
    expect(classes).not.toContain("sm:grid-cols-2");
  });

  it("zero entries use the same single-column class", () => {
    expect(tokens(continueGridClassName(0))).not.toContain("sm:grid-cols-2");
  });

  it("multiple entries still use the two-column grid on wider screens", () => {
    const classes = tokens(continueGridClassName(2));
    expect(classes).toContain("grid-cols-1");
    expect(classes).toContain("sm:grid-cols-2");
    expect(tokens(continueGridClassName(5))).toContain("sm:grid-cols-2");
  });
});
