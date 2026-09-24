// Stage 2 media stack API client (admin).
//
// This module pins the frontend side of the backend contract
// (server/src/services/media.ts, base path /api/admin/media, admin auth):
//
//   POST /api/admin/media/stream/direct-upload
//       JSON body { filename, maxDurationSeconds?, meta? }
//       201 -> { asset: MediaAsset, uploadURL }          (TUS direct-upload URL)
//   GET  /api/admin/media/stream/:uid
//       200 -> MediaAsset (asset itself, latest stream_status; also syncs state)
//   POST /api/admin/media/images/direct-upload          (no body)
//       201 -> { asset: MediaAsset, uploadURL }          (PUT bytes to uploadURL)
//   POST /api/admin/media/images/:id/finalize           (:id = asset.images_id)
//       200 -> MediaAsset
//   POST /api/admin/media/audio                         (multipart: file*, title?)
//       201 -> MediaAsset                               (asset.url is /api/blob/<key>)
//   GET  /api/admin/media?kind=video|audio|image|gallery|attachment&page=&limit=
//       200 -> { size, data: MediaAsset[], hasNext }
//   DELETE /api/admin/media/:id
//       200 -> plain text "Deleted"
//
// File bytes never pass through these JSON endpoints: the browser uploads
// directly to the returned uploadURL (Stream via TUS, Images via PUT) or
// posts multipart to /api/admin/media/audio (XHR, for progress events).
//
// Errors: backend returns 503 { error: { code: 'stream_not_configured' |
// 'images_not_configured' | 'storage_not_configured', message } } when the
// credentials are not configured, 502 when the upstream Cloudflare call
// fails, 400 plain text on bad params. The HttpClient surfaces those as
// { error: { status, value } }; upload UI should map status 503 to the
// "not configured" message (see isNotConfiguredError) instead of crashing.

import type { ApiResponse } from "@rin/api";
import type { MediaAsset, StoryHttp } from "./story";
import { getAuthToken } from "../utils/auth";
import { endpoint } from "../config";

/** Body for POST /api/admin/media/stream/direct-upload. */
export interface StreamDirectUploadRequest {
  /** real filename; stored as the asset title */
  filename: string;
  /** optional cap in whole seconds; must be a positive integer */
  maxDurationSeconds?: number;
  /** optional string-only metadata forwarded to Stream */
  meta?: Record<string, string>;
}

export interface StreamDirectUploadResponse {
  asset: MediaAsset;
  uploadURL: string;
}

export interface ImageDirectUploadResponse {
  asset: MediaAsset;
  uploadURL: string;
}

export interface MediaListResponse {
  size: number;
  data: MediaAsset[];
  hasNext: boolean;
}

export type MediaListKind = "image" | "video" | "audio" | "gallery" | "attachment";

export interface MediaListParams {
  page?: number;
  limit?: number;
}

/** Minimal shape of the error object the HttpClient produces on HTTP failures. */
export interface MediaApiError {
  status?: number;
  value?: unknown;
}

/**
 * True when the backend reported 503: the Cloudflare credentials behind
 * this upload service are not configured server-side. Upload UI should show
 * the localized "not configured" hint instead of a raw error.
 */
export function isNotConfiguredError(error: MediaApiError | null | undefined): boolean {
  return error?.status === 503;
}

/** Error thrown by uploadAudio on HTTP failures; carries the HTTP status. */
export class MediaUploadError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MediaUploadError";
    this.status = status;
  }
}

export class MediaAPI {
  constructor(private http: StoryHttp) {}

  /**
   * Mint a Stream direct-upload session: POSTs { filename, ... } and gets
   * back the provisional asset plus the one-time TUS uploadURL. The browser
   * then TUS-uploads the file to uploadURL and polls getStreamAsset(uid).
   */
  async createStreamDirectUpload(
    body: StreamDirectUploadRequest,
  ): Promise<ApiResponse<StreamDirectUploadResponse>> {
    return this.http.post<StreamDirectUploadResponse>(
      "/api/admin/media/stream/direct-upload",
      body,
    );
  }

  /**
   * Fetch the latest asset snapshot for a Stream upload by stream_uid.
   * The backend syncs the transcode state with Stream before responding,
   * so this doubles as the polling endpoint for "ready".
   */
  async getStreamAsset(streamUid: string): Promise<ApiResponse<MediaAsset>> {
    return this.http.get<MediaAsset>(
      `/api/admin/media/stream/${encodeURIComponent(streamUid)}`,
    );
  }

  /** Mint a Cloudflare Images direct-upload URL; the browser then PUTs the file to uploadURL. */
  async createImageDirectUpload(): Promise<ApiResponse<ImageDirectUploadResponse>> {
    return this.http.post<ImageDirectUploadResponse>("/api/admin/media/images/direct-upload");
  }

  /**
   * Tell the backend the Images upload finished (after the PUT to uploadURL);
   * returns the finalized asset (with images_variants). `:id` is the
   * asset's images_id from the direct-upload response.
   */
  async finalizeImage(imagesId: string): Promise<ApiResponse<MediaAsset>> {
    return this.http.post<MediaAsset>(
      `/api/admin/media/images/${encodeURIComponent(imagesId)}/finalize`,
    );
  }

  /** List media library assets, optionally filtered by kind, paginated. */
  async list(kind?: MediaListKind, params?: MediaListParams): Promise<ApiResponse<MediaListResponse>> {
    const searchParams = new URLSearchParams();
    if (kind) searchParams.set("kind", kind);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const query = searchParams.toString();
    return this.http.get<MediaListResponse>(`/api/admin/media${query ? `?${query}` : ""}`);
  }

  /** Delete a media asset. Responds 200 with plain text "Deleted". */
  async remove(id: number | string): Promise<ApiResponse<string>> {
    return this.http.delete<string>(`/api/admin/media/${encodeURIComponent(String(id))}`);
  }

  /**
   * Upload an audio file as multipart/form-data with progress events.
   * Implemented on raw XMLHttpRequest (not the JSON HttpClient) so the
   * caller gets upload progress; the same auth token is attached.
   * The backend responds 201 with the MediaAsset itself.
   * Rejects with MediaUploadError (carries .status) on HTTP failures.
   */
  uploadAudio(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    title?: string,
  ): Promise<MediaAsset> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${endpoint}/api/admin/media/audio`);
      const token = getAuthToken();
      if (token) {
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      }
      const formData = new FormData();
      formData.append("file", file, file.name);
      if (title) {
        formData.append("title", title);
      }
      if (onProgress) {
        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            onProgress(event.loaded, event.total);
          }
        });
      }
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText) as
              | { asset?: MediaAsset }
              | MediaAsset;
            const asset = (body as { asset?: MediaAsset }).asset ?? (body as MediaAsset);
            if (!asset || typeof asset.id !== "number" || typeof asset.kind !== "string") {
              reject(new MediaUploadError("Invalid response from /api/admin/media/audio", xhr.status));
              return;
            }
            resolve(asset);
          } catch {
            reject(new MediaUploadError("Invalid response from /api/admin/media/audio", xhr.status));
          }
        } else if (xhr.status === 503) {
          reject(
            new MediaUploadError("Upload service is not configured on the server", xhr.status),
          );
        } else {
          reject(new MediaUploadError(`Audio upload failed (HTTP ${xhr.status})`, xhr.status));
        }
      });
      xhr.addEventListener("error", () => reject(new MediaUploadError("Audio upload network error", 0)));
      xhr.addEventListener("abort", () => reject(new MediaUploadError("Audio upload aborted", 0)));
      xhr.send(formData);
    });
  }
}

export interface PollStreamOptions {
  intervalMs?: number;
  maxAttempts?: number;
  /** injectable sleep for tests */
  sleep?: (ms: number) => Promise<void>;
  /** called with every polled asset snapshot (status badge updates) */
  onStatus?: (asset: MediaAsset) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll GET /api/admin/media/stream/:uid until the asset is ready/error,
 * or the attempt budget is exhausted (caller then tells the user to wait
 * for the webhook and keeps the uploading/processing asset in the payload).
 * Throws on transport errors and on terminal "error" stream_status.
 */
export async function pollStreamUntilReady(
  getAsset: (streamUid: string) => Promise<ApiResponse<MediaAsset>>,
  streamUid: string,
  options: PollStreamOptions = {},
): Promise<MediaAsset> {
  const { intervalMs = 2500, maxAttempts = 48, sleep = defaultSleep, onStatus } = options;
  let last: MediaAsset | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { data, error } = await getAsset(streamUid);
    if (error || !data) {
      throw new Error(typeof error?.value === "string" ? error.value : "Failed to fetch Stream status");
    }
    last = data;
    onStatus?.(data);
    if (data.stream_status === "ready") {
      return data;
    }
    if (data.stream_status === "error") {
      throw new Error(data.stream_error || "Cloudflare Stream reported an error");
    }
    // uploading / processing / unknown -> keep waiting
    await sleep(intervalMs);
  }
  throw new Error(
    `Stream is still ${last?.stream_status ?? "processing"} after ${maxAttempts} checks; it will finish in the background.`,
  );
}
