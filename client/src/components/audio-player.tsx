// AudioPlayer: in-site audio player for story audio blocks (Stage 2).
//
// Custom controls: play/pause, draggable progress bar, playback speed
// (0.75 / 1 / 1.25 / 1.5 / 2), clickable chapter list, and progress memory:
// the playback position is persisted to localStorage (throttled while
// playing, saved on pause) and restored on the next visit.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AudioPayload } from "../api/story";
import {
  AUDIO_PLAYBACK_RATES,
  audioProgressKey,
  findChapterIndex,
  formatDuration,
  parseStoredProgress,
  shouldPersistProgress,
} from "./story-blocks/block-utils";

export function AudioPlayer({
  payload,
  onPlay,
  onEnded,
  initialTime,
}: {
  payload: AudioPayload;
  /** fired when playback starts (analytics milestone) */
  onPlay?: () => void;
  /** fired when the track ends naturally (queue auto-advance) */
  onEnded?: () => void;
  /** explicit start offset in seconds; takes precedence over stored progress */
  initialTime?: number;
}) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const currentTimeRef = useRef(0);
  const lastSavedRef = useRef(0);
  const restoredRef = useRef(false);
  const initialSeekDoneRef = useRef(false);

  const asset = payload.asset;
  const src = asset?.url;
  const chapters = payload.chapters ?? [];
  const storageKey = audioProgressKey(asset?.id);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(asset?.duration ?? payload.duration ?? 0);
  const [rate, setRate] = useState<number>(1);

  function persistProgress(time: number) {
    try {
      localStorage.setItem(storageKey, String(time));
      lastSavedRef.current = Date.now();
    } catch {
      // private mode / quota — non-fatal
    }
  }

  // Restore persisted progress (and flush on unmount) per asset.
  useEffect(() => {
    restoredRef.current = false;
    lastSavedRef.current = 0;
    return () => {
      if (currentTimeRef.current > 0) {
        persistProgress(currentTimeRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  if (!src) {
    return (
      <div className="flex items-center gap-4 rounded-2xl border border-black/10 bg-w p-4 dark:border-white/10">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-neutral-300">
          <i className="ri-music-2-line text-2xl opacity-70" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium t-primary">{payload.title || t("story.detail.untitled_audio")}</p>
          <p className="mt-1 text-xs text-neutral-400">{t("story.detail.no_audio")}</p>
        </div>
      </div>
    );
  }

  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    const naturalDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (naturalDuration > 0) {
      setDuration(naturalDuration);
    }
    if (!restoredRef.current) {
      restoredRef.current = true;
      // An explicit ?t= start offset wins over the stored progress.
      if (
        !initialSeekDoneRef.current &&
        typeof initialTime === "number" &&
        Number.isFinite(initialTime) &&
        initialTime > 1
      ) {
        initialSeekDoneRef.current = true;
        const target = Math.max(0, initialTime);
        audio.currentTime = target;
        currentTimeRef.current = target;
        setCurrentTime(target);
        return;
      }
      const saved = parseStoredProgress(localStorage.getItem(storageKey));
      const knownDuration = naturalDuration > 0 ? naturalDuration : duration;
      if (
        saved !== undefined &&
        saved > 1 &&
        (knownDuration <= 0 || saved < knownDuration - 2)
      ) {
        audio.currentTime = saved;
        currentTimeRef.current = saved;
        setCurrentTime(saved);
      }
    }
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) return;
    const time = audio.currentTime;
    currentTimeRef.current = time;
    setCurrentTime(time);
    if (shouldPersistProgress(lastSavedRef.current, Date.now())) {
      persistProgress(time);
    }
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      persistProgress(audio.currentTime);
      setPlaying(false);
    } else {
      void audio.play().catch(() => {
        setPlaying(false);
      });
      setPlaying(true);
      onPlay?.();
    }
  }

  function seekTo(time: number) {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time));
    audio.currentTime = clamped;
    currentTimeRef.current = clamped;
    setCurrentTime(clamped);
    persistProgress(clamped);
  }

  function cycleRate() {
    const rates: readonly number[] = AUDIO_PLAYBACK_RATES;
    const next = rates[(rates.indexOf(rate) + 1) % rates.length] ?? 1;
    setRate(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
    }
  }

  const activeChapter = findChapterIndex(chapters, currentTime);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  return (
    <div className="rounded-2xl border border-black/10 bg-w p-4 dark:border-white/10">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? t("story.detail.pause") : t("story.detail.play")}
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-theme text-xl text-white transition-colors hover:bg-theme-hover"
        >
          <i className={playing ? "ri-pause-fill" : "ri-play-fill"} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium t-primary">{payload.title || t("story.detail.untitled_audio")}</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {formatDuration(currentTime)} / {formatDuration(safeDuration)}
          </p>
          <input
            type="range"
            min={0}
            max={safeDuration || 0}
            step={0.1}
            value={Math.min(currentTime, safeDuration || currentTime)}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label={t("story.detail.seek")}
            className="mt-1 w-full accent-theme"
          />
        </div>
        <button
          type="button"
          onClick={cycleRate}
          title={t("story.detail.speed")}
          aria-label={t("story.detail.speed")}
          className="shrink-0 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium t-secondary transition-colors hover:t-primary"
        >
          {rate}×
        </button>
      </div>

      {chapters.length > 0 && (
        <div className="mt-3 border-t border-black/5 pt-3 dark:border-white/5">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {t("story.detail.chapters")}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {chapters.map((chapter, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => seekTo(chapter.start)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                    index === activeChapter
                      ? "bg-theme/10 text-theme"
                      : "t-secondary hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  <span className="shrink-0 font-mono text-xs text-neutral-400">
                    {formatDuration(chapter.start)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                  {index === activeChapter && <i className="ri-volume-up-line shrink-0 text-xs" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => {
          setPlaying(false);
          persistProgress(0);
          onEnded?.();
        }}
        className="hidden"
      />
    </div>
  );
}
