// PublicStoriesPage: public story list (/stories).
//
// The homepage article list only queries feeds, so stories were previously
// reachable only by direct /story/:slug link. This page lists published
// and updated stories (via GET /api/story, no block payloads) newest first,
// with a site-header entry so a story can be found without knowing its slug.

import { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { Link, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import { Waiting } from "../components/loading";
import { Tips } from "../components/tips";
import { client } from "../app/runtime";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants";
import { timeago } from "../utils/timeago";
import { tryInt } from "../utils/int";
import type { StoryListItem } from "../api/story";

export function PublicStoriesPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const query = new URLSearchParams(useSearch());
  const page = tryInt(1, query.get("page"));
  const [items, setItems] = useState<StoryListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoaded(false);
    setError("");
    client.story.listPublic({ page, limit: siteConfig.pageSize }).then(({ data, error }) => {
      if (error || !data) {
        setError(typeof error?.value === "string" ? error.value : t("story.list.public_failed"));
      } else {
        setItems(data.stories ?? []);
        setTotal(data.total);
        setHasNext(data.hasNext);
      }
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <>
      <Helmet>
        <title>{`${t("story.list.public_title")} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t("story.list.public_title")} />
        <meta property="og:image" content={siteConfig.avatar} />
      </Helmet>
      <Waiting for={loaded}>
        <main className="w-full flex flex-col justify-center items-center mb-8">
          <div className="wauto text-start text-black dark:text-white py-4 text-4xl font-bold">
            <p>{t("story.list.public_title")}</p>
            <p className="text-sm mt-4 text-neutral-500 font-normal">
              {t("story.list.total$count", { count: total })}
            </p>
          </div>
          {error ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-black/10 p-8 dark:border-white/10">
              <Tips value={error} type="error" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-black/10 p-12 text-center dark:border-white/10">
              <i className="ri-book-open-line text-4xl text-neutral-300 dark:text-neutral-600" />
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("story.list.public_empty")}</p>
            </div>
          ) : (
            <div className="wauto flex flex-col gap-4 ani-show">
              {items.map((item) => (
                <Link key={item.id} href={`/story/${item.slug}`} className="block rounded-2xl bg-w p-4 hover:bg-secondary/60">
                  <article className="flex gap-4">
                    {item.coverAssetId ? (
                      <img
                        src={`/api/media/${item.coverAssetId}/playback`}
                        alt=""
                        className="h-24 w-24 shrink-0 rounded-xl object-cover"
                        loading="lazy"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <h2 className="text-lg font-bold t-primary break-all">{item.title}</h2>
                      {item.summary ? (
                        <p className="mt-1 text-sm leading-6 t-secondary line-clamp-2">{item.summary}</p>
                      ) : null}
                      {item.updated_at ? (
                        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{timeago(item.updated_at)}</p>
                      ) : null}
                    </div>
                  </article>
                </Link>
              ))}
            </div>
          )}
          <div className="wauto flex flex-row items-center mt-4 ani-show">
            {page > 1 && (
              <Link
                href={`/stories?page=${page - 1}`}
                className="text-sm font-normal rounded-full px-4 py-2 text-white bg-theme"
              >
                {t("previous")}
              </Link>
            )}
            <div className="flex-1" />
            {hasNext && (
              <Link
                href={`/stories?page=${page + 1}`}
                className="text-sm font-normal rounded-full px-4 py-2 text-white bg-theme"
              >
                {t("next")}
              </Link>
            )}
          </div>
        </main>
      </Waiting>
    </>
  );
}
