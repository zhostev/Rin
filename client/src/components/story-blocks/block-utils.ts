// Pure helpers for story block editing and the story detail media switcher.
// Kept free of React/DOM so they can be unit-tested with bun:test.

import type { AudioChapter, BlockType, ContentBlock } from "../../api/story";

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
    case "image":
      return {};
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

// ---------------------------------------------------------------------------
// Stage 2 media helpers
// ---------------------------------------------------------------------------

export interface GalleryImageLike {
  url?: string;
  alt?: string;
  images_variants?: Record<string, string>;
}

export interface ResponsiveImageProps {
  /** Best default <img> src (medium variant, or the largest available). */
  src: string;
  /** width-descriptor srcSet built from Cloudflare Images variants. */
  srcSet?: string;
  /** Largest variant URL — used for the lightbox. */
  largeSrc?: string;
}

/** Variant name aliases (case-insensitive) mapped to width descriptors. */
const IMAGE_VARIANT_WIDTHS: Array<{ aliases: string[]; width: number }> = [
  { aliases: ["thumb", "thumbnail", "small", "320", "320w"], width: 320 },
  { aliases: ["medium", "960", "960w"], width: 960 },
  { aliases: ["large", "1600", "1600w"], width: 1600 },
];

function findVariant(variants: Record<string, string>, aliases: string[]): string | undefined {
  const entries = Object.entries(variants);
  for (const alias of aliases) {
    const hit = entries.find(([name]) => name.toLowerCase() === alias);
    if (hit && hit[1]) return hit[1];
  }
  return undefined;
}

/**
 * Build responsive <img> props from a gallery image / asset.
 * Uses Cloudflare Images variants when present (thumb 320w, medium 960w,
 * large 1600w); falls back to the plain url otherwise.
 */
export function responsiveImageProps(image: GalleryImageLike | undefined): ResponsiveImageProps {
  const url = image?.url ?? "";
  const variants = image?.images_variants;
  if (!variants || Object.keys(variants).length === 0) {
    return { src: url };
  }
  const picked = IMAGE_VARIANT_WIDTHS.map(({ aliases, width }) => ({
    width,
    url: findVariant(variants, aliases),
  })).filter((entry): entry is { width: number; url: string } => Boolean(entry.url));

  if (picked.length === 0) {
    return { src: url };
  }
  const srcSet = picked.map(({ width, url: variantUrl }) => `${variantUrl} ${width}w`).join(", ");
  const medium = picked.find(({ width }) => width === 960)?.url;
  const largest = picked[picked.length - 1].url;
  return {
    src: medium ?? largest ?? url,
    srcSet,
    largeSrc: largest,
  };
}

/** localStorage key used to remember audio playback progress per asset. */
export function audioProgressKey(assetId: number | string | undefined): string {
  return `s7ea:audio:${assetId ?? "unknown"}`;
}

/** Playback speeds offered by the audio player. */
export const AUDIO_PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

/** Minimum interval between persisted progress writes (ms). */
export const AUDIO_PROGRESS_SAVE_INTERVAL_MS = 5000;

/** Decide whether a progress write should be persisted (throttle check). */
export function shouldPersistProgress(lastSavedAt: number, now: number): boolean {
  return now - lastSavedAt >= AUDIO_PROGRESS_SAVE_INTERVAL_MS;
}

/**
 * Index of the chapter that contains `time` (last chapter whose start <= time).
 * Returns -1 when there are no usable chapters.
 */
export function findChapterIndex(chapters: AudioChapter[] | undefined, time: number): number {
  if (!chapters || chapters.length === 0) return -1;
  let index = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    const start = chapters[i]?.start;
    if (typeof start === "number" && Number.isFinite(start) && start <= time) {
      index = i;
    }
  }
  return index;
}

/** Parse a persisted progress value; returns undefined for garbage. */
export function parseStoredProgress(raw: string | null): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
