// Local progress records (Stage 3).
//
// Progress stays on this device by default (design: "进度默认 LocalStorage").
// Key scheme:
//   s7ea:progress:video:{assetId} -> VideoProgressRecord (JSON: seconds + updatedAt)
//   s7ea:progress:audio:{assetId} -> AudioProgressRecord (JSON: updatedAt + metadata;
//       exact seconds live in the Stage 2 key s7ea:audio:{assetId}, owned by AudioPlayer)
//   s7ea:progress:read:{storyId}  -> ReadProgressRecord  (JSON: fraction + updatedAt)
//
// All storage access is wrapped in try/catch: private mode / quota failures
// must never break rendering. The homepage "continue" section renders only
// when at least one record exists on this device.

export const VIDEO_PROGRESS_PREFIX = "s7ea:progress:video:";
export const AUDIO_PROGRESS_PREFIX = "s7ea:progress:audio:";
export const READ_PROGRESS_PREFIX = "s7ea:progress:read:";

export interface VideoProgressRecord {
  /** last known position in seconds (best effort: Stream iframe has no time API) */
  seconds: number;
  updatedAt: number;
  title?: string;
  storySlug?: string;
  assetId: number | string;
}

export interface AudioProgressRecord {
  /** last known position in seconds (mirrored from the Stage 2 audio key at play time) */
  seconds: number;
  updatedAt: number;
  title?: string;
  storySlug?: string;
  assetId: number | string;
}

export interface ReadProgressRecord {
  /** 0..1 scroll fraction */
  fraction: number;
  updatedAt: number;
  title?: string;
  slug: string;
  storyId: number | string;
}

export type ContinueKind = "video" | "audio" | "read";

export interface ContinueEntry {
  kind: ContinueKind;
  title: string;
  href: string;
  /** human position label, e.g. "12:34" or "已读 62%" — built by the caller (i18n) */
  seconds?: number;
  fraction?: number;
  updatedAt: number;
}

export function videoProgressKey(assetId: number | string): string {
  return `${VIDEO_PROGRESS_PREFIX}${assetId}`;
}

export function audioProgressKeyV3(assetId: number | string): string {
  return `${AUDIO_PROGRESS_PREFIX}${assetId}`;
}

export function readProgressKey(storyId: number | string): string {
  return `${READ_PROGRESS_PREFIX}${storyId}`;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / quota — non-fatal
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // non-fatal
  }
}

function parseRecord<T>(raw: string | null): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function loadVideoProgress(assetId: number | string): VideoProgressRecord | undefined {
  const record = parseRecord<VideoProgressRecord>(safeGet(videoProgressKey(assetId)));
  if (!record || typeof record.seconds !== "number" || !Number.isFinite(record.seconds)) {
    return undefined;
  }
  return record;
}

export function saveVideoProgress(record: Omit<VideoProgressRecord, "updatedAt">): void {
  safeSet(
    videoProgressKey(record.assetId),
    JSON.stringify({ ...record, seconds: Math.max(0, record.seconds), updatedAt: Date.now() }),
  );
}

export function loadAudioProgressMeta(assetId: number | string): AudioProgressRecord | undefined {
  return parseRecord<AudioProgressRecord>(safeGet(audioProgressKeyV3(assetId)));
}

export function saveAudioProgressMeta(record: Omit<AudioProgressRecord, "updatedAt">): void {
  safeSet(audioProgressKeyV3(record.assetId), JSON.stringify({ ...record, updatedAt: Date.now() }));
}

export function loadReadProgress(storyId: number | string): ReadProgressRecord | undefined {
  const record = parseRecord<ReadProgressRecord>(safeGet(readProgressKey(storyId)));
  if (
    !record ||
    typeof record.fraction !== "number" ||
    !Number.isFinite(record.fraction) ||
    record.fraction < 0 ||
    record.fraction > 1
  ) {
    return undefined;
  }
  return record;
}

export function saveReadProgress(record: Omit<ReadProgressRecord, "updatedAt">): void {
  safeSet(
    readProgressKey(record.storyId),
    JSON.stringify({
      ...record,
      fraction: Math.min(1, Math.max(0, record.fraction)),
      updatedAt: Date.now(),
    }),
  );
}

export function clearProgress(kind: ContinueKind, id: number | string): void {
  const key =
    kind === "video" ? videoProgressKey(id) : kind === "audio" ? audioProgressKeyV3(id) : readProgressKey(id);
  safeRemove(key);
}

function storageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
  } catch {
    // non-fatal
  }
  return keys;
}

/**
 * Collect homepage "continue" entries from this device's progress records,
 * newest first. Returns [] when there is no local progress — the homepage
 * section must not render in that case.
 */
export function collectContinueEntries(limit = 5): ContinueEntry[] {
  const entries: ContinueEntry[] = [];
  for (const key of storageKeys()) {
    if (key.startsWith(VIDEO_PROGRESS_PREFIX)) {
      const record = parseRecord<VideoProgressRecord>(safeGet(key));
      if (record && typeof record.seconds === "number") {
        entries.push({
          kind: "video",
          title: record.title || "",
          href: record.storySlug ? `/story/${record.storySlug}` : "/media?type=video",
          seconds: record.seconds,
          updatedAt: record.updatedAt || 0,
        });
      }
    } else if (key.startsWith(AUDIO_PROGRESS_PREFIX)) {
      const record = parseRecord<AudioProgressRecord>(safeGet(key));
      if (record && typeof record.seconds === "number") {
        entries.push({
          kind: "audio",
          title: record.title || "",
          href: `/media?type=audio&play=${encodeURIComponent(String(record.assetId))}`,
          seconds: record.seconds,
          updatedAt: record.updatedAt || 0,
        });
      }
    } else if (key.startsWith(READ_PROGRESS_PREFIX)) {
      const record = parseRecord<ReadProgressRecord>(safeGet(key));
      if (record && typeof record.fraction === "number") {
        entries.push({
          kind: "read",
          title: record.title || "",
          href: `/story/${record.slug}`,
          fraction: record.fraction,
          updatedAt: record.updatedAt || 0,
        });
      }
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries.slice(0, Math.max(0, limit));
}
