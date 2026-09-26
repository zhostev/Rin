// VideoBlock: metadata form for a video content block.
//
// Upload flow: R2 presigned direct upload via the shared uploadMediaFile
// helper (mint -> PUT bytes straight to R2 -> complete), so large videos
// don't hit the Worker's 100MB request-body cap (HTTP 413). Falls back to
// the legacy Worker-proxied multipart upload when the backend has no S3
// credentials (503).
// Optionally attach a poster image (POST .../poster) and a WebVTT file
// (POST .../subtitles); each can be replaced or removed.
// Existing assets (R2 or Stream) can also be picked via MediaPicker.
// A stream_uid can still be entered manually for Cloudflare Stream assets,
// which keep playing through the StreamPlayer.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { client } from "../../app/runtime";
import type { MediaAsset, VideoPayload } from "../../api/story";
import { uploadMediaFile } from "../../utils/media-upload";
import { MediaPicker } from "./media-picker";
import { formatDuration } from "./block-utils";

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

type UploadPhase = "idle" | "uploading" | "error";

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
  const [busy, setBusy] = useState<"poster" | "subtitles" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const posterRef = useRef<HTMLInputElement>(null);
  const subtitlesRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const asset = payload.asset;
  const isR2Video = !!asset && asset.kind === "video" && asset.source !== "stream" && !asset.stream_uid;

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
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
    if (upload.phase === "uploading") return;
    setUpload({ phase: "uploading", progress: 0 });
    try {
      // R2 presigned direct upload (mint -> PUT -> complete); the browser PUT
      // bypasses the Worker so large videos don't hit the 100MB body cap
      // (HTTP 413). Falls back to the legacy proxied upload when the backend
      // has no S3 credentials (503).
      const { asset: created } = await uploadMediaFile(file, "video", {
        t,
        title: payload.title?.trim() || file.name,
        onProgress: (percent) => {
          if (!cancelledRef.current && percent != null) {
            setUpload({ phase: "uploading", progress: percent / 100 });
          }
        },
      });
      if (cancelledRef.current) return;
      onChange({ asset: created, asset_id: created.id || undefined, stream_uid: undefined });
      setUpload(IDLE_UPLOAD);
    } catch (err) {
      if (cancelledRef.current) return;
      setUpload({
        phase: "error",
        progress: 0,
        message: err instanceof Error ? err.message : t("story.editor.video_upload_failed"),
      });
    }
  }

  async function handlePosterFile(file: File) {
    if (!asset?.id || busy) return;
    setBusy("poster");
    try {
      const updated = await client.media.attachPoster(asset.id, file);
      if (cancelledRef.current) return;
      onChange({ asset: updated });
    } finally {
      if (!cancelledRef.current) setBusy(null);
    }
  }

  async function handleSubtitlesFile(file: File) {
    if (!asset?.id || busy) return;
    setBusy("subtitles");
    try {
      const updated = await client.media.attachSubtitles(asset.id, file);
      if (cancelledRef.current) return;
      onChange({ asset: updated });
    } finally {
      if (!cancelledRef.current) setBusy(null);
    }
  }

  async function handleRemovePoster() {
    if (!asset?.id || busy) return;
    setBusy("poster");
    try {
      const { error } = await client.media.detachPoster(asset.id);
      if (cancelledRef.current) return;
      if (!error) {
        onChange({
          asset: { ...asset, poster_asset_id: undefined, poster_url: undefined },
        });
      }
    } finally {
      if (!cancelledRef.current) setBusy(null);
    }
  }

  async function handleRemoveSubtitles() {
    if (!asset?.id || busy) return;
    setBusy("subtitles");
    try {
      const { error } = await client.media.detachSubtitles(asset.id);
      if (cancelledRef.current) return;
      if (!error) {
        onChange({
          asset: { ...asset, subtitles_asset_id: undefined, subtitles_url: undefined },
        });
      }
    } finally {
      if (!cancelledRef.current) setBusy(null);
    }
  }

  const uploadLabel =
    upload.phase === "uploading"
      ? t("story.editor.video_uploading", { percent: Math.round(upload.progress * 100) })
      : upload.phase === "error"
        ? upload.message || t("story.editor.video_upload_failed")
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
              disabled={upload.phase === "uploading"}
              className="rounded-full bg-theme px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-theme-hover disabled:opacity-60"
            >
              <i className="ri-upload-cloud-2-line mr-1" />
              {t("story.editor.upload_video")}
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
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/10 dark:bg-white/10">
              {asset.poster_url ? (
                <img src={asset.poster_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <i className="ri-video-line text-xl text-neutral-500 dark:text-neutral-400" />
              )}
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

        {isR2Video && (
          <div className="flex flex-col gap-2 border-t border-black/5 pt-2 dark:border-white/5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {t("story.editor.poster")}
              </span>
              <div className="flex items-center gap-2">
                {asset.poster_url && (
                  <button
                    type="button"
                    onClick={() => void handleRemovePoster()}
                    disabled={busy === "poster"}
                    className="text-xs text-neutral-400 hover:text-red-500 disabled:opacity-60"
                  >
                    {t("story.editor.remove_poster")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => posterRef.current?.click()}
                  disabled={busy === "poster"}
                  className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium t-secondary transition-colors hover:border-theme/40 hover:text-theme disabled:opacity-60 dark:border-white/10"
                >
                  {busy === "poster" ? t("story.editor.uploading") : t("story.editor.upload_poster")}
                </button>
              </div>
            </div>
            <input
              ref={posterRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handlePosterFile(file);
              }}
            />

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {t("story.editor.subtitles")}
              </span>
              <div className="flex items-center gap-2">
                {asset.subtitles_url && (
                  <span className="max-w-32 truncate text-xs text-neutral-400">
                    {decodeURIComponent(asset.subtitles_url.split("/").pop() ?? "")}
                  </span>
                )}
                {asset.subtitles_url && (
                  <button
                    type="button"
                    onClick={() => void handleRemoveSubtitles()}
                    disabled={busy === "subtitles"}
                    className="text-xs text-neutral-400 hover:text-red-500 disabled:opacity-60"
                  >
                    {t("story.editor.remove_subtitles")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => subtitlesRef.current?.click()}
                  disabled={busy === "subtitles"}
                  className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium t-secondary transition-colors hover:border-theme/40 hover:text-theme disabled:opacity-60 dark:border-white/10"
                >
                  {busy === "subtitles" ? t("story.editor.uploading") : t("story.editor.upload_subtitles")}
                </button>
              </div>
            </div>
            <input
              ref={subtitlesRef}
              type="file"
              accept=".vtt,text/vtt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handleSubtitlesFile(file);
              }}
            />
          </div>
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
