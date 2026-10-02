// Admin media library (/admin/media): browse and manage every uploaded media
// asset — images, videos (R2 chain with poster/subtitles management), audio.
//
// - Kind filter tabs (all / image / video / audio) backed by GET
//   /api/admin/media?kind=...&page=...&limit=...
// - Upload accepts image/video/audio through the unified R2 presigned
//   direct-upload helper (mint → PUT → complete); the media type is
//   auto-detected from the picked file.
// - Deletion is guarded by the backend reference check; a 409 surfaces the
//   "in use" message with the referencing entity.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { client } from "../app/runtime";
import { useAlert, useConfirm } from "../components/dialog";
import { Waiting } from "../components/loading";
import type { AssetKind, MediaAsset } from "../api/story";
import { detectMediaType, uploadMediaFile } from "../utils/media-upload";
import { formatDuration } from "../components/story-blocks/block-utils";

type KindFilter = "all" | AssetKind;

const KIND_TABS: KindFilter[] = ["all", "image", "video", "audio"];
const PAGE_LIMIT = 24;

function metaLine(asset: MediaAsset, t: (k: string) => string): string {
  return (
    [
      asset.mime,
      typeof asset.duration === "number" ? formatDuration(asset.duration) : undefined,
      asset.width && asset.height ? `${asset.width}×${asset.height}` : undefined,
      asset.stream_status ? t(`story.editor.stream_status_${asset.stream_status}`) : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || t("admin.media_library.unknown")
  );
}

function AssetCard({
  asset,
  onChanged,
  onDeleted,
}: {
  asset: MediaAsset;
  onChanged: (next: MediaAsset) => void;
  onDeleted: (id: number) => void;
}) {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  const { showConfirm, ConfirmUI } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const posterRef = useRef<HTMLInputElement>(null);
  const subtitlesRef = useRef<HTMLInputElement>(null);

  const isVideo = asset.kind === "video";
  const isR2Video = isVideo && asset.source !== "stream" && !asset.stream_uid;

  async function handleDelete() {
    showConfirm(
      t("admin.media_library.delete_title"),
      t("admin.media_library.delete_confirm", { title: asset.title || `#${asset.id}` }),
      async () => {
        setBusy("delete");
        try {
          const { error } = await client.media.remove(asset.id);
          if (error) {
            const message =
              error.status === 409
                ? t("admin.media_library.delete_blocked", { detail: error.value || "" })
                : error.value || t("admin.media_library.delete_failed");
            showAlert(message);
            return;
          }
          onDeleted(asset.id);
        } finally {
          setBusy(null);
        }
      },
    );
  }

  async function handlePosterFile(file: File) {
    setBusy("poster");
    try {
      const updated = await client.media.attachPoster(asset.id, file);
      onChanged(updated);
    } catch (err) {
      showAlert(err instanceof Error ? err.message : t("admin.media_library.upload_failed"));
    } finally {
      setBusy(null);
    }
  }

  async function handleSubtitlesFile(file: File) {
    setBusy("subtitles");
    try {
      const updated = await client.media.attachSubtitles(asset.id, file);
      onChanged(updated);
    } catch (err) {
      showAlert(err instanceof Error ? err.message : t("admin.media_library.upload_failed"));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemovePoster() {
    setBusy("poster");
    try {
      const { error } = await client.media.detachPoster(asset.id);
      if (!error) onChanged({ ...asset, poster_asset_id: undefined, poster_url: undefined });
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveSubtitles() {
    setBusy("subtitles");
    try {
      const { error } = await client.media.detachSubtitles(asset.id);
      if (!error) onChanged({ ...asset, subtitles_asset_id: undefined, subtitles_url: undefined });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-black/10 bg-w dark:border-white/10">
      <div className="relative aspect-video bg-black/90">
        {asset.kind === "image" && asset.url ? (
          <img src={asset.url} alt={asset.alt || ""} loading="lazy" className="h-full w-full object-cover" />
        ) : isVideo && asset.poster_url ? (
          <img src={asset.poster_url} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-neutral-500">
            <i className={`text-4xl ${isVideo ? "ri-video-line" : asset.kind === "audio" ? "ri-music-2-line" : "ri-image-2-line"}`} />
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
          {asset.kind}
          {asset.source && asset.source !== "r2" ? ` · ${asset.source}` : ""}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
        <p className="truncate text-sm font-medium t-primary">{asset.title || `#${asset.id}`}</p>
        <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{metaLine(asset, t)}</p>

        {isR2Video && (
          <div className="mt-1 flex flex-col gap-1.5 border-t border-black/5 pt-2 text-xs dark:border-white/5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral-500 dark:text-neutral-400">{t("admin.media_library.poster")}</span>
              <div className="flex items-center gap-2">
                {asset.poster_url && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void handleRemovePoster()}
                    className="text-neutral-400 hover:text-red-500 disabled:opacity-60"
                  >
                    {t("admin.media_library.remove")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => posterRef.current?.click()}
                  className="rounded-full border border-black/10 px-2.5 py-0.5 t-secondary hover:border-theme/40 hover:text-theme disabled:opacity-60 dark:border-white/10"
                >
                  {busy === "poster" ? t("admin.media_library.working") : t("admin.media_library.upload_poster")}
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
              <span className="text-neutral-500 dark:text-neutral-400">{t("admin.media_library.subtitles")}</span>
              <div className="flex items-center gap-2">
                {asset.subtitles_url && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void handleRemoveSubtitles()}
                    className="text-neutral-400 hover:text-red-500 disabled:opacity-60"
                  >
                    {t("admin.media_library.remove")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => subtitlesRef.current?.click()}
                  className="rounded-full border border-black/10 px-2.5 py-0.5 t-secondary hover:border-theme/40 hover:text-theme disabled:opacity-60 dark:border-white/10"
                >
                  {busy === "subtitles"
                    ? t("admin.media_library.working")
                    : t("admin.media_library.upload_subtitles")}
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

        <div className="mt-auto flex justify-end pt-1">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void handleDelete()}
            className="rounded-full px-2.5 py-1 text-xs text-neutral-400 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-60"
          >
            <i className="ri-delete-bin-line mr-1" />
            {busy === "delete" ? t("admin.media_library.working") : t("admin.media_library.delete")}
          </button>
        </div>
      </div>
      <AlertUI />
      <ConfirmUI />
    </div>
  );
}

export function AdminMediaLibraryPage() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<KindFilter>("all");
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [fromUrlOpen, setFromUrlOpen] = useState(false);
  const [fromUrl, setFromUrl] = useState("");
  const [fromUrlTitle, setFromUrlTitle] = useState("");
  const [fromUrlAlt, setFromUrlAlt] = useState("");
  const [downloading, setDownloading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { showAlert, AlertUI } = useAlert();

  const fetchAssets = useCallback(
    async (targetPage: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const { data, error } = await client.media.list(
          kind === "all" ? undefined : kind,
          { page: targetPage, limit: PAGE_LIMIT },
        );
        if (!error && data) {
          setAssets((prev) => (append ? [...prev, ...data.data] : data.data));
          setPage(targetPage);
          setHasNext(data.hasNext);
        }
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [kind],
  );

  useEffect(() => {
    setAssets([]);
    setPage(1);
    void fetchAssets(1, false);
  }, [kind, fetchAssets]);

  async function handlePickedFile(file: File) {
    const type = detectMediaType(file);
    if (!type) {
      showAlert(t("admin.media_library.upload_unsupported"));
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    try {
      const { asset } = await uploadMediaFile(file, type, {
        t,
        onProgress: (p) => setUploadProgress(p),
      });
      setAssets((prev) => [asset, ...prev]);
    } catch (err) {
      showAlert(err instanceof Error ? err.message : t("admin.media_library.upload_failed"));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  async function handleFromUrlDownload() {
    const url = fromUrl.trim();
    if (!url) {
      showAlert(t("admin.media_library.from_url_invalid"));
      return;
    }
    setDownloading(true);
    try {
      const { data, error } = await client.media.fromUrl({
        url,
        title: fromUrlTitle.trim() || undefined,
        alt: fromUrlAlt.trim() || undefined,
      });
      if (error || !data) {
        const status = error?.status;
        const key =
          status === 413
            ? "from_url_too_large"
            : status === 415
              ? "from_url_not_image"
              : status === 422
                ? "from_url_instagram_failed"
                : status === 503
                  ? "from_url_not_configured"
                  : status === 400
                    ? "from_url_invalid"
                    : "from_url_failed";
        showAlert(
          typeof error?.value === "string" && error.value
            ? error.value
            : t(`admin.media_library.${key}`),
        );
        return;
      }
      setAssets((prev) => [data, ...prev]);
      setFromUrlOpen(false);
      setFromUrl("");
      setFromUrlTitle("");
      setFromUrlAlt("");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-full border border-black/10 p-1 dark:border-white/10">
          {KIND_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setKind(tab)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                kind === tab ? "bg-theme text-white" : "t-secondary hover:t-primary"
              }`}
            >
              {t(`admin.media_library.kind_${tab}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {uploading && uploadProgress !== null && (
            <span className="text-xs text-neutral-500">{uploadProgress}%</span>
          )}
          <button
            type="button"
            disabled={uploading || downloading}
            onClick={() => setFromUrlOpen(true)}
            className="rounded-full border border-black/10 px-4 py-1.5 text-xs font-medium t-secondary transition-colors hover:border-theme/40 hover:text-theme disabled:opacity-60 dark:border-white/10"
          >
            <i className="ri-link mr-1" />
            {t("admin.media_library.from_url")}
          </button>
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="rounded-full bg-theme px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-theme-hover disabled:opacity-60"
          >
            <i className="ri-upload-cloud-2-line mr-1" />
            {uploading ? t("admin.media_library.uploading") : t("admin.media_library.upload_media")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*,audio/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handlePickedFile(file);
            }}
          />
        </div>
      </div>

      {loading ? (
        <Waiting />
      ) : assets.length === 0 ? (
        <p className="py-12 text-center text-sm text-neutral-500 dark:text-neutral-400">
          {t("admin.media_library.empty")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                onChanged={(next) =>
                  setAssets((prev) => prev.map((a) => (a.id === next.id ? next : a)))
                }
                onDeleted={(id) => setAssets((prev) => prev.filter((a) => a.id !== id))}
              />
            ))}
          </div>
          {hasNext && (
            <div className="flex justify-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void fetchAssets(page + 1, true)}
                className="rounded-full border border-black/10 px-6 py-2 text-sm t-secondary transition-colors hover:border-theme/40 hover:text-theme disabled:opacity-60 dark:border-white/10"
              >
                {loadingMore ? t("admin.media_library.loading") : t("admin.media_library.load_more")}
              </button>
            </div>
          )}
        </>
      )}
      {fromUrlOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => {
            if (!downloading) setFromUrlOpen(false);
          }}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-black/10 bg-w p-5 dark:border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-sm font-medium t-primary">
              {t("admin.media_library.from_url_title")}
            </h3>
            <label className="mb-1 block text-xs text-neutral-500 dark:text-neutral-400">
              {t("admin.media_library.from_url_url")}
            </label>
            <input
              type="url"
              value={fromUrl}
              disabled={downloading}
              onChange={(e) => setFromUrl(e.target.value)}
              placeholder={t("admin.media_library.from_url_url_placeholder")}
              className="mb-1 w-full rounded-xl border border-black/10 bg-w p-3 text-sm t-primary outline-none focus:border-theme disabled:opacity-60 dark:border-white/10"
            />
            <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
              {t("admin.media_library.from_url_hint")}
            </p>
            <label className="mb-1 block text-xs text-neutral-500 dark:text-neutral-400">
              {t("admin.media_library.from_url_name")}
            </label>
            <input
              type="text"
              value={fromUrlTitle}
              disabled={downloading}
              onChange={(e) => setFromUrlTitle(e.target.value)}
              className="mb-3 w-full rounded-xl border border-black/10 bg-w p-3 text-sm t-primary outline-none focus:border-theme disabled:opacity-60 dark:border-white/10"
            />
            <label className="mb-1 block text-xs text-neutral-500 dark:text-neutral-400">
              {t("admin.media_library.from_url_alt")}
            </label>
            <input
              type="text"
              value={fromUrlAlt}
              disabled={downloading}
              onChange={(e) => setFromUrlAlt(e.target.value)}
              className="w-full rounded-xl border border-black/10 bg-w p-3 text-sm t-primary outline-none focus:border-theme disabled:opacity-60 dark:border-white/10"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={downloading}
                onClick={() => setFromUrlOpen(false)}
                className="rounded-full px-4 py-1.5 text-xs font-medium t-secondary hover:t-primary disabled:opacity-60"
              >
                {t("admin.media_library.from_url_cancel")}
              </button>
              <button
                type="button"
                disabled={downloading || !fromUrl.trim()}
                onClick={() => void handleFromUrlDownload()}
                className="rounded-full bg-theme px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-theme-hover disabled:opacity-60"
              >
                {downloading
                  ? t("admin.media_library.from_url_downloading")
                  : t("admin.media_library.from_url_confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      <AlertUI />
    </div>
  );
}
