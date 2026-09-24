// VideoBlock: metadata form for a video content block.
// Stage 1: pick an asset via MediaPicker (upload to /api/storage or link).
// Cloudflare Stream direct-upload + official player arrive in Stage 2;
// until then the frontend renders a placeholder card (see page/story.tsx).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaAsset, VideoPayload } from "../../api/story";
import { MediaPicker } from "./media-picker";
import { formatDuration } from "./block-utils";

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

export function VideoBlock({
  payload,
  onChange,
}: {
  payload: VideoPayload;
  onChange: (patch: Partial<VideoPayload>) => void;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const asset = payload.asset;

  function selectAsset(next: MediaAsset) {
    onChange({
      asset: next,
      asset_id: next.id || undefined,
    });
  }

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
              <i className="ri-video-line text-xl text-neutral-500 dark:text-neutral-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium t-primary">{asset.title || asset.url}</p>
              <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                {[asset.mime, typeof asset.duration === "number" ? formatDuration(asset.duration) : undefined,
                  asset.width && asset.height ? `${asset.width}×${asset.height}` : undefined]
                  .filter(Boolean)
                  .join(" · ") || t("story.editor.unknown")}
              </p>
            </div>
            <button
              type="button"
              aria-label={t("story.editor.remove_asset")}
              onClick={() => onChange({ asset: undefined, asset_id: undefined })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/10"
            >
              <i className="ri-close-line" />
            </button>
          </div>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("story.editor.no_asset")}</p>
        )}
      </div>

      <label className="flex flex-col gap-1.5 opacity-70">
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
        <span className="text-xs text-neutral-400">{t("story.editor.stream_stage2")}</span>
      </label>

      <p className="rounded-xl border border-dashed border-black/10 p-3 text-xs leading-5 text-neutral-500 dark:border-white/10 dark:text-neutral-400">
        <i className="ri-information-line mr-1" />
        {t("story.editor.video_stage2_note")}
      </p>

      <MediaPicker
        open={pickerOpen}
        kind="video"
        onSelect={selectAsset}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
