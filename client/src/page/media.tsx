import type { MediaAsset } from "@rin/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { useAlert, useConfirm } from "../components/dialog";
import { MediaEmbed } from "../components/media-embed";
import { client } from "../app/runtime";
import { Waiting } from "../components/loading";
import { useSiteConfig } from "../hooks/useSiteConfig";

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

  function deleteAsset(asset: MediaAsset) {
    showConfirm(
      t("media.delete_title"),
      asset.feedId ? t("media.delete_referenced") : t("media.delete_confirm"),
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

      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t("media.total", { count: total })}
          </p>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">{t("media.upload_hint")}</p>
        </div>

        <Waiting for={!loading}>
          {items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-black/10 px-5 py-12 text-center dark:border-white/10">
              <i className="ri-film-line text-3xl text-neutral-400" aria-hidden="true" />
              <p className="mt-3 text-sm t-secondary">{t("media.empty")}</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {items.map((asset) => (
                <article key={asset.id} className="overflow-hidden rounded-2xl border border-black/5 bg-secondary dark:border-white/10">
                  <MediaEmbed id={asset.id} type={asset.type} provider={asset.provider} title={asset.feedTitle || undefined} className="my-0 rounded-none border-0 shadow-none" />
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 text-sm">
                      <p className="truncate font-medium t-primary">{asset.feedTitle || t("media.unattached")}</p>
                      <p className="mt-1 text-xs t-secondary">
                        {asset.type} · {asset.status === "processing" ? t("media.processing") : formatSize(asset.fileSize)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-xl border border-black/10 px-3 py-2 text-sm t-secondary transition-colors hover:border-red-300 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10"
                      disabled={Boolean(asset.feedId) || asset.provider === "stream" || deleting === asset.id}
                      onClick={() => deleteAsset(asset)}
                      title={asset.feedId ? t("media.delete_referenced") : asset.provider === "stream" ? t("media.delete_stream") : t("media.delete_title")}
                    >
                      <i className="ri-delete-bin-6-line" aria-hidden="true" />
                      <span className="sr-only">{t("media.delete_title")}</span>
                    </button>
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
