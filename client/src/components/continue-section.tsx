// Homepage "continue" section (Stage 3).
//
// Renders only when this device has local progress records (video / audio /
// read). Each entry shows the title, the last position, and a deep link that
// resumes where the user left off. No progress on this device => renders
// nothing, per the design ("只在本机有进度时出现").

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { formatDuration } from "./story-blocks";
import { collectContinueEntries, type ContinueEntry } from "../utils/media-progress";

const KIND_META: Record<ContinueEntry["kind"], { icon: string; labelKey: string }> = {
  video: { icon: "ri-video-line", labelKey: "continue.resume_video" },
  audio: { icon: "ri-music-2-line", labelKey: "continue.resume_audio" },
  read: { icon: "ri-book-open-line", labelKey: "continue.resume_read" },
};

function positionLabel(entry: ContinueEntry, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (entry.kind === "read" && typeof entry.fraction === "number") {
    return t("continue.read_percent", { percent: Math.round(entry.fraction * 100) });
  }
  if (typeof entry.seconds === "number" && entry.seconds > 1) {
    return formatDuration(entry.seconds);
  }
  return "";
}

export function ContinueSection() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ContinueEntry[]>([]);

  useEffect(() => {
    const refresh = () => setEntries(collectContinueEntries(5));
    refresh();
    // Pick up progress written while a story/media tab was open.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  if (entries.length === 0) return null;

  return (
    <section aria-label={t("continue.title")} className="wauto w-full mb-2">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold t-primary">
        <i className="ri-history-line text-theme" />
        {t("continue.title")}
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {entries.map((entry, index) => {
          const meta = KIND_META[entry.kind];
          const label = positionLabel(entry, t as (key: string, options?: Record<string, unknown>) => string);
          return (
            <Link
              key={`${entry.kind}-${entry.href}-${index}`}
              href={entry.href}
              className="flex items-center gap-3 rounded-2xl bg-w p-3 transition-colors hover:bg-secondary/60"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-theme/10 text-lg text-theme">
                <i className={meta.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                  {t(meta.labelKey)}
                  {label ? ` · ${label}` : ""}
                </span>
                <span className="block truncate text-sm font-medium t-primary">
                  {entry.title || entry.href}
                </span>
              </span>
              <i className="ri-arrow-right-s-line shrink-0 text-neutral-400" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
