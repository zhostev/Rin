// AudioBlock: metadata form for an audio content block.
// Stage 1: pick an asset via MediaPicker (upload to /api/storage or link).
// R2-hosted playback with chapters arrives in Stage 2; until then the
// frontend renders a placeholder card (see page/story.tsx).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AudioPayload, MediaAsset } from "../../api/story";
import { MediaPicker } from "./media-picker";
import { formatDuration } from "./block-utils";

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

export function AudioBlock({
  payload,
  onChange,
}: {
  payload: AudioPayload;
  onChange: (patch: Partial<AudioPayload>) => void;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const asset = payload.asset;
  const duration = payload.duration ?? asset?.duration;

  function selectAsset(next: MediaAsset) {
    onChange({
      asset: next,
      asset_id: next.id || undefined,
      duration: next.duration,
    });
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
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded-full bg-theme px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-theme-hover"
          >
            {asset ? t("story.editor.change_asset") : t("story.editor.pick_asset")}
          </button>
        </div>

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

      <p className="rounded-xl border border-dashed border-black/10 p-3 text-xs leading-5 text-neutral-500 dark:border-white/10 dark:text-neutral-400">
        <i className="ri-information-line mr-1" />
        {t("story.editor.audio_stage2_note")}
      </p>

      <MediaPicker
        open={pickerOpen}
        kind="audio"
        onSelect={selectAsset}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
