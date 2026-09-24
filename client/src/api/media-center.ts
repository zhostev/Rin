// Stage 3 public media center API client.
//
// This module pins the frontend side of the backend contract being built in
// parallel by the backend team (server/ is owned by them; do not touch).
// Base path /api (public, no admin auth):
//
//   GET /api/media?type=video|audio|image&storyId=&year=&minDuration=&maxDuration=&updated=&page=&limit=
//       200 -> { size, data: MediaCenterItem[], hasNext }
//       item: { id, kind, title, duration, width, height, streamUid,
//               streamStatus, thumbnailUrl, publicUrl, storyId, storySlug,
//               storyTitle, year, updatedAt }  (camelCase wire shape)
//   GET /api/series/:slug
//       200 -> { series: { id, slug, title, summary },
//                stories: [{ storyId, slug, title, status, position,
//                            publishedAt, updatedAt, coverUrl? }],
//                completion: { total, published },
//                recentUpdates: [...] }
//   GET /api/search/:keyword (extended)
//       200 -> FeedListResponse & { transcripts?: TranscriptHit[] }
//       transcripts: [{ assetId, storyId, storySlug, storyTitle, snippet,
//                       segments: [{ start, end, text }] }]
//   POST /api/events
//       body { type: 'video_play'|'audio_play'|'story_read'|'media_view',
//              assetId?, storyId? }  (aggregated analytics, no PII)
//
// Stream credentials may still be unavailable (user-side TODO): a video item
// whose streamStatus is not "ready" must degrade to a poster + transcoding
// card — never a white screen or an error. The StreamPlayer state machine
// (components/stream-player.tsx) already encodes this.

import type { ApiResponse, FeedListResponse } from "@rin/api";
import type { StoryHttp } from "./story";

/** Media kinds served by the public media center. One page, switched by type. */
export type MediaCenterKind = "video" | "audio" | "image";

/** Optional chapter entry on a video item (backend may omit). */
export interface MediaCenterChapter {
  /** start offset in seconds */
  start: number;
  /** end offset in seconds */
  end?: number;
  title?: string;
}

/** One row of GET /api/media (camelCase wire shape). */
export interface MediaCenterItem {
  id: number | string;
  kind: MediaCenterKind;
  title?: string;
  /** seconds */
  duration?: number;
  width?: number;
  height?: number;
  streamUid?: string;
  /** e.g. "uploading" | "processing" | "ready" | "error"; absent => treat as ready when playable */
  streamStatus?: string;
  thumbnailUrl?: string;
  /** "r2" | "stream" | "external" — tells the player which renderer to use */
  source?: string;
  /** R2 video chain: poster / subtitles derived URLs */
  posterUrl?: string;
  subtitlesUrl?: string;
  /** public playback / full-size URL */
  publicUrl?: string;
  storyId?: number | string;
  storySlug?: string;
  storyTitle?: string;
  year?: number;
  updatedAt?: string;
  /** image caption / alt text (backend may omit; falls back to title) */
  caption?: string;
  alt?: string;
  /** video chapters (backend may omit) */
  chapters?: MediaCenterChapter[];
}

export interface MediaCenterListResponse {
  size: number;
  data: MediaCenterItem[];
  hasNext: boolean;
}

export interface MediaCenterListParams {
  type: MediaCenterKind;
  storyId?: number | string;
  year?: number;
  minDuration?: number;
  maxDuration?: number;
  /** tri-state: true = only updated, false = only not updated, undefined = all */
  updated?: boolean;
  page?: number;
  limit?: number;
}

export interface SeriesInfo {
  id: number | string;
  slug: string;
  title: string;
  summary?: string;
}

export interface SeriesStoryEntry {
  storyId: number | string;
  slug: string;
  title: string;
  status: string;
  position: number;
  publishedAt?: string;
  updatedAt?: string;
  coverUrl?: string;
}

export interface SeriesRecentUpdate {
  storyId?: number | string;
  slug?: string;
  title?: string;
  updatedAt?: string;
  kind?: string;
}

export interface SeriesDetailResponse {
  series: SeriesInfo;
  stories: SeriesStoryEntry[];
  completion: { total: number; published: number };
  recentUpdates: SeriesRecentUpdate[];
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptHit {
  assetId: number | string;
  storyId: number | string;
  storySlug: string;
  storyTitle: string;
  snippet: string;
  segments: TranscriptSegment[];
}

/** GET /api/search/:keyword response once the backend ships the transcripts extension. */
export type SearchWithTranscripts = FeedListResponse & {
  transcripts?: TranscriptHit[];
};

export type AnalyticsEventType = "video_play" | "audio_play" | "story_read" | "media_view";

export interface AnalyticsEventBody {
  type: AnalyticsEventType;
  assetId?: number | string;
  storyId?: number | string;
}

export class MediaCenterAPI {
  constructor(private http: StoryHttp) {}

  /**
   * List public media assets, filtered, paginated.
   * Mirrors the backend contract; only non-empty params are sent.
   */
  async listMedia(params: MediaCenterListParams): Promise<ApiResponse<MediaCenterListResponse>> {
    const searchParams = new URLSearchParams();
    searchParams.set("type", params.type);
    if (params.storyId !== undefined && params.storyId !== "") {
      searchParams.set("storyId", String(params.storyId));
    }
    if (params.year) searchParams.set("year", String(params.year));
    if (params.minDuration) searchParams.set("minDuration", String(params.minDuration));
    if (params.maxDuration) searchParams.set("maxDuration", String(params.maxDuration));
    if (params.updated !== undefined) searchParams.set("updated", params.updated ? "true" : "false");
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));
    return this.http.get<MediaCenterListResponse>(`/api/media?${searchParams.toString()}`);
  }

  /** Fetch a series (专题) by slug: ordered stories, completion, recent updates. */
  async getSeries(slug: string): Promise<ApiResponse<SeriesDetailResponse>> {
    return this.http.get<SeriesDetailResponse>(`/api/series/${encodeURIComponent(slug)}`);
  }

  /**
   * Fire an aggregated analytics event. No PII. Callers must dedupe/throttle
   * (see utils/analytics.ts) and treat failure as silent.
   */
  async trackEvent(body: AnalyticsEventBody): Promise<ApiResponse<unknown>> {
    return this.http.post<unknown>("/api/events", body);
  }
}
