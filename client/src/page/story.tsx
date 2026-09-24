// Story detail page (/story/:slug) — Stage 1.
//
// Media switcher: only renders tabs for media shapes that actually exist in
// the story's blocks (read / video / audio). Video & audio blocks render as
// placeholder cards until Stage 2 wires up Cloudflare Stream / R2 playback.
// rich_text blocks reuse the same Markdown render chain as feed.tsx.

import { useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { Waiting } from "../components/loading";
import { Markdown } from "../components/markdown";
import { Tips } from "../components/tips";
import { Button } from "../components/button";
import { client } from "../app/runtime";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants";
import { timeago } from "../utils/timeago";
import type {
  AudioPayload,
  ContentBlock,
  MediaAsset,
  StoryDetailResponse,
  VideoPayload,
} from "../api/story";
import {
  formatDuration,
  mediaTabsForBlocks,
  type MediaTab,
} from "../components/story-blocks";

const TAB_META: Record<MediaTab, { icon: string; labelKey: string }> = {
  read: { icon: "ri-book-open-line", labelKey: "story.detail.tab_read" },
  video: { icon: "ri-video-line", labelKey: "story.detail.tab_video" },
  audio: { icon: "ri-music-2-line", labelKey: "story.detail.tab_audio" },
};

function asRecord(payload: unknown): Record<string, unknown> {
  return (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Render a non-media block inside the read tab. Returns null for media blocks. */
function ReadBlock({ block }: { block: ContentBlock }) {
  const payload = asRecord(block.payload);

  switch (block.type) {
    case "rich_text":
      return <Markdown content={asString(payload.markdown)} />;
    case "quote":
      return (
        <blockquote className="my-4 border-l-4 border-theme/40 pl-4 italic t-secondary">
          <p>{asString(payload.text)}</p>
          {asString(payload.cite) && (
            <cite className="mt-1 block text-sm not-italic text-neutral-500">— {asString(payload.cite)}</cite>
          )}
        </blockquote>
      );
    case "code":
      return (
        <pre className="my-4 overflow-x-auto rounded-xl bg-neutral-900 p-4 text-sm text-neutral-100 dark:bg-black/60">
          <code>{asString(payload.code)}</code>
        </pre>
      );
    case "callout":
      return (
        <div className="my-4 rounded-xl border border-theme/30 bg-theme/5 p-4">
          {asString(payload.title) && <p className="mb-1 font-medium t-primary">{asString(payload.title)}</p>}
          <p className="text-sm t-secondary">{asString(payload.text)}</p>
        </div>
      );
    case "image": {
      const url = asString(payload.url);
      if (!url) return null;
      return (
        <figure className="my-4">
          <img src={url} alt={asString(payload.alt)} className="w-full rounded-xl" loading="lazy" />
          {asString(payload.caption) && (
            <figcaption className="mt-1 text-center text-sm text-neutral-500">{asString(payload.caption)}</figcaption>
          )}
        </figure>
      );
    }
    case "gallery": {
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0) return null;
      return (
        <div className="my-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {items.map((item, index) => {
            const record = asRecord(item);
            const url = asString(record.url);
            if (!url) return null;
            return (
              <img key={index} src={url} alt={asString(record.alt)} className="aspect-square w-full rounded-xl object-cover" loading="lazy" />
            );
          })}
        </div>
      );
    }
    case "attachment": {
      const url = asString(payload.url);
      if (!url) return null;
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="my-4 flex items-center gap-3 rounded-xl border border-black/10 p-4 transition-colors hover:border-theme/40 dark:border-white/10"
        >
          <i className="ri-attachment-line text-xl text-neutral-400" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium t-primary">{asString(payload.name) || url}</span>
            {asString(payload.size) && <span className="block text-xs text-neutral-500">{asString(payload.size)}</span>}
          </span>
        </a>
      );
    }
    case "divider":
      return <hr className="my-6 border-black/10 dark:border-white/10" />;
    case "cta": {
      const url = asString(payload.url);
      if (!url) return null;
      return (
        <div className="my-4">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full bg-theme px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-theme-hover"
          >
            {asString(payload.label) || url}
            <i className="ri-arrow-right-line" />
          </a>
        </div>
      );
    }
    default:
      return null;
  }
}

function VideoPlaceholderCard({ payload }: { payload: VideoPayload }) {
  const { t } = useTranslation();
  const asset: MediaAsset | undefined = payload.asset;
  const duration = asset?.duration;

  return (
    <div className="overflow-hidden rounded-2xl border border-black/10 bg-w dark:border-white/10">
      <div className="flex aspect-video flex-col items-center justify-center gap-2 bg-neutral-900 text-neutral-300">
        <i className="ri-video-line text-4xl opacity-60" />
        <p className="px-6 text-center text-sm opacity-80">{t("story.detail.video_stage2_note")}</p>
      </div>
      <div className="flex items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium t-primary">{payload.title || t("story.detail.untitled_video")}</p>
          <p className="text-xs text-neutral-500">
            {[asset?.mime, typeof duration === "number" ? formatDuration(duration) : undefined]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-secondary px-3 py-1 text-xs t-secondary">
          {t("story.detail.coming_stage2")}
        </span>
      </div>
    </div>
  );
}

function AudioPlaceholderCard({ payload }: { payload: AudioPayload }) {
  const { t } = useTranslation();
  const asset: MediaAsset | undefined = payload.asset;
  const duration = payload.duration ?? asset?.duration;

  return (
    <div className="flex items-center gap-4 rounded-2xl border border-black/10 bg-w p-4 dark:border-white/10">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-neutral-300">
        <i className="ri-music-2-line text-2xl opacity-70" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium t-primary">{payload.title || t("story.detail.untitled_audio")}</p>
        <p className="text-xs text-neutral-500">
          {t("story.detail.duration")}: {formatDuration(duration)}
        </p>
        <p className="mt-1 text-xs text-neutral-400">{t("story.detail.audio_stage2_note")}</p>
      </div>
      <span className="shrink-0 rounded-full bg-secondary px-3 py-1 text-xs t-secondary">
        {t("story.detail.coming_stage2")}
      </span>
    </div>
  );
}

export function StoryPage({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const [detail, setDetail] = useState<StoryDetailResponse>();
  const [error, setError] = useState<string>();
  const [activeTab, setActiveTab] = useState<MediaTab>("read");
  const ref = useRef("");

  const blocks = useMemo(() => detail?.blocks ?? [], [detail]);
  const tabs = useMemo(() => mediaTabsForBlocks(blocks), [blocks]);

  useEffect(() => {
    if (ref.current === slug) return;
    setDetail(undefined);
    setError(undefined);
    setActiveTab("read");
    client.story
      .get(slug)
      .then(({ data, error }) => {
        if (error) {
          setError(error.value as string);
        } else if (data) {
          setDetail(data);
        }
      });
    ref.current = slug;
  }, [slug]);

  useEffect(() => {
    if (!tabs.includes(activeTab)) {
      setActiveTab(tabs[0] ?? "read");
    }
  }, [tabs, activeTab]);

  const story = detail?.story;
  const videoBlocks = blocks.filter((block) => block.type === "video");
  const audioBlocks = blocks.filter((block) => block.type === "audio");
  const readBlocks = blocks.filter((block) => block.type !== "video" && block.type !== "audio");

  return (
    <Waiting for={detail || error}>
      {story && (
        <Helmet>
          <title>{`${story.title} - ${siteConfig.name}`}</title>
          <meta property="og:site_name" content={siteName} />
          <meta property="og:title" content={story.title} />
          <meta property="og:image" content={story.cover ?? siteConfig.avatar} />
          <meta property="og:type" content="article" />
          <meta property="og:url" content={document.URL} />
          <meta name="description" content={story.summary ?? ""} />
        </Helmet>
      )}
      <div className="w-full flex flex-row justify-center ani-show">
        {error && (
          <div className="flex flex-col wauto rounded-2xl bg-w m-2 p-6 items-center justify-center space-y-3">
            <i className="ri-ghost-line text-4xl text-neutral-300 dark:text-neutral-600" />
            <h1 className="text-xl font-bold t-primary">{t("story.detail.not_found")}</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">/{slug}</p>
            <Tips value={error} type="error" />
            <Button title={t("story.detail.back_home")} onClick={() => (window.location.href = "/")} />
          </div>
        )}
        {story && !error && (
          <>
            <div className="xl:w-64" />
            <main className="wauto">
              <article className="rounded-2xl bg-w m-2 px-6 py-4" aria-label={story.title}>
                <div className="mt-1 mb-1 flex gap-2">
                  {story.published_at && (
                    <p className="text-gray-400 text-[12px]" title={new Date(story.published_at).toLocaleString()}>
                      {t("story.detail.published$time", { time: timeago(story.published_at) })}
                    </p>
                  )}
                  {story.updated_at && story.updated_at !== story.published_at && (
                    <p className="text-gray-400 text-[12px]" title={new Date(story.updated_at).toLocaleString()}>
                      {t("story.detail.updated$time", { time: timeago(story.updated_at) })}
                    </p>
                  )}
                </div>
                <h1 className="text-2xl font-bold t-primary break-all">{story.title}</h1>
                {story.summary && (
                  <p className="mt-2 text-sm leading-6 t-secondary">{story.summary}</p>
                )}

                {tabs.length > 1 && (
                  <div className="mt-4 inline-flex rounded-full bg-secondary p-1" role="tablist" aria-label={t("story.detail.media_switcher")}>
                    {tabs.map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab}
                        onClick={() => setActiveTab(tab)}
                        className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                          activeTab === tab ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
                        }`}
                      >
                        <i className={TAB_META[tab].icon} />
                        {t(TAB_META[tab].labelKey)}
                      </button>
                    ))}
                  </div>
                )}

                <div className="mt-4">
                  {activeTab === "read" && (
                    <div role="tabpanel">
                      {readBlocks.length === 0 ? (
                        <p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                          {t("story.detail.no_blocks")}
                        </p>
                      ) : (
                        readBlocks.map((block, index) => (
                          <ReadBlock key={String(block.id ?? index)} block={block} />
                        ))
                      )}
                    </div>
                  )}
                  {activeTab === "video" && (
                    <div role="tabpanel" className="flex flex-col gap-4">
                      {videoBlocks.map((block, index) => (
                        <VideoPlaceholderCard key={String(block.id ?? index)} payload={block.payload as VideoPayload} />
                      ))}
                    </div>
                  )}
                  {activeTab === "audio" && (
                    <div role="tabpanel" className="flex flex-col gap-3">
                      {audioBlocks.map((block, index) => (
                        <AudioPlaceholderCard key={String(block.id ?? index)} payload={block.payload as AudioPayload} />
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-8 border-t border-black/5 pt-4 dark:border-white/5">
                  <h2 className="text-sm font-semibold t-primary">{t("story.detail.update_history")}</h2>
                  <ul className="mt-2 space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {story.published_at && (
                      <li>{t("story.detail.published_at")}: {new Date(story.published_at).toLocaleString()}</li>
                    )}
                    {story.updated_at && (
                      <li>{t("story.detail.updated_at")}: {new Date(story.updated_at).toLocaleString()}</li>
                    )}
                    {story.verified_at && (
                      <li>{t("story.detail.verified_at")}: {new Date(story.verified_at).toLocaleString()}</li>
                    )}
                  </ul>
                  <p className="mt-2 text-xs text-neutral-400">{t("story.detail.history_stage2_note")}</p>
                </div>

                {detail.relations && detail.relations.length > 0 && (
                  <div className="mt-6 border-t border-black/5 pt-4 dark:border-white/5">
                    <h2 className="text-sm font-semibold t-primary">{t("story.detail.related")}</h2>
                    <ul className="mt-2 space-y-1.5">
                      {detail.relations.map((relation) => (
                        <li key={relation.story_id}>
                          <Link href={`/story/${relation.slug}`} className="text-sm text-theme hover:underline">
                            {relation.title}
                          </Link>
                          <span className="ml-2 text-xs text-neutral-400">{relation.relation_type}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
              <div className="h-16" />
            </main>
            <div className="xl:w-64" />
          </>
        )}
      </div>
    </Waiting>
  );
}
