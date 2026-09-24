// Media center page (/media?type=video|audio|image) — Stage 3.
//
// One page for all three media kinds, switched by the type tab — the page
// structure is not duplicated per kind. A single unified filter set applies
// to every kind: theme (story dropdown), year, duration range, updated.
// Only media assets are shown; body text is never copied here.
//
// Video cards reuse the Stage 2 StreamPlayer (click-to-load iframe): an
// asset whose streamStatus is not ready degrades to a poster + transcoding
// card, never a white screen. Audio reuses the Stage 2 AudioPlayer
// (queue + playback speed + progress memory). Images browse by story with
// a lightbox and per-image captions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { Link, useSearch } from "wouter";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import { client } from "../app/runtime";
import { AudioPlayer } from "../components/audio-player";
import { StreamPlayer } from "../components/stream-player";
import { Waiting } from "../components/loading";
import { Tips } from "../components/tips";
import {
  audioProgressKey,
  formatDuration,
  parseStoredProgress,
} from "../components/story-blocks";
import { useApiResource } from "../hooks/use-api-resource";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants";
import { tryInt } from "../utils/int";
import { getSharedEventTracker } from "../utils/analytics-client";
import {
  distinctStoryOptions,
  EMPTY_MEDIA_FILTERS,
  groupItemsByStory,
  hasActiveFilters,
  parseMediaType,
  parsePositiveInt,
  updatedFilterToParam,
  type MediaFilters,
  type MediaStoryOption,
  type MediaTypeFilter,
  type UpdatedFilter,
} from "../utils/media-filters";
import {
  loadVideoProgress,
  saveAudioProgressMeta,
  saveVideoProgress,
} from "../utils/media-progress";
import type {
  MediaCenterChapter,
  MediaCenterItem,
  MediaCenterListResponse,
} from "../api/media-center";
import type { AudioPayload, MediaAsset, StreamStatus, VideoPayload } from "../api/story";

// ---------------------------------------------------------------------------
// Module-level analytics tracker: session-deduped, failure-silent.
// ---------------------------------------------------------------------------

const trackEvent = getSharedEventTracker();

// ---------------------------------------------------------------------------
// Adapters: public (camelCase) media items -> Stage 2 payload shapes.
// ---------------------------------------------------------------------------

function mapStreamStatus(status: string | undefined): StreamStatus | undefined {
  if (status === "ready" || status === "error" || status === "uploading" || status === "processing") {
    return status;
  }
  // Unknown / absent status: the StreamPlayer treats a playable asset with
  // no status as ready; anything else degrades gracefully.
  return undefined;
}

function videoPayloadFor(item: MediaCenterItem): VideoPayload {
  const numericId = typeof item.id === "number" ? item.id : 0;
  const asset: MediaAsset = {
    id: numericId,
    kind: "video",
    source: item.streamUid ? "stream" : "external",
    title: item.title,
    duration: item.duration,
    width: item.width,
    height: item.height,
    url: item.publicUrl,
    stream_uid: item.streamUid,
    stream_status: mapStreamStatus(item.streamStatus),
    thumbnail_url: item.thumbnailUrl,
  };
  return {
    title: item.title,
    asset_id: typeof item.id === "number" ? item.id : undefined,
    duration: item.duration,
    asset,
  };
}

function audioPayloadFor(item: MediaCenterItem): AudioPayload {
  const asset: MediaAsset = {
    id: typeof item.id === "number" ? item.id : 0,
    kind: "audio",
    source: "r2",
    title: item.title,
    duration: item.duration,
    url: item.publicUrl,
  };
  return {
    title: item.title,
    asset_id: typeof item.id === "number" ? item.id : undefined,
    duration: item.duration,
    asset,
  };
}

function imageCaption(item: MediaCenterItem): string {
  return item.caption || item.alt || item.title || "";
}

// ---------------------------------------------------------------------------
// Filter bar (shared by all three kinds).
// ---------------------------------------------------------------------------

function FilterBar({
  filters,
  onChange,
  storyOptions,
}: {
  filters: MediaFilters;
  onChange: (next: MediaFilters) => void;
  storyOptions: MediaStoryOption[];
}) {
  const { t } = useTranslation();
  return (
    <div className="wauto mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-w p-3">
      <select
        value={filters.storyId ?? ""}
        onChange={(e) => onChange({ ...filters, storyId: e.target.value || undefined })}
        aria-label={t("media_page.filters.story")}
        className="rounded-full bg-secondary px-3 py-1.5 text-sm t-secondary"
      >
        <option value="">{t("media_page.filters.all_stories")}</option>
        {storyOptions.map((option) => (
          <option key={option.storyId} value={option.storyId}>
            {option.storyTitle}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={1}
        placeholder={t("media_page.filters.year")}
        value={filters.year ?? ""}
        onChange={(e) => onChange({ ...filters, year: parsePositiveInt(e.target.value) })}
        aria-label={t("media_page.filters.year")}
        className="w-24 rounded-full bg-secondary px-3 py-1.5 text-sm t-secondary"
      />
      <input
        type="number"
        min={1}
        placeholder={t("media_page.filters.min_duration")}
        value={filters.minDuration ?? ""}
        onChange={(e) => onChange({ ...filters, minDuration: parsePositiveInt(e.target.value) })}
        aria-label={t("media_page.filters.min_duration")}
        className="w-28 rounded-full bg-secondary px-3 py-1.5 text-sm t-secondary"
      />
      <input
        type="number"
        min={1}
        placeholder={t("media_page.filters.max_duration")}
        value={filters.maxDuration ?? ""}
        onChange={(e) => onChange({ ...filters, maxDuration: parsePositiveInt(e.target.value) })}
        aria-label={t("media_page.filters.max_duration")}
        className="w-28 rounded-full bg-secondary px-3 py-1.5 text-sm t-secondary"
      />
      <select
        value={filters.updated}
        onChange={(e) => onChange({ ...filters, updated: e.target.value as UpdatedFilter })}
        aria-label={t("media_page.filters.updated")}
        className="rounded-full bg-secondary px-3 py-1.5 text-sm t-secondary"
      >
        <option value="all">{t("media_page.filters.updated_all")}</option>
        <option value="updated">{t("media_page.filters.updated_only")}</option>
        <option value="not_updated">{t("media_page.filters.not_updated_only")}</option>
      </select>
      {hasActiveFilters(filters) && (
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_MEDIA_FILTERS })}
          className="rounded-full px-3 py-1.5 text-sm text-theme hover:underline"
        >
          {t("media_page.filters.reset")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video section.
// ---------------------------------------------------------------------------

function VideoCard({ item }: { item: MediaCenterItem }) {
  const { t } = useTranslation();
  const payload = useMemo(() => videoPayloadFor(item), [item]);
  const chapters: MediaCenterChapter[] = Array.isArray(item.chapters) ? item.chapters : [];

  function handleReveal() {
    trackEvent.track({ type: "video_play", assetId: item.id, storyId: item.storyId });
    // The Stream iframe exposes no time API, so the progress record is a
    // best-effort bookmark: keep the last known seconds, refresh updatedAt.
    const previous = loadVideoProgress(item.id);
    saveVideoProgress({
      assetId: item.id,
      seconds: previous?.seconds ?? 0,
      title: item.title,
      storySlug: item.storySlug,
    });
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl bg-w">
      <StreamPlayer payload={payload} onReveal={handleReveal} />
      <div className="flex flex-col gap-1.5 p-4 pt-3">
        <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          {typeof item.duration === "number" && (
            <span className="inline-flex items-center gap-1">
              <i className="ri-time-line" />
              {formatDuration(item.duration)}
            </span>
          )}
          {item.storySlug && (
            <Link
              href={`/story/${item.storySlug}`}
              className="inline-flex min-w-0 items-center gap-1 truncate text-theme hover:underline"
            >
              <i className="ri-book-open-line shrink-0" />
              <span className="truncate">{item.storyTitle || item.storySlug}</span>
            </Link>
          )}
        </div>
        {chapters.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-neutral-500 hover:t-primary dark:text-neutral-400">
              {t("media_page.video.chapters$count", { count: chapters.length })}
            </summary>
            <ul className="mt-1.5 space-y-1">
              {chapters.map((chapter, index) => (
                <li key={index} className="flex items-center gap-2 t-secondary">
                  <span className="shrink-0 font-mono text-neutral-400">{formatDuration(chapter.start)}</span>
                  <span className="min-w-0 truncate">{chapter.title || t("media_page.video.untitled_chapter")}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function VideoSection({ items }: { items: MediaCenterItem[] }) {
  const { t } = useTranslation();
  if (items.length === 0) {
    return <EmptyState message={t("media_page.empty")} />;
  }
  return (
    <div className="wauto grid grid-cols-1 gap-4 md:grid-cols-2">
      {items.map((item) => (
        <VideoCard key={String(item.id)} item={item} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audio section: episode list + play queue + speed (Stage 2 AudioPlayer).
// ---------------------------------------------------------------------------

function AudioSection({ items, playId }: { items: MediaCenterItem[]; playId?: string }) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<MediaCenterItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  // Build the queue from the loaded page; a ?play=<assetId> deep link puts
  // that episode first so "继续收听" resumes the right one.
  useEffect(() => {
    if (items.length === 0) {
      setQueue([]);
      setCurrentIndex(0);
      return;
    }
    const ordered = items.slice();
    if (playId) {
      const at = ordered.findIndex((item) => String(item.id) === playId);
      if (at > 0) {
        const [picked] = ordered.splice(at, 1);
        if (picked) ordered.unshift(picked);
      }
    }
    setQueue(ordered);
    setCurrentIndex(0);
  }, [items, playId]);

  const current = queue[currentIndex];
  const currentPayload = useMemo(() => (current ? audioPayloadFor(current) : undefined), [current]);

  function playAt(index: number) {
    if (index < 0 || index >= queue.length) return;
    setCurrentIndex(index);
  }

  function handlePlay(item: MediaCenterItem) {
    trackEvent.track({ type: "audio_play", assetId: item.id, storyId: item.storyId });
    // Mirror the last known position from the Stage 2 audio key so the
    // homepage "继续收听" entry can show it.
    let seconds = 0;
    try {
      const saved = parseStoredProgress(
        localStorage.getItem(audioProgressKey(typeof item.id === "number" ? item.id : String(item.id))),
      );
      if (typeof saved === "number") seconds = saved;
    } catch {
      // non-fatal
    }
    saveAudioProgressMeta({ assetId: item.id, seconds, title: item.title, storySlug: item.storySlug });
  }

  function handleEnded() {
    // Auto-advance the queue; stop at the end.
    setCurrentIndex((index) => (index + 1 < queue.length ? index + 1 : index));
  }

  if (items.length === 0) {
    return <EmptyState message={t("media_page.empty")} />;
  }

  return (
    <div className="wauto flex flex-col gap-4">
      {current && currentPayload && (
        <div className="rounded-2xl bg-w p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              {t("media_page.audio.now_playing")}
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => playAt(currentIndex - 1)}
                disabled={currentIndex === 0}
                aria-label={t("media_page.audio.previous")}
                className="rounded-full px-2 py-1 text-lg t-secondary transition-colors hover:t-primary disabled:opacity-30"
              >
                <i className="ri-skip-back-fill" />
              </button>
              <span className="text-xs text-neutral-400">
                {currentIndex + 1} / {queue.length}
              </span>
              <button
                type="button"
                onClick={() => playAt(currentIndex + 1)}
                disabled={currentIndex + 1 >= queue.length}
                aria-label={t("media_page.audio.next")}
                className="rounded-full px-2 py-1 text-lg t-secondary transition-colors hover:t-primary disabled:opacity-30"
              >
                <i className="ri-skip-forward-fill" />
              </button>
            </div>
          </div>
          <AudioPlayer
            key={String(current.id)}
            payload={currentPayload}
            onPlay={() => handlePlay(current)}
            onEnded={handleEnded}
          />
          {current.storySlug && (
            <Link
              href={`/story/${current.storySlug}`}
              className="mt-2 inline-flex items-center gap-1 text-xs text-theme hover:underline"
            >
              <i className="ri-book-open-line" />
              {current.storyTitle || current.storySlug}
            </Link>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {queue.map((item, index) => {
          const savedSeconds = parseStoredProgress(
            (() => {
              try {
                return localStorage.getItem(audioProgressKey(typeof item.id === "number" ? item.id : String(item.id)));
              } catch {
                return null;
              }
            })(),
          );
          const active = index === currentIndex;
          return (
            <li
              key={String(item.id)}
              className={`flex items-center gap-3 rounded-2xl p-3 transition-colors ${
                active ? "bg-w ring-1 ring-theme/40" : "bg-w hover:bg-secondary/60"
              }`}
            >
              <button
                type="button"
                onClick={() => playAt(index)}
                aria-label={t("media_page.audio.play_episode", { title: item.title })}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg transition-colors ${
                  active ? "bg-theme text-white" : "bg-secondary t-secondary hover:t-primary"
                }`}
              >
                <i className={active ? "ri-volume-up-fill" : "ri-play-fill"} />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium t-primary">{item.title || t("media_page.audio.untitled")}</p>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {typeof item.duration === "number" ? formatDuration(item.duration) : ""}
                  {typeof savedSeconds === "number" && savedSeconds > 1
                    ? ` · ${t("media_page.audio.resume_at", { time: formatDuration(savedSeconds) })}`
                    : ""}
                  {item.storyTitle ? ` · ${item.storyTitle}` : ""}
                </p>
              </div>
              {item.storySlug && (
                <Link
                  href={`/story/${item.storySlug}`}
                  aria-label={t("media_page.audio.open_story")}
                  className="shrink-0 rounded-full px-2 py-1 text-sm text-neutral-400 hover:text-theme"
                >
                  <i className="ri-book-open-line" />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image section: browse by story + lightbox with captions.
// ---------------------------------------------------------------------------

function ImageSection({ items }: { items: MediaCenterItem[] }) {
  const { t } = useTranslation();
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const groups = useMemo(() => groupItemsByStory(items), [items]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  if (items.length === 0) {
    return <EmptyState message={t("media_page.empty")} />;
  }

  return (
    <div className="wauto flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.storyTitle}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="truncate text-base font-semibold t-primary">
              {group.storyTitle || t("media_page.image.untitled_story")}
            </h2>
            {group.storySlug && (
              <Link href={`/story/${group.storySlug}`} className="shrink-0 text-xs text-theme hover:underline">
                {t("media_page.image.open_story")}
              </Link>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {group.items.map((item) => {
              const index = flat.indexOf(item);
              return (
                <button
                  key={String(item.id)}
                  type="button"
                  onClick={() => setLightboxIndex(index)}
                  className="group relative aspect-square overflow-hidden rounded-xl bg-secondary"
                  aria-label={imageCaption(item) || t("media_page.image.view")}
                >
                  <img
                    src={item.thumbnailUrl || item.publicUrl}
                    alt={imageCaption(item)}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  {imageCaption(item) && (
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-left text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                      {imageCaption(item)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <Lightbox
        open={lightboxIndex >= 0}
        index={lightboxIndex}
        close={() => setLightboxIndex(-1)}
        plugins={[Zoom]}
        slides={flat.map((item) => ({
          src: item.publicUrl || item.thumbnailUrl || "",
          alt: imageCaption(item),
          description: imageCaption(item),
        }))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits.
// ---------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <div className="wauto flex flex-col items-center gap-2 rounded-2xl bg-w p-10 text-center">
      <i className="ri-image-line text-4xl text-neutral-300 dark:text-neutral-600" />
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{message}</p>
    </div>
  );
}

const TAB_META: Record<MediaTypeFilter, { icon: string; labelKey: string }> = {
  video: { icon: "ri-video-line", labelKey: "media_page.tabs.video" },
  audio: { icon: "ri-music-2-line", labelKey: "media_page.tabs.audio" },
  image: { icon: "ri-image-line", labelKey: "media_page.tabs.image" },
};

const MEDIA_TYPES: readonly MediaTypeFilter[] = ["video", "audio", "image"];

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export function MediaCenterPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const searchParams = new URLSearchParams(useSearch());
  const type = parseMediaType(searchParams.get("type"));
  const playId = searchParams.get("play") ?? undefined;

  const [filters, setFilters] = useState<MediaFilters>({ ...EMPTY_MEDIA_FILTERS });
  const [page, setPage] = useState(1);
  const [storyOptions, setStoryOptions] = useState<MediaStoryOption[]>([]);
  const seenTypesRef = useRef<Set<MediaTypeFilter>>(new Set());

  const limit = tryInt(siteConfig.pageSize, searchParams.get("limit"));
  const filtersKey = JSON.stringify({
    storyId: filters.storyId,
    year: filters.year,
    minDuration: filters.minDuration,
    maxDuration: filters.maxDuration,
    updated: updatedFilterToParam(filters.updated),
  });

  interface MediaFiltersWire {
    storyId?: string;
    year?: number;
    minDuration?: number;
    maxDuration?: number;
    updated?: boolean;
  }

  const load = useCallback(() => {
    const parsed = JSON.parse(filtersKey) as MediaFiltersWire;
    return client.mediaCenter.listMedia({
      type,
      storyId: parsed.storyId || undefined,
      year: parsed.year,
      minDuration: parsed.minDuration,
      maxDuration: parsed.maxDuration,
      updated: parsed.updated,
      page,
      limit,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, filtersKey, page, limit]);

  const { data, error, loading } = useApiResource<MediaCenterListResponse>(load);

  const items = useMemo(() => (Array.isArray(data?.data) ? data.data : []), [data]);

  // Accumulate distinct story options across pages for the theme dropdown.
  useEffect(() => {
    if (items.length === 0) return;
    setStoryOptions((current) => {
      const merged = new Map(current.map((option) => [option.storyId, option]));
      for (const option of distinctStoryOptions(items)) {
        if (!merged.has(option.storyId)) merged.set(option.storyId, option);
      }
      return [...merged.values()].sort((a, b) => a.storyTitle.localeCompare(b.storyTitle));
    });
  }, [items]);

  // Reset pagination when the kind or filters change.
  useEffect(() => {
    setPage(1);
  }, [type, filtersKey]);

  // Aggregated view event, once per kind per session.
  useEffect(() => {
    if (!seenTypesRef.current.has(type)) {
      seenTypesRef.current.add(type);
      trackEvent.track({ type: "media_view", storyId: `media:${type}` });
    }
  }, [type]);

  const title = t("media_page.title");

  return (
    <>
      <Helmet>
        <title>{`${title} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={title} />
        <meta property="og:image" content={siteConfig.avatar} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={document.URL} />
      </Helmet>
      <main className="w-full flex flex-col justify-center items-center mb-8">
        <div className="wauto text-start t-primary py-4">
          <h1 className="text-4xl font-bold">{title}</h1>
          <div className="mt-3 inline-flex rounded-full bg-secondary p-1" role="tablist" aria-label={title}>
            {MEDIA_TYPES.map((kind) => (
              <Link
                key={kind}
                href={`/media?type=${kind}`}
                role="tab"
                aria-selected={type === kind}
                className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  type === kind ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
                }`}
              >
                <i className={TAB_META[kind].icon} />
                {t(TAB_META[kind].labelKey)}
              </Link>
            ))}
          </div>
          {typeof data?.size === "number" && (
            <p className="mt-2 text-sm text-neutral-500 font-normal">
              {t("article.total$count", { count: data.size })}
            </p>
          )}
        </div>

        <FilterBar
          filters={filters}
          onChange={(next) => {
            setFilters(next);
          }}
          storyOptions={storyOptions}
        />

        {error && (
          <div className="wauto mb-4">
            <Tips value={String(error)} type="error" />
          </div>
        )}

        <Waiting for={!loading}>
          {type === "video" && <VideoSection items={items} />}
          {type === "audio" && <AudioSection items={items} playId={playId} />}
          {type === "image" && <ImageSection items={items} />}
          <div className="wauto flex flex-row items-center mt-4 ani-show">
            {page > 1 && (
              <button
                type="button"
                onClick={() => setPage(page - 1)}
                className="text-sm font-normal rounded-full px-4 py-2 text-white bg-theme"
              >
                {t("previous")}
              </button>
            )}
            <div className="flex-1" />
            {data?.hasNext && (
              <button
                type="button"
                onClick={() => setPage(page + 1)}
                className="text-sm font-normal rounded-full px-4 py-2 text-white bg-theme"
              >
                {t("next")}
              </button>
            )}
          </div>
        </Waiting>
      </main>
    </>
  );
}
