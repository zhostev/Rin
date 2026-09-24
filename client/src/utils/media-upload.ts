// Media upload helpers for the Markdown editor (paste/drop) and the media picker.
//
// Upload strategy (R2-first; Cloudflare Stream/Images stay disabled per user decision):
//
//   image/video/audio → POST /api/admin/media/r2/direct-upload (mint a
//           one-time presigned PUT URL + provisional asset) → PUT bytes
//           straight to R2 → POST /api/admin/media/r2/:id/complete
//
//   The browser PUT bypasses the Worker, so the 100MB Worker request-body cap
//   no longer applies (video ≤ 5GB, audio ≤ 1GB, image ≤ 10MB).
//
//   When the backend has no S3 credentials (503 r2_direct_upload_not_configured),
//   audio/video fall back to the legacy Worker-proxied multipart upload
//   (POST /api/admin/media/audio|video, ≤100MB). Images have no legacy R2 path.
//
// File bytes never pass through the JSON HttpClient.
// Cloudflare Stream TUS upload code is kept in ./stream-upload.ts as a manual
// fallback, but it is no longer the default upload path.

import type { MediaType } from "@rin/api";
import type { MediaAsset } from "../api/story";
import { client } from "../app/runtime";
import { isNotConfiguredError } from "../api/media";
import { endpoint } from "../config";
import { generateImageMetadata, type UploadedImageResult } from "./image-upload";
import { probeMediaFile } from "./media-probe";
import { uploadFileRaw } from "./upload-xhr";

export const R2_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** R2 presigned direct-upload caps (R2 single PUT max is 5GB). */
export const R2_DIRECT_MAX_BYTES = {
  image: 10 * 1024 * 1024,
  video: 5 * 1024 * 1024 * 1024,
  audio: 1024 * 1024 * 1024,
} as const;

export type R2DirectUploadKind = keyof typeof R2_DIRECT_MAX_BYTES;

export type UploadedMediaResult = {
  asset: MediaAsset;
  provider: "r2" | "stream";
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

type UploadMediaOptions = {
  t: Translate;
  onProgress?: (percent: number | null) => void;
};

export interface R2DirectUploadFileOptions extends UploadMediaOptions {
  title?: string;
  duration?: number;
  width?: number;
  height?: number;
}

export function detectMediaType(file: File): MediaType | null {
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  return null;
}

/** Build an Error that carries the HTTP status (for 503 → legacy fallback). */
function httpStatusError(message: string, status?: number): Error {
  const error = new Error(message);
  (error as { status?: number }).status = status;
  return error;
}

function sizeLimitMessage(t: Translate, capBytes: number): string {
  if (capBytes >= 1024 * 1024 * 1024) {
    return t("upload.failed$sizeGB", { size: capBytes / 1024 / 1024 / 1024 });
  }
  return t("upload.failed$size", { size: capBytes / 1024 / 1024 });
}

/**
 * Shared R2 presigned direct upload: mint → PUT bytes straight to R2 →
 * complete. Throws on any step; a failed PUT/complete deletes the provisional
 * asset row (the DELETE route also removes the R2 object when present).
 */
export async function uploadR2DirectFile(
  file: File,
  kind: R2DirectUploadKind,
  options: R2DirectUploadFileOptions,
): Promise<MediaAsset> {
  const { t, onProgress, title, duration, width, height } = options;
  const cap = R2_DIRECT_MAX_BYTES[kind];
  if (file.size > cap) {
    throw new Error(sizeLimitMessage(t, cap));
  }

  // 1. mint a one-time PUT URL + provisional asset row (stream_status=uploading)
  const minted = await client.media.createR2DirectUpload({
    kind,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    ...(title ? { title } : {}),
    ...(typeof duration === "number" ? { duration } : {}),
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
  });
  if (minted.error || !minted.data?.uploadURL) {
    const status = minted.error?.status ?? "?";
    const code =
      typeof minted.error?.value === "object" && minted.error?.value !== null
        ? (minted.error.value as { code?: string }).code
        : undefined;
    throw httpStatusError(
      t("upload.failed$step", {
        step: code ? `direct-upload:${code}` : "direct-upload",
        status,
      }),
      minted.error?.status,
    );
  }
  const assetId = minted.data.asset.id;

  // 2. PUT the bytes straight to R2 (bypasses the Worker: no 100MB cap)
  let putStatus = 0;
  try {
    const { status } = await uploadFileRaw(minted.data.uploadURL, file, {
      method: "PUT",
      headers: file.type ? { "Content-Type": file.type } : undefined,
      onProgress: (loaded, total) => {
        if (total > 0) {
          onProgress?.(Math.round((loaded / total) * 100));
        }
      },
    });
    putStatus = status;
  } catch {
    putStatus = 0;
  }
  if (putStatus < 200 || putStatus >= 300) {
    await client.media.remove(assetId).catch(() => {});
    throw new Error(t("upload.failed$step", { step: "r2-put", status: putStatus }));
  }

  // 3. complete: backend HEADs the object and marks the asset ready
  const completed = await client.media.completeR2DirectUpload(assetId);
  if (completed.error || !completed.data) {
    await client.media.remove(assetId).catch(() => {});
    const status = completed.error?.status ?? "?";
    const code =
      typeof completed.error?.value === "object" && completed.error?.value !== null
        ? (completed.error.value as { code?: string }).code
        : undefined;
    throw httpStatusError(
      t("upload.failed$step", {
        step: code ? `complete:${code}` : "complete",
        status,
      }),
      completed.error?.status,
    );
  }
  return completed.data;
}

/** Legacy Worker-proxied video upload (multipart XHR, progress events). */
async function legacyUploadVideo(file: File, { t, onProgress }: UploadMediaOptions): Promise<MediaAsset> {
  if (file.size > R2_MEDIA_MAX_BYTES) {
    throw new Error(t("upload.failed$size", { size: R2_MEDIA_MAX_BYTES / 1024 / 1024 }));
  }
  // Duration/dimensions are probed client-side and sent along so the backend
  // can store them without server-side transcoding.
  const probed = await probeMediaFile(file).catch(() => null);
  return client.media.uploadVideo(
    file,
    (loaded, total) => {
      if (total > 0) {
        onProgress?.(Math.round((loaded / total) * 100));
      }
    },
    {
      title: file.name,
      duration: probed?.duration,
      width: probed?.width,
      height: probed?.height,
    },
  );
}

/** Legacy Worker-proxied audio upload (multipart XHR, progress events). */
async function legacyUploadAudio(file: File, { t, onProgress }: UploadMediaOptions): Promise<MediaAsset> {
  if (file.size > R2_MEDIA_MAX_BYTES) {
    throw new Error(t("upload.failed$size", { size: R2_MEDIA_MAX_BYTES / 1024 / 1024 }));
  }
  return client.media.uploadAudio(
    file,
    (loaded, total) => {
      if (total > 0) {
        onProgress?.(Math.round((loaded / total) * 100));
      }
    },
    file.name,
  );
}

export async function uploadMediaFile(
  file: File,
  type: MediaType,
  options: UploadMediaOptions,
): Promise<UploadedMediaResult> {
  // R2 presigned direct upload first (no 100MB Worker cap). When the backend
  // reports 503 (no S3 credentials), fall back to the legacy proxied upload
  // for audio/video; images have no legacy R2 path (Images stays disabled).
  try {
    if (type === "video") {
      const probed = await probeMediaFile(file).catch(() => null);
      const asset = await uploadR2DirectFile(file, "video", {
        ...options,
        title: file.name,
        duration: probed?.duration,
        width: probed?.width,
        height: probed?.height,
      });
      return { asset, provider: "r2" };
    }
    if (type === "audio") {
      const asset = await uploadR2DirectFile(file, "audio", { ...options, title: file.name });
      return { asset, provider: "r2" };
    }
    const asset = await uploadR2DirectFile(file, "image", { ...options, title: file.name });
    return { asset, provider: "r2" };
  } catch (error) {
    if (!isNotConfiguredError(error as { status?: number })) {
      throw error;
    }
    if (type === "video") {
      return { asset: await legacyUploadVideo(file, options), provider: "r2" };
    }
    if (type === "audio") {
      return { asset: await legacyUploadAudio(file, options), provider: "r2" };
    }
    throw error;
  }
}

/** Absolute playback URL, so content stays valid in RSS and other off-site renderers. */
export function mediaPlaybackUrl(id: string) {
  const base = endpoint || (typeof window === "undefined" ? "" : window.location.origin);
  return `${base}/api/media/${encodeURIComponent(id)}/playback`;
}

/**
 * Upload an image into the media library and return the URL to embed.
 * Images uploaded this way are managed (and reference-checked) like audio and video.
 */
export async function uploadImageToLibrary(
  file: File,
  options: UploadMediaOptions,
): Promise<UploadedImageResult & { asset: MediaAsset }> {
  const [uploadResult, metadataResult] = await Promise.allSettled([
    uploadMediaFile(file, "image", options),
    generateImageMetadata(file),
  ]);

  if (uploadResult.status === "rejected") {
    throw uploadResult.reason instanceof Error
      ? uploadResult.reason
      : new Error(options.t("upload.failed"));
  }

  return {
    asset: uploadResult.value.asset,
    url: mediaPlaybackUrl(String(uploadResult.value.asset.id)),
    ...(metadataResult.status === "fulfilled" ? metadataResult.value : {}),
  };
}
