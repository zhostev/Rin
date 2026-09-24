// Pure helpers for story block editing and the story detail media switcher.
// Kept free of React/DOM so they can be unit-tested with bun:test.

import type { BlockType, ContentBlock } from "../../api/story";

/** Media switcher tabs on the story detail page. */
export type MediaTab = "read" | "video" | "audio";

export const MEDIA_TABS: MediaTab[] = ["read", "video", "audio"];

const TAB_FOR_BLOCK_TYPE: Partial<Record<BlockType, MediaTab>> = {
  rich_text: "read",
  quote: "read",
  code: "read",
  callout: "read",
  image: "read",
  gallery: "read",
  attachment: "read",
  divider: "read",
  cta: "read",
  video: "video",
  audio: "audio",
};

/**
 * Compute which media tabs a story actually has, in canonical order.
 * The "read" tab is always present when the story has any non-media block
 * (or when there is nothing at all — the summary still needs a place).
 */
export function mediaTabsForBlocks(blocks: ContentBlock[]): MediaTab[] {
  const present = new Set<MediaTab>();
  for (const block of blocks) {
    const tab = TAB_FOR_BLOCK_TYPE[block.type];
    if (tab) present.add(tab);
  }
  if (!present.has("read")) {
    present.add("read");
  }
  return MEDIA_TABS.filter((tab) => present.has(tab));
}

export function newBlockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `block-${crypto.randomUUID()}`;
  }
  return `block-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function defaultPayload(type: BlockType): Record<string, unknown> {
  switch (type) {
    case "rich_text":
      return { markdown: "" };
    case "video":
      return { title: "" };
    case "audio":
      return { title: "" };
    default:
      return {};
  }
}

export function createBlock(type: BlockType, position: number): ContentBlock {
  return {
    id: newBlockId(),
    type,
    position,
    payload: defaultPayload(type),
  };
}

/** Move the block at `index` by `delta` positions (-1 up, +1 down). Pure. */
export function moveBlock<T extends ContentBlock>(blocks: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= blocks.length || target < 0 || target >= blocks.length) {
    return blocks;
  }
  const next = blocks.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next.map((block, position) => ({ ...block, position }));
}

export function removeBlock<T extends ContentBlock>(blocks: T[], id: number | string | undefined): T[] {
  return blocks
    .filter((block) => block.id !== id)
    .map((block, position) => ({ ...block, position }));
}

export function updateBlockPayload<T extends ContentBlock>(
  blocks: T[],
  id: number | string | undefined,
  patch: Record<string, unknown>,
): T[] {
  return blocks.map((block) =>
    block.id === id ? { ...block, payload: { ...block.payload, ...patch } } : block,
  );
}

/** Format seconds as m:ss / h:mm:ss; undefined/null/NaN -> "—". */
export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(secs).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Guess an asset kind from a file's MIME type. */
export function kindForMime(mime: string): "image" | "video" | "audio" | undefined {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return undefined;
}
