// VideoBlock: metadata form for a video content block.
//
// Upload flow (Stage 2):
//   1. POST /api/admin/media/stream/direct-upload { filename } mints a
//      one-time TUS URL (+ the provisional asset with stream_uid). The
//      browser TUS-uploads the file straight to Cloudflare Stream
//      (tus-js-client, resumable, progress bar).
//   2. The client polls GET /api/admin/media/stream/{stream_uid} until
//      Stream reports "ready", then writes the final asset (with embed_url /
//      thumbnail_url) into the payload. The provisional asset is written
//      first so the story shows a "transcoding" state even if the editor is
//      closed early.
// Existing Stream assets can also be picked via MediaPicker.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { client } from "../../app/runtime";
import type { MediaAsset, VideoPayload } from "../../api/story";
import { pollStreamUntilReady, isNotConfiguredError } from "../../api/media";
import { startStreamUpload, type StreamUploadHandle } from "../../utils/stream-upload";
import { MediaPicker } from "./media-picker";
import { formatDuration } from "./block-utils";

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

type UploadPhase = "idle" | "minting" | "uploading" | "processing" | "error";

interface UploadState {
  phase: UploadPhase;
  progress: number; // 0..1
  message?: string;
}

const IDLE_UPLOAD: UploadState = { phase: "idle", progress: 0 };

export function VideoBlock({
  payload,
  onChange,
}: {
  payload: VideoPayload;
  onChange: (patch: Partial<VideoPayload>) => void;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [upload, setUpload] = useState<UploadState>(IDLE_UPLOAD);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeUploadRef = useRef<StreamUploadHandle | null>(null);
  const cancelledRef = useRef(false);
  const asset = payload.asset;

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      activeUploadRef.current?.abort();
      activeUploadRef.current = null;
    };
  }, []);

  function selectAsset(next: MediaAsset) {
    onChange({
      asset: next,
      asset_id: next.id || undefined,
      stream_uid: next.stream_uid ?? payload.stream_uid,
    });
  }

  async function handleFile(file: File) {
    if (upload.phase === "minting" || upload.phase === "uploading" || upload.phase === "processing") {
      return;
    }
    setUpload({ phase: "minting", progress: 0 });
    try {
      const { data, error } = await client.media.createStreamDirectUpload({ filename: file.name });
      if (error || !data?.uploadURL) {
        throw new Error(
          isNotConfiguredError(error)
            ? t("story.editor.picker.not_configured")
            : typeof error?.value === "string"
              ? error.value
              : t("story.editor.stream_failed"),
        );
      }
      const uploadURL = data.uploadURL;
      // Provisional asset: the backend already created the row with
      // stream_uid and stream_status "uploading"; playback keys off the
      // asset's embed_url once the transcode finishes. Keeping the
      // provisional asset in the payload means the story shows a
      // "transcoding" state even if the editor is closed early.
      const provisional: MediaAsset = {
        ...data.asset,
        title: data.asset.title || file.name,
        mime: data.asset.mime || file.type || undefined,
        stream_status: data.asset.stream_status ?? "uploading",
      };
      const assetId = provisional.id;
      const streamUid = provisional.stream_uid;
      if (!streamUid) {
        throw new Error(t("story.editor.stream_failed"));
      }
      if (!cancelledRef.current) {
        onChange({ asset: provisional, asset_id: assetId, stream_uid: provisional.stream_uid });
        setUpload({ phase: "uploading", progress: 0 });
      }

      const handle = startStreamUpload(file, uploadURL, {
        onProgress: (bytesUploaded, bytesTotal) => {
          if (!cancelledRef.current && bytesTotal > 0) {
            setUpload({ phase: "uploading", progress: bytesUploaded / bytesTotal });
          }
        },
      });
      activeUploadRef.current = handle;
      await handle.done;
      activeUploadRef.current = null;
      if (cancelledRef.current) return;

      setUpload({ phase: "processing", progress: 1 });
      try {
        const ready = await pollStreamUntilReady(
          (uid) => client.media.getStreamAsset(uid),
          streamUid,
        );
        if (cancelledRef.current) return;
        const finalAsset: MediaAsset = { ...ready, title: ready.title || file.name };
        onChange({ asset: finalAsset, asset_id: assetId, stream_uid: finalAsset.stream_uid });
        setUpload(IDLE_UPLOAD);
      } catch (pollError) {
        // Transcoding takes longer than the poll budget: the provisional
        // asset stays in the payload and Stream's webhook finishes it.
        if (cancelledRef.current) return;
        setUpload({
          phase: "error",
          progress: 1,
          message: pollError instanceof Error ? pollError.message : String(pollError),
        });
      }
    } catch (err) {
      if (cancelledRef.current) return;
      setUpload({
        phase: "error",
        progress: 0,
        message: err instanceof Error ? err.message : t("story.editor.stream_failed"),
      });
    }
  }

  const uploadLabel =
    upload.phase === "minting"
      ? t("story.editor.stream_minting")
      : upload.phase === "uploading"
        ? t("story.editor.stream_uploading", { percent: Math.round(upload.progress * 100) })
        : upload.phase === "processing"
          ? t("story.editor.stream_transcoding")
          : upload.phase === "error"
            ? upload.message || t("story.editor.stream_failed")
            : "";

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t("story.editor.video_title")}
        </span>
        <input
          type="text"
          value={payload.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder={t("story.editor.video_title_placeholder")}
          className={inputClassName}
        />
      </label>

      <div className="flex flex-col gap-2 rounded-xl bg-secondary p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {t("story.editor.asset")}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={upload.phase !== "idle" && upload.phase !== "error"}
              className="rounded-full bg-theme px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-theme-hover disabled:opacity-60"
            >
              <i className="ri-upload-cloud-2-line mr-1" />
              {t("story.editor.upload_to_stream")}
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="rounded-full border border-black/10 px-4 py-1.5 text-xs font-medium t-secondary transition-colors hover:border-theme/40 hover:text-theme dark:border-white/10"
            >
              {asset ? t("story.editor.change_asset") : t("story.editor.pick_asset")}
            </button>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />

        {upload.phase !== "idle" && (
          <div className="flex flex-col gap-1.5">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(upload.progress * 100)}
            >
              <div
                className={`h-full rounded-full transition-all ${upload.phase === "error" ? "bg-red-500" : "bg-theme"}`}
                style={{ width: `${Math.round(upload.progress * 100)}%` }}
              />
            </div>
            <p className={`text-xs ${upload.phase === "error" ? "text-red-500" : "text-neutral-500 dark:text-neutral-400"}`}>
              {uploadLabel}
            </p>
          </div>
        )}

        {asset ? (
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-black/10 dark:bg-white/10">
              <i className="ri-video-line text-xl text-neutral-500 dark:text-neutral-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium t-primary">{asset.title || asset.url}</p>
              <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                {[asset.mime, typeof asset.duration === "number" ? formatDuration(asset.duration) : undefined,
                  asset.width && asset.height ? `${asset.width}×${asset.height}` : undefined,
                  asset.stream_status ? t(`story.editor.stream_status_${asset.stream_status}`) : undefined]
                  .filter(Boolean)
                  .join(" · ") || t("story.editor.unknown")}
              </p>
            </div>
            <button
              type="button"
              aria-label={t("story.editor.remove_asset")}
              onClick={() => onChange({ asset: undefined, asset_id: undefined, stream_uid: undefined })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/10"
            >
              <i className="ri-close-line" />
            </button>
          </div>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("story.editor.no_asset")}</p>
        )}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t("story.editor.stream_uid")}
        </span>
        <input
          type="text"
          value={payload.stream_uid ?? ""}
          onChange={(e) => onChange({ stream_uid: e.target.value })}
          placeholder={t("story.editor.stream_uid_placeholder")}
          className={inputClassName}
        />
        <span className="text-xs text-neutral-400">{t("story.editor.stream_uid_hint")}</span>
      </label>

      <MediaPicker
        open={pickerOpen}
        kind="video"
        onSelect={selectAsset}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
