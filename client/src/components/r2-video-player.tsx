// R2 click-to-play HTML5 video player for the story page and the media center.
//
// State machine (pure, unit-tested via getR2VideoPlayerState):
//   empty    -> nothing playable (no asset.url): gentle card
//   ready    -> playable: poster + click-to-play <video>
//
// Subtitles: when asset.subtitles_url is present, a <track kind="subtitles">
// is attached so the native control offers CC selection.
// Progress: resume position is restored on loadedmetadata; timeupdate/pause/ended
// persist the position with the Stage 3 LocalStorage video-progress record.

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaAsset, VideoPayload } from "../api/story";
import { loadVideoProgress, saveVideoProgress } from "../utils/media-progress";
import { formatDuration } from "./story-blocks/block-utils";

export type R2VideoPlayerState = "ready" | "empty";

export function getR2VideoPlayerState(asset: MediaAsset | undefined): R2VideoPlayerState {
  if (!asset?.url) return "empty";
  return "ready";
}

/** Where to resume playback for this asset (seconds), or undefined. */
export function r2VideoResumeAt(assetId: number | string, duration?: number): number | undefined {
  const record = loadVideoProgress(assetId);
  if (!record) return undefined;
  if (record.seconds < 3) return undefined;
  if (typeof duration === "number" && record.seconds > Math.max(0, duration - 10)) return undefined;
  return record.seconds;
}

export function R2VideoPlayer({
  payload,
  storySlug,
  onReveal,
}: {
  payload: VideoPayload;
  storySlug?: string;
  onReveal?: () => void;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const asset: MediaAsset | undefined = payload.asset;
  const state = getR2VideoPlayerState(asset);
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

  const persist = () => {
    const video = videoRef.current;
    if (!video || !asset?.id) return;
    saveVideoProgress({
      assetId: asset.id,
      seconds: video.currentTime,
      title: payload.title,
      storySlug,
    });
  };

  const resume = () => {
    const video = videoRef.current;
    if (!video || !asset?.id) return;
    const at = r2VideoResumeAt(asset.id, video.duration || duration);
    if (typeof at === "number") {
      try {
        video.currentTime = at;
      } catch {
        // ignore: some browsers throw before metadata is fully applied
      }
    }
  };

  const resumeLabel =
    asset?.id !== undefined ? r2VideoResumeAt(asset.id, duration) : undefined;

  return shell(
    <div className="relative aspect-video bg-black">
      {playing ? (
        <video
          ref={videoRef}
          src={asset!.url}
          poster={asset!.poster_url}
          controls
          playsInline
          preload="metadata"
          className="h-full w-full"
          onLoadedMetadata={resume}
          onTimeUpdate={persist}
          onPause={persist}
          onEnded={() => {
            const video = videoRef.current;
            if (video && asset?.id) {
              saveVideoProgress({ assetId: asset.id, seconds: 0, title: payload.title, storySlug });
            }
          }}
        >
          {asset!.subtitles_url && (
            <track kind="subtitles" src={asset!.subtitles_url} label={t("story.detail.subtitles")} />
          )}
        </video>
      ) : (
        <button
          type="button"
          onClick={() => {
            setPlaying(true);
            onReveal?.();
          }}
          aria-label={t("story.detail.play_video")}
          className="group relative block h-full w-full"
        >
          {asset!.poster_url && (
            <img src={asset!.poster_url} alt="" loading="lazy" className="h-full w-full object-cover" />
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors group-hover:bg-black/40">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90 text-2xl text-neutral-900 transition-transform group-hover:scale-105">
              <i className="ri-play-fill" />
            </span>
          </span>
          {typeof resumeLabel === "number" && (
            <span className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">
              {t("story.detail.resume_from", { time: formatDuration(resumeLabel) })}
            </span>
          )}
        </button>
      )}
    </div>,
  );
}
