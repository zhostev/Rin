// Admin placeholder pages for Stage 2 / Stage 4 modules.
// Each page is reachable from the sidebar but clearly marked with the stage
// that will implement it — no empty routes.

import { useTranslation } from "react-i18next";

function StagePlaceholder({ icon, titleKey, noteKey }: { icon: string; titleKey: string; noteKey: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-black/10 p-12 text-center dark:border-white/10">
      <i className={`${icon} text-4xl text-neutral-300 dark:text-neutral-600`} />
      <p className="text-base font-medium t-primary">{t(titleKey)}</p>
      <p className="max-w-md text-sm leading-6 text-neutral-500 dark:text-neutral-400">{t(noteKey)}</p>
      <span className="rounded-full bg-secondary px-3 py-1 text-xs t-secondary">
        {t("story.placeholder.scheduled")}
      </span>
    </div>
  );
}

export function MediaLibraryPage() {
  return (
    <StagePlaceholder
      icon="ri-image-2-line"
      titleKey="story.nav.media"
      noteKey="story.placeholder.media"
    />
  );
}

export function SeriesPage() {
  return (
    <StagePlaceholder
      icon="ri-stack-line"
      titleKey="story.nav.series"
      noteKey="story.placeholder.series"
    />
  );
}

export function MaintenancePage() {
  return (
    <StagePlaceholder
      icon="ri-tools-line"
      titleKey="story.nav.maintenance"
      noteKey="story.placeholder.maintenance"
    />
  );
}
