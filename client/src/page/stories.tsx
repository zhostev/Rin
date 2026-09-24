// StoriesPage: admin content-package list (Stage 1 skeleton).
// Lists stories via GET /api/story; create/edit/delete wired to the story API.

import { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import { useAlert, useConfirm } from "../components/dialog";
import { Tips } from "../components/tips";
import { Waiting } from "../components/loading";
import { client } from "../app/runtime";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants";
import { timeago } from "../utils/timeago";
import type { StoryListItem, StoryStatus } from "../api/story";

const STATUS_STYLES: Record<StoryStatus, string> = {
  draft: "bg-neutral-200 text-neutral-700 dark:bg-white/10 dark:text-neutral-300",
  scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  published: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  updated: "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
  archived: "bg-neutral-100 text-neutral-500 dark:bg-white/5 dark:text-neutral-500",
};

export function StoriesPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const [, setLocation] = useLocation();
  const [items, setItems] = useState<StoryListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const { showAlert, AlertUI } = useAlert();
  const { showConfirm, ConfirmUI } = useConfirm();

  function load() {
    setLoaded(false);
    setError("");
    client.story.list({ status: "all" }).then(({ data, error }) => {
      if (error) {
        setError(error.value as string);
      } else if (data) {
        setItems(data.stories ?? []);
      }
      setLoaded(true);
    });
  }

  useEffect(() => {
    load();
  }, []);

  function removeStory(item: StoryListItem) {
    showConfirm(
      t("story.list.delete_title"),
      t("story.list.delete_confirm", { title: item.title }),
      () => {
        client.story.remove(item.id).then(({ error }) => {
          if (error) {
            showAlert(error.value as string);
          } else {
            showAlert(t("delete.success"), () => load());
          }
        });
      },
    );
  }

  return (
    <>
      <Helmet>
        <title>{`${t("story.nav.stories")} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t("story.nav.stories")} />
        <meta property="og:image" content={siteConfig.avatar} />
      </Helmet>

      <div className="flex flex-col gap-4 t-primary">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("story.list.hint")}</p>
          <Link
            href="/admin/story-editor"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-theme px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-theme-hover"
          >
            <i className="ri-add-line" />
            {t("story.list.new_story")}
          </Link>
        </div>

        <Waiting for={loaded}>
          {error ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-black/10 p-8 dark:border-white/10">
              <Tips value={error} type="error" />
              <button
                type="button"
                onClick={load}
                className="rounded-full bg-theme px-5 py-2 text-sm font-medium text-white"
              >
                {t("reload")}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-black/10 p-12 text-center dark:border-white/10">
              <i className="ri-book-open-line text-4xl text-neutral-300 dark:text-neutral-600" />
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("story.list.empty")}</p>
              <button
                type="button"
                onClick={() => setLocation("/admin/story-editor")}
                className="rounded-full bg-theme px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-theme-hover"
              >
                {t("story.list.new_story")}
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-2xl border border-black/10 p-4 dark:border-white/10"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/story/${item.slug}`} className="truncate font-medium t-primary hover:text-theme">
                        {item.title}
                      </Link>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[item.status]}`}>
                        {t(`story.editor.status_${item.status}`)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                      /{item.slug}
                      {item.updated_at && <> · {timeago(item.updated_at)}</>}
                    </p>
                  </div>
                  <Link
                    href={`/admin/story-editor/${item.slug}`}
                    aria-label={t("edit")}
                    title={t("edit")}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-secondary t-secondary transition-colors hover:t-primary"
                  >
                    <i className="ri-edit-2-line" />
                  </Link>
                  <button
                    type="button"
                    aria-label={t("story.list.delete_title")}
                    title={t("story.list.delete_title")}
                    onClick={() => removeStory(item)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-neutral-500 transition-colors hover:text-red-500 dark:text-neutral-400"
                  >
                    <i className="ri-delete-bin-line" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Waiting>
      </div>
      <AlertUI />
      <ConfirmUI />
    </>
  );
}
