// Tests for the media center filter helpers (utils/media-filters).

import { describe, expect, it } from "bun:test";
import {
  distinctStoryOptions,
  groupItemsByStory,
  hasActiveFilters,
  parseMediaType,
  parsePositiveInt,
  updatedFilterToParam,
  EMPTY_MEDIA_FILTERS,
} from "../media-filters";

describe("parseMediaType", () => {
  it("accepts the three known kinds", () => {
    expect(parseMediaType("video")).toBe("video");
    expect(parseMediaType("audio")).toBe("audio");
    expect(parseMediaType("image")).toBe("image");
  });

  it("falls back to video for missing or unknown values", () => {
    expect(parseMediaType(null)).toBe("video");
    expect(parseMediaType(undefined)).toBe("video");
    expect(parseMediaType("")).toBe("video");
    expect(parseMediaType("podcast")).toBe("video");
  });
});

describe("parsePositiveInt", () => {
  it("parses positive integers", () => {
    expect(parsePositiveInt("2024")).toBe(2024);
    expect(parsePositiveInt(" 60 ")).toBe(60);
  });

  it("rejects blank, zero, negative, and garbage input", () => {
    expect(parsePositiveInt("")).toBeUndefined();
    expect(parsePositiveInt("   ")).toBeUndefined();
    expect(parsePositiveInt(null)).toBeUndefined();
    expect(parsePositiveInt(undefined)).toBeUndefined();
    expect(parsePositiveInt("0")).toBeUndefined();
    expect(parsePositiveInt("-3")).toBeUndefined();
    expect(parsePositiveInt("abc")).toBeUndefined();
  });
});

describe("updatedFilterToParam", () => {
  it("maps the tri-state to the API boolean", () => {
    expect(updatedFilterToParam("updated")).toBe(true);
    expect(updatedFilterToParam("not_updated")).toBe(false);
    expect(updatedFilterToParam("all")).toBeUndefined();
  });
});

describe("hasActiveFilters", () => {
  it("is false for the empty filter set", () => {
    expect(hasActiveFilters(EMPTY_MEDIA_FILTERS)).toBe(false);
    expect(hasActiveFilters({ updated: "all" })).toBe(false);
  });

  it("is true when any filter is set", () => {
    expect(hasActiveFilters({ updated: "all", year: 2024 })).toBe(true);
    expect(hasActiveFilters({ updated: "updated" })).toBe(true);
    expect(hasActiveFilters({ updated: "all", storyId: "12" })).toBe(true);
    expect(hasActiveFilters({ updated: "all", minDuration: 60 })).toBe(true);
    expect(hasActiveFilters({ updated: "all", maxDuration: 600 })).toBe(true);
  });
});

describe("distinctStoryOptions", () => {
  it("dedupes by storyId and sorts by title", () => {
    const options = distinctStoryOptions([
      { storyId: 2, storySlug: "b", storyTitle: "Beta" },
      { storyId: 1, storySlug: "a", storyTitle: "Alpha" },
      { storyId: 2, storySlug: "b", storyTitle: "Beta (dup)" },
      { storyTitle: "No id" },
    ]);
    expect(options).toHaveLength(2);
    expect(options[0]?.storyTitle).toBe("Alpha");
    expect(options[1]?.storyTitle).toBe("Beta");
    expect(options[1]?.storyId).toBe("2");
  });

  it("falls back to the id when the title is missing", () => {
    const options = distinctStoryOptions([{ storyId: 5 }]);
    expect(options[0]?.storyTitle).toBe("5");
  });
});

describe("groupItemsByStory", () => {
  it("groups image items by story for per-theme browsing", () => {
    const groups = groupItemsByStory([
      { id: 1, storySlug: "a", storyTitle: "A" },
      { id: 2, storySlug: "b", storyTitle: "B" },
      { id: 3, storySlug: "a", storyTitle: "A" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[1]?.items).toHaveLength(1);
    expect(groups[0]?.storySlug).toBe("a");
  });

  it("keeps items without a story in their own group", () => {
    const groups = groupItemsByStory<{ id: number; storySlug?: string; storyTitle?: string; storyId?: number | string }>([
      { id: 1 },
      { id: 2 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toHaveLength(2);
  });
});
