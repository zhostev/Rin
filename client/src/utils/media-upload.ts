import type { MediaAsset, MediaType } from "@rin/api";
import * as tus from "tus-js-client";
import { client } from "../app/runtime";
import { endpoint } from "../config";
import { generateImageMetadata, type UploadedImageResult } from "./image-upload";

export const R2_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_STREAM_VIDEO_BYTES = 1024 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const STREAM_UPLOAD_ATTEMPTS = 3;

export type UploadedMediaResult = {
  asset: MediaAsset;
  provider: "r2" | "stream";
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

type UploadMediaOptions = {
  t: Translate;
  onProgress?: (percent: number | null) => void;
};

export function detectMediaType(file: File): MediaType | null {
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  return null;
}

async function uploadStreamVideo(file: File, { t, onProgress }: UploadMediaOptions): Promise<MediaAsset> {
  let uploadedAsset: MediaAsset | undefined;
  let lastUploadError: Error | undefined;

  for (let attempt = 1; attempt <= STREAM_UPLOAD_ATTEMPTS && !uploadedAsset; attempt += 1) {
    // createDirectUpload (FormData POST) is capped at 200MB; use TUS for 100MB–1GB.
    const streamUpload = await client.media.createStreamUpload(file.name, file.size);
    if (streamUpload.error || !streamUpload.data) {
      throw new Error(streamUpload.error?.value || t("upload.media.stream_unavailable"));
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(file, {
          // Pre-provisioned one-time URL from /api/media/stream/upload (direct_user TUS).
          uploadUrl: streamUpload.data!.uploadUrl,
          // CF Stream: min 5MiB chunk unless whole file is smaller; prefer ~50MiB.
          chunkSize: 52_428_800,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          metadata: {
            filename: file.name,
            filetype: file.type || "video/mp4",
          },
          onError: (error) => reject(error instanceof Error ? error : new Error(t("upload.failed"))),
          onProgress: (bytesUploaded, bytesTotal) => {
            if (bytesTotal > 0) {
              onProgress?.(Math.round((bytesUploaded / bytesTotal) * 100));
            }
          },
          onSuccess: () => resolve(),
        });
        upload.start();
      });
      uploadedAsset = streamUpload.data.asset;
    } catch (error) {
      lastUploadError = error instanceof Error ? error : new Error(t("upload.failed"));
    }
    if (!uploadedAsset) await client.media.delete(streamUpload.data.asset.id);
    if (!uploadedAsset && attempt < STREAM_UPLOAD_ATTEMPTS) onProgress?.(0);
  }

  if (!uploadedAsset) throw lastUploadError || new Error(t("upload.failed"));
  return uploadedAsset;
}

export async function uploadMediaFile(
  file: File,
  type: MediaType,
  options: UploadMediaOptions,
): Promise<UploadedMediaResult> {
  const { t } = options;

  if (type === "image" && file.size > MAX_IMAGE_BYTES) {
    throw new Error(t("upload.failed$size", { size: MAX_IMAGE_BYTES / 1024 / 1024 }));
  }

  if (type === "video" && file.size > R2_MEDIA_MAX_BYTES) {
    if (file.size > MAX_STREAM_VIDEO_BYTES) {
      throw new Error(t("upload.media.too_large"));
    }
    return { asset: await uploadStreamVideo(file, options), provider: "stream" };
  }

  const { data, error } = await client.media.upload(file);
  if (error || !data) {
    throw new Error(error?.value || t("upload.failed"));
  }
  return { asset: data, provider: "r2" };
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
    url: mediaPlaybackUrl(uploadResult.value.asset.id),
    ...(metadataResult.status === "fulfilled" ? metadataResult.value : {}),
  };
}
