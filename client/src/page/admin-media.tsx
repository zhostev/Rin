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
// - Batch-imported images sharing a group_key are rendered as a photo set:
//   stacked cover card with a ×N badge, expandable to manage members.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { client } from "../app/runtime";
import { useAlert, useConfirm } from "../components/dialog";
import { Waiting } from "../components/loading";
import type { AssetKind, MediaAsset } from "../api/story";
import { detectMediaType, uploadMediaFile } from "../utils/media-upload";
import { groupAssets, groupTitle, isInstagramPostUrl, applyInstagramBatchPreference } from "../utils/media-groups";
import {
  BATCH_MEDIA_MAX_ITEMS,
  chunkBatchItems,
  generateBatchGroupKey,
  parseBatchUrlLines,
  titleBatchItems,
  type BatchUrlItem,
} from "../utils/batch-media";
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

/** 图片集卡片：封面 + ×N 角标，点击展开看全部成员（成员仍是独立 AssetCard，可单独删除）。 */
function AssetGroupCard({
  items,
  onChanged,
  onDeleted,
}: {
  items: MediaAsset[];
  onChanged: (next: MediaAsset) => void;
  onDeleted: (id: number) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const cover = items[0];
  if (!cover) return null;

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-black/10 bg-w dark:border-white/10">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="relative block aspect-video w-full bg-black/90 text-left"
      >
        {cover.url ? (
          <img src={cover.url} alt={cover.alt || ""} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-neutral-500">
            <i className="ri-image-2-line text-4xl" />
          </span>
        )}
        <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-theme px-2 py-0.5 text-[11px] font-medium text-white">
          <i className="ri-stack-line" />×{items.length}
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
        <p className="truncate text-sm font-medium t-primary">{groupTitle(cover)}</p>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
            {t("admin.media_library.group_count", { count: items.length })}
          </p>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 rounded-full border border-black/10 px-2.5 py-0.5 text-xs t-secondary hover:border-theme/40 hover:text-theme dark:border-white/10"
          >
            {expanded ? t("admin.media_library.group_collapse") : t("admin.media_library.group_expand")}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="grid grid-cols-2 gap-3 border-t border-black/5 p-3 dark:border-white/5">
          {items.map((item) => (
            <AssetCard key={item.id} asset={item} onChanged={onChanged} onDeleted={onDeleted} />
          ))}
        </div>
      )}
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
  const [fromUrlBatchAll, setFromUrlBatchAll] = useState(true);
  const [downloading, setDownloading] = useState(false);
  // 多文件上传队列：分组标题填了则本次队列共用一个 groupKey。
  const [uploadGroupTitle, setUploadGroupTitle] = useState("");
  const [uploadQueue, setUploadQueue] = useState<{
    total: number;
    done: number;
    current: string;
    stopped: boolean;
    failures: Array<{ name: string; message: string }>;
  } | null>(null);
  const uploadStopRef = useRef(false);
  // 批量从 URL 导入对话框状态。
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchGroupTitle, setBatchGroupTitle] = useState("");
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    chunk: number;
    chunks: number;
    done: number;
    total: number;
    success: number;
    failed: number;
  } | null>(null);
  const [batchFailures, setBatchFailures] = useState<
    Array<{ index: number; url: string; title?: string; message: string; code: string }>
  >([]);
  const [batchStopped, setBatchStopped] = useState(false);
  const batchStopRef = useRef(false);
  const batchGroupKeyRef = useRef<string | undefined>(undefined);
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

  async function handlePickedFiles(files: File[]) {
    if (files.length === 0) return;
    // 分组标题填了则本次队列共用一个 groupKey（直传建单时传给服务端）；
    // 没填则不分组，与旧单文件行为一致。
    const groupKey = uploadGroupTitle.trim() ? generateBatchGroupKey() : undefined;
    uploadStopRef.current = false;
    const failures: Array<{ name: string; message: string }> = [];
    const succeeded: MediaAsset[] = [];
    setUploadQueue({ total: files.length, done: 0, current: "", stopped: false, failures: [] });
    setUploading(true);
    setUploadProgress(0);
    try {
      for (let i = 0; i < files.length; i += 1) {
        if (uploadStopRef.current) break;
        const file = files[i]!;
        setUploadQueue((prev) =>
          prev ? { ...prev, current: file.name } : prev,
        );
        const type = detectMediaType(file);
        if (!type) {
          failures.push({ name: file.name, message: t("admin.media_library.upload_unsupported") });
          setUploadQueue((prev) =>
            prev ? { ...prev, done: i + 1, failures: [...failures] } : prev,
          );
          continue;
        }
        try {
          const { asset } = await uploadMediaFile(file, type, {
            t,
            onProgress: (p) => setUploadProgress(p),
            ...(groupKey ? { groupKey } : {}),
          });
          succeeded.push(asset);
        } catch (err) {
          failures.push({
            name: file.name,
            message: err instanceof Error ? err.message : t("admin.media_library.upload_failed"),
          });
        }
        setUploadQueue((prev) =>
          prev
            ? { ...prev, done: i + 1, failures: [...failures], stopped: uploadStopRef.current }
            : prev,
        );
      }
      if (succeeded.length > 0) {
        setAssets((prev) => [...succeeded.reverse(), ...prev]);
      }
      setUploadQueue((prev) =>
        prev ? { ...prev, current: "", stopped: uploadStopRef.current, failures: [...failures] } : prev,
      );
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  type BatchRunItem = BatchUrlItem & { index: number };

  async function runBatch(items: BatchRunItem[], groupTitle: string, groupKey: string | undefined) {
    const chunks = chunkBatchItems(items, BATCH_MEDIA_MAX_ITEMS);
    const newAssets: MediaAsset[] = [];
    const newFailures: Array<{ index: number; url: string; title?: string; message: string; code: string }> = [];
    let done = 0;
    let success = 0;
    setBatchProgress({ chunk: 0, chunks: chunks.length, done: 0, total: items.length, success: 0, failed: 0 });
    for (let ci = 0; ci < chunks.length; ci += 1) {
      if (batchStopRef.current) break;
      const chunk = chunks[ci]!;
      setBatchProgress((prev) =>
        prev ? { ...prev, chunk: ci + 1 } : prev,
      );
      const { data, error } = await client.media.batchFromUrls({
        items: chunk.map((item) => ({
          url: item.url,
          ...(item.title ? { title: item.title } : {}),
        })),
        ...(groupTitle ? { groupTitle } : {}),
        ...(groupKey ? { groupKey } : {}),
      });
      if (error || !data) {
        const message = t("admin.media_library.batch_chunk_failed");
        for (const item of chunk) {
          newFailures.push({ index: item.index, url: item.url, title: item.title, message, code: "batch_request_failed" });
        }
      } else {
        newAssets.push(...data.assets);
        for (const failure of data.failures) {
          const item = chunk[failure.index];
          newFailures.push({
            index: item ? item.index : failure.index,
            url: failure.url,
            title: item?.title,
            message: failure.message,
            code: failure.code,
          });
        }
      }
      done += chunk.length;
      success = newAssets.length;
      setBatchProgress((prev) =>
        prev
          ? { ...prev, done, success, failed: newFailures.length }
          : prev,
      );
    }
    return { newAssets, newFailures };
  }

  async function handleBatchStart(retryFailed: boolean) {
    let runItems: BatchRunItem[];
    let groupTitle: string;
    if (retryFailed) {
      if (batchFailures.length === 0) return;
      runItems = batchFailures.map((f) => ({ index: f.index, url: f.url, ...(f.title ? { title: f.title } : {}) }));
      groupTitle = batchGroupTitle.trim();
    } else {
      const parsed = parseBatchUrlLines(batchText);
      if (parsed.length === 0) {
        showAlert(t("admin.media_library.batch_no_lines"));
        return;
      }
      groupTitle = batchGroupTitle.trim();
      runItems = titleBatchItems(parsed, groupTitle).map((item, i) => ({ ...item, index: i }));
      batchGroupKeyRef.current = groupTitle ? generateBatchGroupKey() : undefined;
      setBatchFailures([]);
    }
    batchStopRef.current = false;
    setBatchStopped(false);
    setBatchRunning(true);
    try {
      const { newAssets, newFailures } = await runBatch(runItems, groupTitle, batchGroupKeyRef.current);
      setBatchFailures(newFailures);
      setBatchStopped(batchStopRef.current);
      if (newAssets.length > 0) {
        setAssets((prev) => [...newAssets, ...prev]);
      }
    } finally {
      setBatchRunning(false);
    }
  }

  function handleBatchClose() {
    if (batchRunning) return;
    setBatchOpen(false);
    setBatchText("");
    setBatchGroupTitle("");
    setBatchProgress(null);
    setBatchFailures([]);
    setBatchStopped(false);
    batchGroupKeyRef.current = undefined;
  }

  async function handleFromUrlDownload() {
    const raw = fromUrl.trim();
    if (!raw) {
      showAlert(t("admin.media_library.from_url_invalid"));
      return;
    }
    // 「整组导入」开关只影响 Instagram 帖子链接：关掉时追加 img_index=1 只取第 1 张
    const url = applyInstagramBatchPreference(raw, fromUrlBatchAll);
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
      setAssets((prev) => {
        // ?img_index=all 批量导入时服务端返回 { assets, warnings }
        const batch = (data as { assets?: unknown }).assets;
        const list = Array.isArray(batch) ? batch : [data];
        return [...(list as typeof prev), ...prev];
      });
      const warnings = (data as { warnings?: unknown }).warnings;
      if (Array.isArray(warnings) && warnings.length > 0) {
        // 部分成功也必须说清楚：哪些跳过了、哪一张失败了
        showAlert(warnings.join("\n"));
      }
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
        <div className="flex flex-wrap items-center gap-2">
          {uploading && uploadProgress !== null && (
            <span className="text-xs text-neutral-500">{uploadProgress}%</span>
          )}
          <input
            type="text"
            value={uploadGroupTitle}
            disabled={uploading}
            onChange={(e) => setUploadGroupTitle(e.target.value)}
            placeholder={t("admin.media_library.upload_group_title")}
            className="w-44 rounded-full border border-black/10 bg-w px-3 py-1.5 text-xs t-primary outline-none focus:border-theme disabled:opacity-60 dark:border-white/10"
          />
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
            disabled={uploading || downloading || batchRunning}
            onClick={() => setBatchOpen(true)}
            className="rounded-full border border-black/10 px-4 py-1.5 text-xs font-medium t-secondary transition-colors hover:border-theme/40 hover:text-theme disabled:opacity-60 dark:border-white/10"
          >
            <i className="ri-stack-line mr-1" />
            {t("admin.media_library.batch_from_url")}
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
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length > 0) void handlePickedFiles(files);
            }}
          />
        </div>
      </div>

      {uploadQueue && (
        <div className="rounded-2xl border border-black/10 bg-w p-3 text-xs t-primary dark:border-white/10">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t("admin.media_library.upload_queue", { done: uploadQueue.done, total: uploadQueue.total })}
              {uploadQueue.current ? ` · ${t("admin.media_library.upload_queue_current", { name: uploadQueue.current })}` : ""}
              {uploadQueue.stopped ? ` · ${t("admin.media_library.batch_stopped")}` : ""}
            </span>
            <span className="flex gap-2">
              {uploading && (
                <button
                  type="button"
                  onClick={() => {
                    uploadStopRef.current = true;
                  }}
                  className="rounded-full border border-black/10 px-2.5 py-0.5 t-secondary hover:border-theme/40 hover:text-theme dark:border-white/10"
                >
                  {t("admin.media_library.batch_stop")}
                </button>
              )}
              {!uploading && (
                <button
                  type="button"
                  onClick={() => setUploadQueue(null)}
                  className="rounded-full border border-black/10 px-2.5 py-0.5 t-secondary hover:border-theme/40 hover:text-theme dark:border-white/10"
                >
                  {t("admin.media_library.batch_dismiss")}
                </button>
              )}
            </span>
          </div>
          {uploadQueue.failures.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-neutral-500 dark:text-neutral-400">
              {uploadQueue.failures.map((failure, i) => (
                <li key={`${failure.name}-${i}`} className="truncate">
                  {failure.name} — {failure.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <Waiting />
      ) : assets.length === 0 ? (
        <p className="py-12 text-center text-sm text-neutral-500 dark:text-neutral-400">
          {t("admin.media_library.empty")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {groupAssets(assets).map((group) =>
              group.items.length > 1 ? (
                <AssetGroupCard
                  key={group.key}
                  items={group.items}
                  onChanged={(next) =>
                    setAssets((prev) => prev.map((a) => (a.id === next.id ? next : a)))
                  }
                  onDeleted={(id) => setAssets((prev) => prev.filter((a) => a.id !== id))}
                />
              ) : (
                <AssetCard
                  key={group.items[0]!.id}
                  asset={group.items[0]!}
                  onChanged={(next) =>
                    setAssets((prev) => prev.map((a) => (a.id === next.id ? next : a)))
                  }
                  onDeleted={(id) => setAssets((prev) => prev.filter((a) => a.id !== id))}
                />
              ),
            )}
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
            {isInstagramPostUrl(fromUrl) && (
              <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <input
                  type="checkbox"
                  checked={fromUrlBatchAll}
                  disabled={downloading}
                  onChange={(e) => setFromUrlBatchAll(e.target.checked)}
                  className="h-4 w-4 shrink-0 accent-theme disabled:opacity-60"
                />
                {t("admin.media_library.from_url_batch_all")}
              </label>
            )}
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
      {batchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => {
            if (!batchRunning) handleBatchClose();
          }}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-black/10 bg-w p-5 dark:border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-sm font-medium t-primary">
              {t("admin.media_library.batch_from_url_title")}
            </h3>
            <label className="mb-1 block text-xs text-neutral-500 dark:text-neutral-400">
              {t("admin.media_library.batch_from_url_text")}
            </label>
            <textarea
              value={batchText}
              disabled={batchRunning}
              onChange={(e) => setBatchText(e.target.value)}
              placeholder={t("admin.media_library.batch_from_url_text_placeholder")}
              rows={8}
              className="mb-1 w-full rounded-xl border border-black/10 bg-w p-3 text-sm t-primary outline-none focus:border-theme disabled:opacity-60 dark:border-white/10"
            />
            <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
              {t("admin.media_library.batch_from_url_hint")}
            </p>
            <label className="mb-1 block text-xs text-neutral-500 dark:text-neutral-400">
              {t("admin.media_library.batch_group_title")}
            </label>
            <input
              type="text"
              value={batchGroupTitle}
              disabled={batchRunning}
              onChange={(e) => setBatchGroupTitle(e.target.value)}
              placeholder={t("admin.media_library.batch_group_title_placeholder")}
              className="mb-3 w-full rounded-xl border border-black/10 bg-w p-3 text-sm t-primary outline-none focus:border-theme disabled:opacity-60 dark:border-white/10"
            />
            {batchProgress && (
              <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                {t("admin.media_library.batch_progress", {
                  chunk: batchProgress.chunk,
                  chunks: batchProgress.chunks,
                  done: batchProgress.done,
                  total: batchProgress.total,
                  success: batchProgress.success,
                  failed: batchProgress.failed,
                })}
                {batchStopped ? ` · ${t("admin.media_library.batch_stopped")}` : ""}
              </p>
            )}
            {batchFailures.length > 0 && (
              <ul className="mb-3 max-h-40 space-y-1 overflow-auto text-xs text-neutral-500 dark:text-neutral-400">
                {batchFailures.map((failure) => (
                  <li key={`${failure.index}-${failure.url}`} className="truncate">
                    #{failure.index + 1} {failure.url} — {failure.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-5 flex justify-end gap-2">
              {batchRunning && (
                <button
                  type="button"
                  onClick={() => {
                    batchStopRef.current = true;
                  }}
                  className="rounded-full border border-black/10 px-4 py-1.5 text-xs font-medium t-secondary hover:border-theme/40 hover:text-theme dark:border-white/10"
                >
                  {t("admin.media_library.batch_stop")}
                </button>
              )}
              {!batchRunning && batchFailures.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleBatchStart(true)}
                  className="rounded-full border border-black/10 px-4 py-1.5 text-xs font-medium t-secondary hover:border-theme/40 hover:text-theme dark:border-white/10"
                >
                  {t("admin.media_library.batch_retry_failed")}
                </button>
              )}
              <button
                type="button"
                disabled={batchRunning}
                onClick={handleBatchClose}
                className="rounded-full px-4 py-1.5 text-xs font-medium t-secondary hover:t-primary disabled:opacity-60"
              >
                {t("admin.media_library.from_url_cancel")}
              </button>
              <button
                type="button"
                disabled={batchRunning || !batchText.trim()}
                onClick={() => void handleBatchStart(false)}
                className="rounded-full bg-theme px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-theme-hover disabled:opacity-60"
              >
                {batchRunning
                  ? t("admin.media_library.from_url_downloading")
                  : t("admin.media_library.batch_start")}
              </button>
            </div>
          </div>
        </div>
      )}
      <AlertUI />
    </div>
  );
}
