// MediaPicker: unified media selector for story blocks (Stage 2).
//
// Tabs:
//   1. Upload — kind-aware R2 presigned direct-upload flows
//        (utils/media-upload.ts: mint → browser PUTs bytes straight to R2 →
//        complete; no 100MB Worker cap; Cloudflare Stream/Images stay disabled):
//        image/gallery -> R2 direct upload;
//        video         -> R2 direct upload (duration/dimensions probed client-side);
//        audio         -> R2 direct upload;
//        attachment    -> legacy POST /api/storage.
//   2. Link   — paste an external URL (Stream / R2 / CDN).
//   3. Library — browse server-side assets (GET /api/admin/media?kind=).
//   4. Recent — assets uploaded in this browser (localStorage).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { client } from "../../app/runtime";
import type { AssetKind, MediaAsset } from "../../api/story";
import { isNotConfiguredError } from "../../api/media";
import { probeMediaFile } from "../../utils/media-probe";
import { uploadMediaFile } from "../../utils/media-upload";
import { formatDuration, kindForMime } from "./block-utils";

const RECENT_KEY = "s7ea.story.media.recent.v1";
const RECENT_LIMIT = 24;

type PickerTab = "upload" | "link" | "library" | "recent";

function loadRecent(): MediaAsset[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as MediaAsset[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecent(assets: MediaAsset[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(assets.slice(0, RECENT_LIMIT)));
  } catch {
    // storage full / private mode — non-fatal
  }
}

const ACCEPT_FOR_KIND: Record<AssetKind, string> = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
  gallery: "image/*",
  attachment: "*/*",
};

export function MediaPicker({
  open,
  kind,
  onSelect,
  onClose,
}: {
  open: boolean;
  kind: AssetKind;
  onSelect: (asset: MediaAsset) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PickerTab>("upload");
  const [recent, setRecent] = useState<MediaAsset[]>([]);
  const [url, setUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLabel, setUploadLabel] = useState("");
  const [error, setError] = useState("");
  const [library, setLibrary] = useState<MediaAsset[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (open) {
      setTab("upload");
      setUrl("");
      setLinkTitle("");
      setError("");
      setUploading(false);
      setUploadProgress(0);
      setLibrary([]);
      setRecent(loadRecent().filter((asset) => asset.kind === kind || kind === "attachment"));
    }
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, [open, kind]);

  useEffect(() => {
    if (open && tab === "library" && library.length === 0 && !libraryLoading) {
      void loadLibrary();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, open]);

  if (!open) return null;

  function remember(asset: MediaAsset) {
    const next = [asset, ...loadRecent().filter((item) => item.url !== asset.url)].slice(0, RECENT_LIMIT);
    saveRecent(next);
    setRecent(next.filter((item) => item.kind === kind || kind === "attachment"));
  }

  function choose(asset: MediaAsset) {
    remember(asset);
    onSelect(asset);
    onClose();
  }

  async function loadLibrary() {
    setLibraryLoading(true);
    setError("");
    try {
      const { data, error } = await client.media.list(
        kind === "attachment" ? undefined : kind,
      );
      if (error || !data) {
        throw new Error(typeof error?.value === "string" ? error.value : t("story.editor.picker.library_failed"));
      }
      if (cancelledRef.current) return;
      setLibrary(data.data ?? []);
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : t("story.editor.picker.library_failed"));
      }
    } finally {
      if (!cancelledRef.current) {
        setLibraryLoading(false);
      }
    }
  }

  function reportProgress(loaded: number, total: number) {
    if (total > 0 && !cancelledRef.current) {
      setUploadProgress(loaded / total);
    }
  }

  /** Map a mint/HTTP error to a user-facing message; 503 means "not configured". */
  function friendlyUploadError(err: unknown, httpError: { status?: number } | undefined, fallback: string): string {
    if (isNotConfiguredError(httpError) || isNotConfiguredError(err as { status?: number })) {
      return t("story.editor.picker.not_configured");
    }
    return err instanceof Error ? err.message : fallback;
  }

  /**
   * Upload via the shared R2 presigned direct-upload flow
   * (utils/media-upload.ts): mint → PUT bytes straight to R2 → complete.
   * Falls back to the legacy Worker-proxied upload when the backend has no
   * S3 credentials (audio/video only). Cloudflare Images stays disabled.
   */
  async function uploadPickedFile(
    file: File,
    mediaType: "image" | "video" | "audio",
    labelKey: string,
  ): Promise<MediaAsset> {
    const { asset } = await uploadMediaFile(file, mediaType, {
      t,
      onProgress: (percent) => {
        if (percent === null || cancelledRef.current) return;
        reportProgress(percent / 100, 1);
        setUploadLabel(t(labelKey, { percent }));
      },
    });
    return {
      ...asset,
      title: asset.title || file.name,
      alt: asset.alt || file.name,
    };
  }

  /** image/gallery: R2 presigned direct upload. */
  function uploadImage(file: File): Promise<MediaAsset> {
    return uploadPickedFile(file, "image", "story.editor.image_uploading");
  }

  /** video: R2 presigned direct upload (progress events); playable immediately. */
  function uploadVideo(file: File): Promise<MediaAsset> {
    return uploadPickedFile(file, "video", "story.editor.video_uploading");
  }

  /** audio: R2 presigned direct upload (progress events). */
  function uploadAudio(file: File): Promise<MediaAsset> {
    return uploadPickedFile(file, "audio", "story.editor.audio_uploading");
  }

  async function handleFile(file: File) {
    setUploading(true);
    setUploadProgress(0);
    setUploadLabel("");
    setError("");
    try {
      let asset: MediaAsset;
      if (kind === "image" || kind === "gallery") {
        asset = await uploadImage(file);
      } else if (kind === "video") {
        asset = await uploadVideo(file);
      } else if (kind === "audio") {
        asset = await uploadAudio(file);
      } else {
        const probed = await probeMediaFile(file);
        const { data, error } = await client.storage.upload(file, file.name);
        if (error) {
          throw new Error(error.value as string);
        }
        const uploadedUrl = typeof data === "string" ? data : data?.url;
        if (!uploadedUrl) {
          throw new Error(t("story.editor.picker.upload_failed"));
        }
        asset = {
          id: 0,
          kind: kindForMime(file.type) ?? kind,
          mime: file.type,
          duration: probed.duration,
          width: probed.width,
          height: probed.height,
          url: uploadedUrl,
          title: file.name,
        };
      }
      if (!cancelledRef.current) {
        choose(asset);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(friendlyUploadError(err, undefined, t("story.editor.picker.upload_failed")));
      }
    } finally {
      if (!cancelledRef.current) {
        setUploading(false);
      }
    }
  }

  function handleLink() {
    const trimmed = url.trim();
    if (!trimmed) return;
    choose({
      id: 0,
      kind,
      source: "external",
      url: trimmed,
      title: linkTitle.trim() || trimmed,
    });
  }

  function removeRecent(target: MediaAsset) {
    const next = loadRecent().filter((item) => item.url !== target.url);
    saveRecent(next);
    setRecent(next.filter((item) => item.kind === kind || kind === "attachment"));
  }

  const tabButton = (key: PickerTab, label: string) =>
    (
      <button
        type="button"
        onClick={() => setTab(key)}
        className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
          tab === key ? "bg-theme text-white" : "bg-secondary t-secondary hover:t-primary"
        }`}
      >
        {label}
      </button>
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t("story.editor.picker.title")}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl bg-w p-6 shadow-xl t-primary">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("story.editor.picker.title")}</h2>
          <button type="button" aria-label={t("close")} onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-neutral-100 dark:hover:bg-white/10">
            <i className="ri-close-line text-xl" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {tabButton("upload", t("story.editor.picker.tab_upload"))}
          {tabButton("link", t("story.editor.picker.tab_url"))}
          {tabButton("library", t("story.editor.picker.tab_library"))}
          {tabButton("recent", t("story.editor.picker.tab_recent"))}
        </div>

        <div className="mt-4 min-h-48">
          {tab === "upload" && (
            <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-black/10 py-10 dark:border-white/10">
              <i className="ri-upload-cloud-2-line text-4xl text-neutral-400" />
              <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                {uploading ? (uploadLabel || t("story.editor.picker.uploading")) : t("story.editor.picker.upload_hint")}
              </p>
              {uploading && (
                <div
                  className="mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(uploadProgress * 100)}
                >
                  <div className="h-full rounded-full bg-theme transition-all" style={{ width: `${Math.round(uploadProgress * 100)}%` }} />
                </div>
              )}
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
                className="mt-4 rounded-full bg-theme px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-theme-hover disabled:opacity-60"
              >
                {t("story.editor.picker.choose_file")}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT_FOR_KIND[kind]}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleFile(file);
                }}
              />
            </div>
          )}

          {tab === "link" && (
            <div className="flex flex-col gap-3">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("story.editor.picker.url_placeholder")}
                className="w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10"
              />
              <input
                type="text"
                value={linkTitle}
                onChange={(e) => setLinkTitle(e.target.value)}
                placeholder={t("story.editor.picker.title_placeholder")}
                className="w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10"
              />
              <div>
                <button
                  type="button"
                  onClick={handleLink}
                  disabled={!url.trim()}
                  className="rounded-full bg-theme px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-theme-hover disabled:opacity-60"
                >
                  {t("story.editor.picker.use_url")}
                </button>
              </div>
            </div>
          )}

          {tab === "library" && (
            <>
              {library.length === 0 && !libraryLoading ? (
                <p className="py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  {t("story.editor.picker.library_empty")}
                </p>
              ) : (
                <>
                  <div className="grid max-h-80 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
                    {library.map((asset, index) => (
                      <div key={`${asset.id}-${asset.url ?? asset.stream_uid ?? index}`} className="group relative overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
                        <button type="button" onClick={() => choose(asset)} className="block w-full text-left">
                          {asset.kind === "image" && (asset.thumbnail_url || asset.url) ? (
                            <img src={asset.thumbnail_url ?? asset.url} alt={asset.alt || asset.title || ""} className="h-28 w-full object-cover" loading="lazy" />
                          ) : (
                            <div className="flex h-28 w-full flex-col items-center justify-center gap-1 bg-secondary">
                              <i className={`${asset.kind === "video" ? "ri-video-line" : asset.kind === "audio" ? "ri-music-2-line" : "ri-file-line"} text-2xl text-neutral-400`} />
                              {typeof asset.duration === "number" && (
                                <span className="text-xs text-neutral-500">{formatDuration(asset.duration)}</span>
                              )}
                            </div>
                          )}
                          <p className="truncate px-2 py-1.5 text-xs t-secondary">{asset.title || asset.url || asset.stream_uid}</p>
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex justify-center">
                    {libraryLoading && (
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("story.editor.picker.uploading")}</p>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {tab === "recent" && (
            <>
              {recent.length === 0 ? (
                <p className="py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  {t("story.editor.picker.no_recent")}
                </p>
              ) : (
                <div className="grid max-h-80 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
                  {recent.map((asset, index) => (
                    <div key={`${asset.url}-${index}`} className="group relative overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
                      <button type="button" onClick={() => choose(asset)} className="block w-full text-left">
                        {asset.kind === "image" && asset.url ? (
                          <img src={asset.url} alt={asset.alt || asset.title || ""} className="h-28 w-full object-cover" loading="lazy" />
                        ) : (
                          <div className="flex h-28 w-full flex-col items-center justify-center gap-1 bg-secondary">
                            <i className={`${asset.kind === "video" ? "ri-video-line" : asset.kind === "audio" ? "ri-music-2-line" : "ri-file-line"} text-2xl text-neutral-400`} />
                            {typeof asset.duration === "number" && (
                              <span className="text-xs text-neutral-500">{formatDuration(asset.duration)}</span>
                            )}
                          </div>
                        )}
                        <p className="truncate px-2 py-1.5 text-xs t-secondary">{asset.title || asset.url}</p>
                      </button>
                      <button
                        type="button"
                        aria-label={t("delete.title")}
                        onClick={() => removeRecent(asset)}
                        className="absolute right-1 top-1 hidden h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white group-hover:inline-flex"
                      >
                        <i className="ri-close-line" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      </div>
    </div>
  );
}
