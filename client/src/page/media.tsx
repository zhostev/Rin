import type { MediaAsset } from "@rin/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { useAlert, useConfirm } from "../components/dialog";
import { MediaEmbed } from "../components/media-embed";
import { client } from "../app/runtime";
import { Waiting } from "../components/loading";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { detectMediaType, mediaPlaybackUrl, uploadMediaFile } from "../utils/media-upload";

function formatSize(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function MediaPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const { showAlert, AlertUI } = useAlert();
  const { showConfirm, ConfirmUI } = useConfirm();
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const showAlertRef = useRef(showAlert);
  showAlertRef.current = showAlert;

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await client.media.list({ page, limit: 12 });
    if (error) {
      showAlertRef.current(error.value);
    } else {
      setItems(data?.data || []);
      setTotal(data?.size || 0);
      setHasNext(Boolean(data?.hasNext));
    }
    setLoading(false);
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!items.some((asset) => asset.provider === "stream" && asset.status === "processing")) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [items, load]);

  async function uploadFile(file: File) {
    const type = detectMediaType(file);
    if (!type) {
      showAlert(t("upload.media.invalid_type_library"));
      return;
    }

    setUploading(true);
    setUploadProgress(null);
    try {
      await uploadMediaFile(file, type, { t, onProgress: setUploadProgress });
      showAlert(t("media.upload_success"));
      if (page !== 1) setPage(1);
      else await load();
    } catch (error) {
      console.error(error);
      showAlert(error instanceof Error ? error.message : t("upload.failed"));
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function copyLink(asset: MediaAsset) {
    const url = mediaPlaybackUrl(asset.id);
    try {
      await navigator.clipboard.writeText(url);
      showAlert(t("media.link_copied"));
    } catch {
      // Clipboard access needs a secure context; fall back to showing the link.
      showAlert(url);
    }
  }

  function deleteAsset(asset: MediaAsset) {
    showConfirm(
      t("media.delete_title"),
      asset.feedId
        ? t("media.delete_referenced")
        : asset.momentId
          ? t("media.delete_referenced_moment")
          : t("media.delete_confirm"),
      async () => {
        setDeleting(asset.id);
        const { error } = await client.media.delete(asset.id);
        setDeleting(null);
        if (error) {
          showAlert(error.value);
          return;
        }
        showAlert(t("media.delete_success"));
        if (items.length === 1 && page > 1) setPage((current) => current - 1);
        else void load();
      },
    );
  }

  return (
    <>
      <Helmet>
        <title>{`${t("media.title")} - ${siteConfig.name}`}</title>
      </Helmet>

      <div
        className={`space-y-5 rounded-2xl transition-colors ${dragActive ? "outline-dashed outline-2 outline-offset-4 outline-theme" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!uploading) setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (uploading) return;
          const file = event.dataTransfer.files?.[0];
          if (file) void uploadFile(file);
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t("media.total", { count: total })}
          </p>
          <div className="flex items-center gap-3">
            <p className="text-xs text-neutral-400 dark:text-neutral-500">{t("media.upload_hint")}</p>
            <input
              ref={uploadRef}
              type="file"
              className="hidden"
              accept="image/*,audio/*,video/*"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void uploadFile(file);
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => uploadRef.current?.click()}
              className="rounded-full bg-theme px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <i className="ri-upload-2-line mr-1" aria-hidden="true" />
              {uploading
                ? uploadProgress === null
                  ? t("media.uploading")
                  : t("media.uploading_percent", { percent: uploadProgress })
                : t("media.upload")}
            </button>
          </div>
        </div>

        <Waiting for={!loading}>
          {items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-black/10 px-5 py-12 text-center dark:border-white/10">
              <i className="ri-film-line text-3xl text-neutral-400" aria-hidden="true" />
              <p className="mt-3 text-sm t-secondary">{dragActive ? t("media.drop_now") : t("media.empty")}</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {items.map((asset) => (
                <article key={asset.id} className="overflow-hidden rounded-2xl border border-black/5 bg-secondary dark:border-white/10">
                  <MediaEmbed id={asset.id} type={asset.type} provider={asset.provider} title={asset.feedTitle || undefined} className="my-0 rounded-none border-0 shadow-none" />
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 text-sm">
                      <p className="truncate font-medium t-primary">
                        {asset.feedTitle || (asset.momentId ? t("media.attached_moment") : t("media.unattached"))}
                      </p>
                      <p className="mt-1 text-xs t-secondary">
                        {t(`media.${asset.type}`)} · {asset.status === "processing" ? t("media.processing") : formatSize(asset.fileSize)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        className="shrink-0 rounded-xl border border-black/10 px-3 py-2 text-sm t-secondary transition-colors hover:border-black/20 hover:text-black disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:text-white"
                        onClick={() => void copyLink(asset)}
                        title={t("media.copy_link")}
                      >
                        <i className="ri-links-line" aria-hidden="true" />
                        <span className="sr-only">{t("media.copy_link")}</span>
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded-xl border border-black/10 px-3 py-2 text-sm t-secondary transition-colors hover:border-red-300 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10"
                        disabled={Boolean(asset.feedId) || Boolean(asset.momentId) || asset.provider === "stream" || deleting === asset.id}
                        onClick={() => deleteAsset(asset)}
                        title={asset.feedId
                          ? t("media.delete_referenced")
                          : asset.momentId
                            ? t("media.delete_referenced_moment")
                            : asset.provider === "stream"
                              ? t("media.delete_stream")
                              : t("media.delete_title")}
                      >
                        <i className="ri-delete-bin-6-line" aria-hidden="true" />
                        <span className="sr-only">{t("media.delete_title")}</span>
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Waiting>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => current - 1)}
            className="rounded-full bg-theme px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("previous")}
          </button>
          <span className="text-sm t-secondary">{page}</span>
          <button
            type="button"
            disabled={!hasNext || loading}
            onClick={() => setPage((current) => current + 1)}
            className="rounded-full bg-theme px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("next")}
          </button>
        </div>
      </div>
      <AlertUI />
      <ConfirmUI />
    </>
  );
}
