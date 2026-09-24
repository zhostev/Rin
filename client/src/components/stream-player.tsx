// Cloudflare Stream click-to-load player for the theme story page.
//
// State machine (pure, unit-tested via getStreamPlayerState):
//   error      -> stream_status=error: error card with stream_error
//   processing -> stream_status=uploading|processing: transcoding card
//   empty      -> nothing playable (no embed_url and no stream_uid): gentle card
//   ready      -> playable: poster + click-to-load Cloudflare iframe
//
// A playable asset with no explicit stream_status (hand-entered stream_uid or
// a legacy payload) is treated as ready. The iframe prefers the contracted
// embed_url (from the status endpoint's playback_url) and falls back to the
// official iframe URL built from stream_uid.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaAsset, VideoPayload } from "../api/story";
import { formatDuration } from "./story-blocks/block-utils";

export type StreamPlayerState = "ready" | "processing" | "error" | "empty";

export function getStreamPlayerState(
  asset: MediaAsset | undefined,
  payloadUid?: string,
): StreamPlayerState {
  const status = asset?.stream_status;
  if (status === "error") return "error";
  if (status === "uploading" || status === "processing") return "processing";
  const uid = asset?.stream_uid || payloadUid;
  if (!asset?.embed_url && !uid) return "empty";
  return "ready";
}

export function streamIframeSrc(asset: MediaAsset | undefined, uid?: string): string {
  if (asset?.embed_url) return asset.embed_url;
  return `https://iframe.videodelivery.net/${encodeURIComponent(uid ?? "")}`;
}

export function StreamPlayer({ payload }: { payload: VideoPayload }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const asset: MediaAsset | undefined = payload.asset;
  const uid = asset?.stream_uid || payload.stream_uid;
  const state = getStreamPlayerState(asset, payload.stream_uid);
  const duration = asset?.duration ?? payload.duration;

  const infoRow = (
    <div className="flex items-center gap-3 p-4">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium t-primary">{payload.title || t("story.detail.untitled_video")}</p>
        <p className="text-xs text-neutral-500">
          {[asset?.mime, typeof duration === "number" ? formatDuration(duration) : undefined]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    </div>
  );

  const shell = (body: React.ReactNode) => (
    <div className="overflow-hidden rounded-2xl border border-black/10 bg-w dark:border-white/10">
      {body}
      {infoRow}
    </div>
  );

  if (state === "empty") {
    return shell(
      <div className="flex aspect-video flex-col items-center justify-center gap-2 bg-neutral-900 text-neutral-300">
        <i className="ri-video-line text-4xl opacity-60" />
        <p className="px-6 text-center text-sm opacity-80">{t("story.detail.no_video")}</p>
      </div>,
    );
  }

  if (state === "error") {
    return shell(
      <div className="flex aspect-video flex-col items-center justify-center gap-2 bg-neutral-900 px-6 text-center text-neutral-300">
        <i className="ri-error-warning-line text-4xl opacity-60" />
        <p className="text-sm opacity-80">{t("story.detail.video_error")}</p>
        {asset?.stream_error && <p className="max-w-full truncate text-xs opacity-60">{asset.stream_error}</p>}
      </div>,
    );
  }

  if (state === "processing") {
    return shell(
      <div className="flex aspect-video flex-col items-center justify-center gap-2 bg-neutral-900 text-neutral-300">
        <i className="ri-loader-4-line animate-spin text-4xl opacity-60" />
        <p className="px-6 text-center text-sm opacity-80">{t("story.detail.video_transcoding")}</p>
      </div>,
    );
  }

  const poster =
    asset?.thumbnail_url ||
    (uid ? `https://videodelivery.net/${encodeURIComponent(uid)}/thumbnails/thumbnail.jpg` : undefined);

  return shell(
    <div className="relative aspect-video bg-black">
      {revealed ? (
        <iframe
          src={streamIframeSrc(asset, uid)}
          title={payload.title || t("story.detail.untitled_video")}
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
          allowFullScreen
          className="h-full w-full"
        />
      ) : (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          aria-label={t("story.detail.play_video")}
          className="group relative block h-full w-full"
        >
          {poster && <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover" />}
          <span className="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors group-hover:bg-black/40">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90 text-2xl text-neutral-900 transition-transform group-hover:scale-105">
              <i className="ri-play-fill" />
            </span>
          </span>
        </button>
      )}
    </div>,
  );
}
