import type { MediaAsset } from "@rin/api";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";

export type PickedAsset = {
  id: string;
  note: string;
};

/** Pure so the ordering rule can be tested without mounting the component. */
export function togglePickedAsset(picked: PickedAsset[], id: string): PickedAsset[] {
  return picked.some((asset) => asset.id === id)
    ? picked.filter((asset) => asset.id !== id)
    // Append, never re-sort: this order is what the model is shown as [[media:N]].
    : [...picked, { id, note: "" }];
}

export function setPickedNote(picked: PickedAsset[], id: string, note: string): PickedAsset[] {
  return picked.map((asset) => (asset.id === id ? { ...asset, note } : asset));
}

export function MediaPicker({
  value,
  onChange,
  className,
}: {
  value: PickedAsset[];
  onChange: (next: PickedAsset[]) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    client.media
      .list({ page: 1, limit: 50 })
      .then(({ data, error: requestError }) => {
        if (cancelled) return;
        if (requestError) {
          setError(String(requestError.value ?? t("media.load_failed")));
        } else {
          setAssets(data?.data ?? []);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const pickedIndex = new Map(value.map((asset, index) => [asset.id, index]));

  if (loading) {
    return (
      <div className={`flex justify-center py-6 ${className ?? ""}`}>
        <ReactLoading type="spin" height={24} width={24} />
      </div>
    );
  }

  if (error) {
    return <p className={`py-4 text-sm text-red-500 ${className ?? ""}`}>{error}</p>;
  }

  if (assets.length === 0) {
    return (
      <p className={`py-4 text-sm t-secondary ${className ?? ""}`}>
        {t("ai_compose.assets.empty")}
      </p>
    );
  }

  return (
    <div className={className}>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {assets.map((asset) => {
          const order = pickedIndex.get(asset.id);
          const picked = order !== undefined;

          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => onChange(togglePickedAsset(value, asset.id))}
              aria-pressed={picked}
              className={`relative aspect-square overflow-hidden rounded-xl border transition-colors ${
                picked
                  ? "border-theme ring-2 ring-theme"
                  : "border-black/10 hover:border-theme/50 dark:border-white/10"
              }`}
            >
              {asset.type === "image" ? (
                <img
                  src={asset.playbackUrl}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-secondary text-2xl">
                  <i
                    className={asset.type === "video" ? "ri-film-line" : "ri-volume-up-line"}
                    aria-hidden="true"
                  />
                </span>
              )}
              {picked && (
                <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-theme text-xs font-medium text-white">
                  {order + 1}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {value.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-xs t-secondary">{t("ai_compose.assets.note_hint")}</p>
          {value.map((picked, index) => (
            <div key={picked.id} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-sm t-secondary">{index + 1}.</span>
              <input
                type="text"
                value={picked.note}
                onChange={(event) => onChange(setPickedNote(value, picked.id, event.target.value))}
                placeholder={t("ai_compose.assets.note_placeholder")}
                className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-theme dark:border-white/10"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
