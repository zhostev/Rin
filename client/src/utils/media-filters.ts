// Media center filter helpers (Stage 3). Pure, unit-tested.
//
// One page serves all three media kinds (/media?type=video|audio|image);
// the same filter set applies to each:
//   theme (storyId dropdown) · year · duration range · updated tri-state.
// "媒介" itself is the type tab, not a filter field.

import type { MediaCenterKind } from "../api/media-center";

export type MediaTypeFilter = MediaCenterKind;

export const MEDIA_TYPES: readonly MediaTypeFilter[] = ["video", "audio", "image"] as const;

/** Parse the ?type= query param; unknown values fall back to "video". */
export function parseMediaType(raw: string | null | undefined): MediaTypeFilter {
  if (raw === "audio" || raw === "image" || raw === "video") return raw;
  return "video";
}

export type UpdatedFilter = "all" | "updated" | "not_updated";

export interface MediaFilters {
  storyId?: string;
  year?: number;
  minDuration?: number;
  maxDuration?: number;
  updated: UpdatedFilter;
}

export const EMPTY_MEDIA_FILTERS: MediaFilters = { updated: "all" };

/** True when any filter beyond the defaults is active. */
export function hasActiveFilters(filters: MediaFilters): boolean {
  return Boolean(
    filters.storyId || filters.year || filters.minDuration || filters.maxDuration || filters.updated !== "all",
  );
}

/** Map the tri-state updated filter onto the API's boolean param. */
export function updatedFilterToParam(updated: UpdatedFilter): boolean | undefined {
  if (updated === "updated") return true;
  if (updated === "not_updated") return false;
  return undefined;
}

/** Parse a positive integer from a text input; undefined for blank/garbage. */
export function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Distinct story options derived from loaded media items (for the theme dropdown). */
export interface MediaStoryOption {
  storyId: string;
  storySlug?: string;
  storyTitle: string;
}

export function distinctStoryOptions(
  items: Array<{ storyId?: number | string; storySlug?: string; storyTitle?: string }>,
): MediaStoryOption[] {
  const seen = new Map<string, MediaStoryOption>();
  for (const item of items) {
    if (item.storyId === undefined || item.storyId === "") continue;
    const key = String(item.storyId);
    if (!seen.has(key)) {
      seen.set(key, {
        storyId: key,
        storySlug: item.storySlug,
        storyTitle: item.storyTitle || key,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.storyTitle.localeCompare(b.storyTitle));
}

/** Group image items by story for "按主题浏览". */
export function groupItemsByStory<T extends { storySlug?: string; storyTitle?: string; storyId?: number | string }>(
  items: T[],
): Array<{ key: string; storySlug?: string; storyTitle: string; items: T[] }> {
  const groups = new Map<string, { key: string; storySlug?: string; storyTitle: string; items: T[] }>();
  for (const item of items) {
    const key = item.storySlug || String(item.storyId ?? "") || "__unknown__";
    let group = groups.get(key);
    if (!group) {
      group = { key, storySlug: item.storySlug, storyTitle: item.storyTitle || "", items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}
