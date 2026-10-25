// GalleryBlock: an editable gallery content block for stories.
//
// One block holds many images as payload.items: [{id, url, alt}]. That is
// what the public story page already renders (GalleryGrid) and what the
// media center attributes on (items[].id) — unlike markdown image links in
// a rich_text block, which carry no asset id. Keeping 67 images in one
// block also stays far under the D1 bound-parameter ceiling that broke
// 20+ single-image blocks (see server/features/story/repository.ts).
//
// Picking is multi-select via MediaPicker with keepOpenOnSelect: each
// Library/Recent pick (or upload) appends one item and the picker stays
// open until the user closes it with the X. Items can be removed and
// reordered; duplicates (same asset id, or same url for id-less links)
// are ignored.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GalleryItem, GalleryPayload, MediaAsset } from "../../api/story";
import { mediaPlaybackRelativeUrl } from "../../utils/media-upload";
import {
  addGalleryItem,
  galleryItems,
  moveGalleryItem,
  removeGalleryItem,
} from "./block-utils";
import { MediaPicker } from "./media-picker";

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

function assetToItem(asset: MediaAsset): GalleryItem {
  const url = asset.url ?? (asset.id ? mediaPlaybackRelativeUrl(String(asset.id)) : "");
  return {
    ...(asset.id ? { id: asset.id } : {}),
    url,
    ...(asset.alt || asset.title ? { alt: asset.alt || asset.title } : {}),
  };
}

export function GalleryBlock({
  payload,
  onChange,
}: {
  payload: GalleryPayload;
  onChange: (patch: Partial<GalleryPayload>) => void;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const items = galleryItems(payload);

  function addAsset(asset: MediaAsset) {
    const item = assetToItem(asset);
    if (!item.url) return;
    onChange({ items: addGalleryItem(items, item) });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {t("story.editor.gallery_count", { count: items.length })}
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="rounded-full bg-theme px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-theme-hover"
        >
          <i className="ri-add-line mr-1" />
          {t("story.editor.gallery_add")}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t("story.editor.gallery_empty")}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item, index) => (
            <div
              key={`${item.id ?? item.url}-${index}`}
              className="group relative overflow-hidden rounded-xl border border-black/10 dark:border-white/10"
            >
              <img src={item.url} alt={item.alt ?? ""} className="h-28 w-full object-cover" loading="lazy" />
              <p className="truncate px-2 py-1.5 text-xs t-secondary">{item.alt || item.url}</p>
              <div className="flex gap-1 px-2 pb-2">
                <button
                  type="button"
                  aria-label={t("story.editor.move_up")}
                  disabled={index === 0}
                  onClick={() => onChange({ items: moveGalleryItem(items, index, -1) })}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
                >
                  <i className="ri-arrow-up-line" />
                </button>
                <button
                  type="button"
                  aria-label={t("story.editor.move_down")}
                  disabled={index === items.length - 1}
                  onClick={() => onChange({ items: moveGalleryItem(items, index, 1) })}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
                >
                  <i className="ri-arrow-down-line" />
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  aria-label={t("story.editor.gallery_remove")}
                  onClick={() => onChange({ items: removeGalleryItem(items, index) })}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/10"
                >
                  <i className="ri-close-line" />
                </button>
              </div>
              <label className="block px-2 pb-2">
                <input
                  type="text"
                  value={item.alt ?? ""}
                  placeholder={t("story.editor.gallery_alt_placeholder")}
                  onChange={(e) => {
                    const next = items.slice();
                    next[index] = { ...next[index], alt: e.target.value || undefined };
                    onChange({ items: next });
                  }}
                  className={inputClassName}
                />
              </label>
            </div>
          ))}
        </div>
      )}

      <MediaPicker
        open={pickerOpen}
        kind="image"
        keepOpenOnSelect
        onSelect={addAsset}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
