// ImageBlock: a single image content block for stories.
//
// Upload goes through the shared R2 presigned direct-upload helper
// (uploadMediaFile), the same path as the markdown editor and the media
// picker, so the 100MB Worker request-body cap does not apply.
// Existing image assets can also be picked via MediaPicker.
// The public story page renders image blocks from payload.url with
// payload.caption / payload.alt (see page/story.tsx ReadBlock).

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImagePayload, MediaAsset } from "../../api/story";
import { uploadMediaFile, mediaPlaybackRelativeUrl } from "../../utils/media-upload";
import { MediaPicker } from "./media-picker";

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

interface UploadState {
  active: boolean;
  progress: number; // 0..100
  error?: string;
}

function assetUrl(asset: MediaAsset): string {
  return asset.url ?? mediaPlaybackRelativeUrl(String(asset.id));
}

export function ImageBlock({
  payload,
  onChange,
}: {
  payload: ImagePayload;
  onChange: (patch: Partial<ImagePayload>) => void;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ active: false, progress: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const asset = payload.asset;
  const previewUrl = asset ? assetUrl(asset) : payload.url;

  function selectAsset(next: MediaAsset) {
    onChange({
      asset: next,
      asset_id: next.id || undefined,
      url: assetUrl(next),
      alt: payload.alt ?? next.alt,
    });
  }

  async function handleFile(file: File) {
    if (upload.active) return;
    setUpload({ active: true, progress: 0 });
    try {
      const { asset: created } = await uploadMediaFile(file, "image", {
        t,
        title: payload.caption?.trim() || file.name,
        onProgress: (percent) => {
          if (percent != null) {
            setUpload({ active: true, progress: percent });
          }
        },
      });
      onChange({
        asset: created,
        asset_id: created.id || undefined,
        url: assetUrl(created),
        alt: payload.alt ?? created.alt,
      });
      setUpload({ active: false, progress: 100 });
    } catch (err) {
      setUpload({
        active: false,
        progress: 0,
        error: err instanceof Error ? err.message : t("story.editor.image_upload_failed"),
      });
    }
  }

  return (
    <div className="flex flex-col gap-3">
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
              {t("story.editor.upload_image")}
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
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />

        {upload.active && (
          <div className="flex flex-col gap-1.5">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(upload.progress)}
            >
              <div
                className="h-full rounded-full bg-theme transition-all"
                style={{ width: `${Math.round(upload.progress)}%` }}
              />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("story.editor.image_uploading", { percent: Math.round(upload.progress) })}
            </p>
          </div>
        )}
        {upload.error && <p className="text-xs text-red-500">{upload.error}</p>}

        {previewUrl ? (
          <div className="flex items-center gap-3">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/10 dark:bg-white/10">
              <img src={previewUrl} alt={payload.alt ?? ""} className="h-full w-full object-cover" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium t-primary">
                {asset?.title || asset?.url || previewUrl}
              </p>
              {asset?.mime && (
                <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{asset.mime}</p>
              )}
            </div>
            <button
              type="button"
              aria-label={t("story.editor.remove_asset")}
              onClick={() => onChange({ asset: undefined, asset_id: undefined, url: undefined })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/10"
            >
              <i className="ri-close-line" />
            </button>
          </div>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("story.editor.no_asset")}</p>
        )}

        <MediaPicker open={pickerOpen} kind="image" onSelect={selectAsset} onClose={() => setPickerOpen(false)} />
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t("story.editor.image_caption")}
        </span>
        <input
          type="text"
          value={payload.caption ?? ""}
          onChange={(e) => onChange({ caption: e.target.value })}
          placeholder={t("story.editor.image_caption_placeholder")}
          className={inputClassName}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t("story.editor.image_alt")}
        </span>
        <input
          type="text"
          value={payload.alt ?? ""}
          onChange={(e) => onChange({ alt: e.target.value })}
          placeholder={t("story.editor.image_alt_placeholder")}
          className={inputClassName}
        />
      </label>
    </div>
  );
}
