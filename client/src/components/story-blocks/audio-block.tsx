// AudioBlock: metadata form for an audio content block.
//
// Upload flow (Stage 2): multipart POST /api/admin/media/audio (fields
// file*, title?; XHR, with progress); the returned asset (asset.url is the
// in-site /api/blob/<key> address) is written into the payload. Chapters
// are edited inline and rendered by the in-site AudioPlayer (see page/story.tsx).

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { client } from "../../app/runtime";
import type { AudioChapter, AudioPayload, MediaAsset } from "../../api/story";
import { MediaPicker } from "./media-picker";
import { isNotConfiguredError } from "../../api/media";
import { formatDuration } from "./block-utils";

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

interface UploadState {
  active: boolean;
  progress: number; // 0..1
  error?: string;
}

export function AudioBlock({
  payload,
  onChange,
}: {
  payload: AudioPayload;
  onChange: (patch: Partial<AudioPayload>) => void;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ active: false, progress: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const asset = payload.asset;
  const duration = payload.duration ?? asset?.duration;
  const chapters = payload.chapters ?? [];

  function selectAsset(next: MediaAsset) {
    onChange({
      asset: next,
      asset_id: next.id || undefined,
      duration: next.duration,
    });
  }

  async function handleFile(file: File) {
    if (upload.active) return;
    setUpload({ active: true, progress: 0 });
    try {
      const asset = await client.media.uploadAudio(
        file,
        (loaded, total) => {
          if (total > 0) {
            setUpload({ active: true, progress: loaded / total });
          }
        },
        payload.title?.trim() || file.name,
      );
      onChange({ asset, asset_id: asset.id || undefined, duration: asset.duration });
      setUpload({ active: false, progress: 1 });
    } catch (err) {
      setUpload({
        active: false,
        progress: 0,
        error: isNotConfiguredError(err as { status?: number })
          ? t("story.editor.picker.not_configured")
          : err instanceof Error
            ? err.message
            : t("story.editor.audio_upload_failed"),
      });
    }
  }

  function updateChapter(index: number, patch: Partial<AudioChapter>) {
    const next = chapters.map((chapter, i) => (i === index ? { ...chapter, ...patch } : chapter));
    onChange({ chapters: next });
  }

  function addChapter() {
    const lastStart = chapters.length > 0 ? chapters[chapters.length - 1].start : 0;
    onChange({
      chapters: [...chapters, { title: "", start: Math.max(0, lastStart) }],
    });
  }

  function removeChapter(index: number) {
    onChange({ chapters: chapters.filter((_, i) => i !== index) });
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t("story.editor.audio_title")}
        </span>
        <input
          type="text"
          value={payload.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder={t("story.editor.audio_title_placeholder")}
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
              disabled={upload.active}
              className="rounded-full bg-theme px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-theme-hover disabled:opacity-60"
            >
              <i className="ri-upload-cloud-2-line mr-1" />
              {t("story.editor.upload_audio")}
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
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />

        {(upload.active || upload.error) && (
          <div className="flex flex-col gap-1.5">
            {upload.active && (
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(upload.progress * 100)}
              >
                <div
                  className="h-full rounded-full bg-theme transition-all"
                  style={{ width: `${Math.round(upload.progress * 100)}%` }}
                />
              </div>
            )}
            <p className={`text-xs ${upload.error ? "text-red-500" : "text-neutral-500 dark:text-neutral-400"}`}>
              {upload.error ?? t("story.editor.audio_uploading", { percent: Math.round(upload.progress * 100) })}
            </p>
          </div>
        )}

        {asset ? (
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-black/10 dark:bg-white/10">
              <i className="ri-music-2-line text-xl text-neutral-500 dark:text-neutral-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium t-primary">{asset.title || asset.url}</p>
              <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                {[asset.mime, formatDuration(duration)].filter(Boolean).join(" · ") || t("story.editor.unknown")}
              </p>
            </div>
            <button
              type="button"
              aria-label={t("story.editor.remove_asset")}
              onClick={() => onChange({ asset: undefined, asset_id: undefined, duration: undefined })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/10"
            >
              <i className="ri-close-line" />
            </button>
          </div>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("story.editor.no_asset")}</p>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm t-secondary">
        <i className="ri-time-line text-neutral-400" />
        <span>{t("story.editor.duration")}: {formatDuration(duration)}</span>
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-secondary p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {t("story.editor.chapters")}
          </span>
          <button
            type="button"
            onClick={addChapter}
            className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium t-secondary transition-colors hover:border-theme/40 hover:text-theme dark:border-white/10"
          >
            <i className="ri-add-line mr-1" />
            {t("story.editor.chapter_add")}
          </button>
        </div>
        {chapters.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("story.editor.no_chapters")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {chapters.map((chapter, index) => (
              <li key={index} className="flex items-center gap-2">
                <input
                  type="text"
                  value={chapter.title}
                  onChange={(e) => updateChapter(index, { title: e.target.value })}
                  placeholder={t("story.editor.chapter_title_placeholder")}
                  aria-label={t("story.editor.chapter_title_placeholder")}
                  className={`${inputClassName} flex-1`}
                />
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={chapter.start}
                  onChange={(e) => updateChapter(index, { start: Math.max(0, Number(e.target.value) || 0) })}
                  aria-label={t("story.editor.chapter_start")}
                  title={t("story.editor.chapter_start")}
                  className={`${inputClassName} w-24 shrink-0`}
                />
                <button
                  type="button"
                  onClick={() => removeChapter(index)}
                  aria-label={t("story.editor.chapter_remove")}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/10"
                >
                  <i className="ri-close-line" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <MediaPicker
        open={pickerOpen}
        kind="audio"
        onSelect={selectAsset}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
