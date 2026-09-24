// Series page (/series/:slug) — Stage 3.
//
// A series (专题) groups stories into an ordered sequence: the story list
// follows `position`, a progress bar shows completion (published/total),
// and a recent-updates list links back to each story page.

import { useCallback } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { client } from "../app/runtime";
import { Waiting } from "../components/loading";
import { Tips } from "../components/tips";
import { useApiResource } from "../hooks/use-api-resource";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants";
import { timeago } from "../utils/timeago";
import type { SeriesDetailResponse } from "../api/media-center";

export function PublicSeriesPage({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();

  const load = useCallback(() => client.mediaCenter.getSeries(slug), [slug]);
  const { data, error, loading } = useApiResource<SeriesDetailResponse>(load);

  const series = data?.series;
  const stories = Array.isArray(data?.stories)
    ? data.stories.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    : [];
  const completion = data?.completion;
  const recentUpdates = Array.isArray(data?.recentUpdates) ? data.recentUpdates : [];
  const published = completion?.published ?? 0;
  const total = completion?.total ?? 0;
  const percent = total > 0 ? Math.round((published / total) * 100) : 0;

  const title = series?.title ?? t("series.title");

  return (
    <>
      <Helmet>
        <title>{`${title} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={title} />
        <meta property="og:image" content={siteConfig.avatar} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={document.URL} />
      </Helmet>
      <Waiting for={!loading}>
        <main className="w-full flex flex-col justify-center items-center mb-8">
          {error && (
            <div className="wauto mb-4">
              <Tips value={String(error)} type="error" />
            </div>
          )}
          {series && (
            <div className="wauto flex flex-col gap-6">
              <header className="rounded-2xl bg-w p-6">
                <p className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("series.eyebrow")}
                </p>
                <h1 className="mt-1 text-3xl font-bold t-primary">{series.title}</h1>
                {series.summary && <p className="mt-2 text-sm leading-6 t-secondary">{series.summary}</p>}
                {total > 0 && (
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between text-xs text-neutral-500 dark:text-neutral-400">
                      <span>{t("series.completion")}</span>
                      <span>
                        {t("series.completion$count", { published, total, percent })}
                      </span>
                    </div>
                    <div
                      className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary"
                      role="progressbar"
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={t("series.completion")}
                    >
                      <div className="h-full rounded-full bg-theme transition-all" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                )}
              </header>

              <section aria-label={t("series.stories")} className="flex flex-col gap-2">
                <h2 className="text-lg font-semibold t-primary">{t("series.stories")}</h2>
                {stories.length === 0 && (
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("series.no_stories")}</p>
                )}
                <ol className="flex flex-col gap-2">
                  {stories.map((entry) => (
                    <li key={String(entry.storyId)}>
                      <Link
                        href={`/story/${entry.slug}`}
                        className="flex items-center gap-3 rounded-2xl bg-w p-4 transition-colors hover:bg-secondary/60"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold t-secondary">
                          {entry.position ?? "·"}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium t-primary">{entry.title}</span>
                          {entry.updatedAt && (
                            <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                              {t("series.updated$time", { time: timeago(entry.updatedAt) })}
                            </span>
                          )}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                            entry.status === "published"
                              ? "bg-theme/10 text-theme"
                              : "bg-secondary t-secondary"
                          }`}
                        >
                          {t(`series.status.${entry.status}`, { defaultValue: entry.status })}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </section>

              {recentUpdates.length > 0 && (
                <section aria-label={t("series.recent_updates")} className="flex flex-col gap-2">
                  <h2 className="text-lg font-semibold t-primary">{t("series.recent_updates")}</h2>
                  <ul className="flex flex-col gap-2">
                    {recentUpdates.map((update, index) => (
                      <li key={`${update.slug ?? index}`}>
                        {update.slug ? (
                          <Link
                            href={`/story/${update.slug}`}
                            className="flex items-center justify-between gap-3 rounded-2xl bg-w px-4 py-3 text-sm transition-colors hover:bg-secondary/60"
                          >
                            <span className="min-w-0 truncate t-primary">{update.title}</span>
                            {update.updatedAt && (
                              <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                                {timeago(update.updatedAt)}
                              </span>
                            )}
                          </Link>
                        ) : (
                          <div className="rounded-2xl bg-w px-4 py-3 text-sm t-secondary">{update.title}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </main>
      </Waiting>
    </>
  );
}
