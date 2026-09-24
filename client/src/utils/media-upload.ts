// Media upload helpers for the Markdown editor (paste/drop).
//
// Wired to the Stage 2 media stack (client/src/api/media.ts):
//
//   image → POST /api/admin/media/images/direct-upload (mint) → PUT bytes to
//           uploadURL → POST /api/admin/media/images/:id/finalize
//   audio → POST /api/admin/media/audio (multipart XHR, progress events)
//   video → POST /api/admin/media/video (R2 multipart XHR, progress events)
//
// File bytes never pass through the JSON HttpClient.
// Cloudflare Stream TUS upload code is kept in ./stream-upload.ts as a manual
// fallback, but it is no longer the default upload path.

import type { MediaType } from "@rin/api";
import type { MediaAsset } from "../api/story";
import { client } from "../app/runtime";
import { endpoint } from "../config";
import { generateImageMetadata, type UploadedImageResult } from "./image-upload";
import { probeMediaFile } from "./media-probe";
import { uploadFileRaw } from "./upload-xhr";

export const R2_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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

async function uploadImageDirect(file: File, { t, onProgress }: UploadMediaOptions): Promise<MediaAsset> {
  // POST /api/admin/media/images/direct-upload mints a one-time PUT URL plus
  // the provisional asset; the browser PUTs the bytes, then finalizes.
  const minted = await client.media.createImageDirectUpload();
  if (minted.error || !minted.data?.uploadURL) {
    throw new Error(minted.error?.value || t("upload.failed"));
  }
  const imagesId = minted.data.asset.images_id;
  if (!imagesId) {
    throw new Error(t("upload.failed"));
  }
  const { status } = await uploadFileRaw(minted.data.uploadURL, file, {
    method: "PUT",
    headers: file.type ? { "Content-Type": file.type } : undefined,
    onProgress: (loaded, total) => {
      if (total > 0) {
        onProgress?.(Math.round((loaded / total) * 100));
      }
    },
  });
  if (status < 200 || status >= 300) {
    await client.media.remove(minted.data.asset.id);
    throw new Error(t("upload.failed"));
  }
  const finalized = await client.media.finalizeImage(imagesId);
  if (finalized.error || !finalized.data) {
    throw new Error(finalized.error?.value || t("upload.failed"));
  }
  return finalized.data;
}

export async function uploadMediaFile(
  file: File,
  type: MediaType,
  options: UploadMediaOptions,
): Promise<UploadedMediaResult> {
  const { t, onProgress } = options;

  if (type === "image" && file.size > MAX_IMAGE_BYTES) {
    throw new Error(t("upload.failed$size", { size: MAX_IMAGE_BYTES / 1024 / 1024 }));
  }

  if (type === "image") {
    return { asset: await uploadImageDirect(file, options), provider: "r2" };
  }

  if (type === "audio") {
    // multipart XHR keeps upload progress events (JSON HttpClient can't).
    const asset = await client.media.uploadAudio(
      file,
      (loaded, total) => {
        if (total > 0) {
          onProgress?.(Math.round((loaded / total) * 100));
        }
      },
      file.name,
    );
    return { asset, provider: "r2" };
  }

  // video: R2 multipart upload (multipart XHR keeps upload progress events).
  // Duration/dimensions are probed client-side and sent along so the backend
  // can store them without server-side transcoding.
  if (file.size > R2_MEDIA_MAX_BYTES) {
    throw new Error(t("upload.failed$size", { size: R2_MEDIA_MAX_BYTES / 1024 / 1024 }));
  }
  const probed = await probeMediaFile(file).catch(() => null);
  const asset = await client.media.uploadVideo(
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
  return { asset, provider: "r2" };
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
