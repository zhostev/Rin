// StoryEditorPage: content-package editor (Stage 1 skeleton).
// Mirrors the interaction of page/writing.tsx (title / alias / summary /
// status) but works on ordered content blocks instead of a single markdown
// document. Supported block types in Stage 1: rich_text, video, audio.

import { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import Loading from "react-loading";
import { useLocation } from "wouter";
import { useAlert } from "../components/dialog";
import { client } from "../app/runtime";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants";
import type { BlockType, ContentBlock, StoryStatus } from "../api/story";
import {
  AudioBlock,
  BlockShell,
  RichTextBlock,
  VideoBlock,
  createBlock,
  moveBlock,
  removeBlock,
  updateBlockPayload,
} from "../components/story-blocks";

const STATUSES: StoryStatus[] = ["draft", "scheduled", "published", "updated", "archived"];

const BLOCK_BUTTONS: { type: BlockType; icon: string; labelKey: string }[] = [
  { type: "rich_text", icon: "ri-text", labelKey: "story.editor.block_rich_text" },
  { type: "video", icon: "ri-video-line", labelKey: "story.editor.block_video" },
  { type: "audio", icon: "ri-music-2-line", labelKey: "story.editor.block_audio" },
];

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

export function StoryEditorPage({ storyKey }: { storyKey?: string }) {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const [, setLocation] = useLocation();
  const { showAlert, AlertUI } = useAlert();

  const [storyId, setStoryId] = useState<number>();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [slug, setSlug] = useState("");
  const [status, setStatus] = useState<StoryStatus>("draft");
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(storyKey));

  const isEdit = storyKey !== undefined;

  useEffect(() => {
    if (!storyKey) return;
    client.story.get(storyKey).then(({ data, error }) => {
      if (error) {
        showAlert(error.value as string);
      } else if (data) {
        setStoryId(data.story.id);
        setTitle(data.story.title ?? "");
        setSummary(data.story.summary ?? "");
        setSlug(data.story.slug ?? "");
        setStatus(data.story.status ?? "draft");
        setBlocks((data.blocks ?? []).map((block, position) => ({ ...block, position })));
      }
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyKey]);

  function addBlock(type: BlockType) {
    setBlocks((prev) => [...prev, createBlock(type, prev.length)]);
  }

  function save() {
    if (saving) return;
    if (!title.trim()) {
      showAlert(t("story.editor.title_empty"));
      return;
    }
    if (!slug.trim()) {
      showAlert(t("story.editor.slug_empty"));
      return;
    }
    setSaving(true);
    const payload = {
      title: title.trim(),
      summary: summary.trim() || undefined,
      slug: slug.trim(),
      status,
      blocks: blocks.map((block, position) => ({ ...block, position })),
    };
    const done = () => setSaving(false);
    if (isEdit && storyId !== undefined) {
      client.story.update(storyId, payload).then(({ error }) => {
        done();
        if (error) {
          showAlert(error.value as string);
        } else {
          showAlert(t("story.editor.save_success"), () => setLocation("/admin/stories"));
        }
      });
    } else {
      client.story.create(payload).then(({ data, error }) => {
        done();
        if (error) {
          showAlert(error.value as string);
        } else if (data) {
          showAlert(t("story.editor.save_success"), () => setLocation("/admin/stories"));
        }
      });
    }
  }

  function blockTitle(type: BlockType): string {
    switch (type) {
      case "rich_text":
        return t("story.editor.block_rich_text");
      case "video":
        return t("story.editor.block_video");
      case "audio":
        return t("story.editor.block_audio");
      default:
        return type;
    }
  }

  return (
    <>
      <Helmet>
        <title>{`${isEdit ? t("story.editor.edit") : t("story.editor.new")} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={isEdit ? t("story.editor.edit") : t("story.editor.new")} />
        <meta property="og:image" content={siteConfig.avatar} />
      </Helmet>

      <div className="flex flex-col gap-4 t-primary">
        <div className="rounded-2xl border border-black/10 bg-w p-4 dark:border-white/10 sm:p-6">
          <div className="flex items-start justify-between gap-4 border-b border-black/5 pb-5 dark:border-white/5">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-theme/70">
                {t("story.nav.stories")}
              </p>
              <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                {isEdit ? t("story.editor.edit") : t("story.editor.new")}
              </p>
            </div>
            <button
              type="button"
              onClick={save}
              disabled={saving || loading}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-theme px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-theme-hover active:bg-theme-active disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving && <Loading type="spin" height={16} width={16} />}
              <span>{t("story.editor.save")}</span>
            </button>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("title")}
                aria-label={t("title")}
                className={`${inputClassName} text-base`}
              />
            </div>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t("summary")}
              aria-label={t("summary")}
              className={inputClassName}
            />
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={t("story.editor.slug_placeholder")}
              aria-label={t("story.editor.slug")}
              className={inputClassName}
            />
            <label className="flex items-center gap-3 lg:col-span-2">
              <span className="whitespace-nowrap text-sm t-secondary">{t("story.editor.status")}</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as StoryStatus)}
                className={`${inputClassName} w-auto`}
              >
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(`story.editor.status_${value}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center rounded-2xl border border-black/10 p-12 dark:border-white/10">
            <Loading type="spin" height={32} width={32} />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm t-secondary">{t("story.editor.add_block")}:</span>
              {BLOCK_BUTTONS.map(({ type, icon, labelKey }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => addBlock(type)}
                  className="inline-flex items-center gap-2 rounded-full border border-black/10 px-4 py-2 text-sm t-secondary transition-colors hover:border-theme/40 hover:text-theme dark:border-white/10"
                >
                  <i className={`${icon} text-base`} />
                  {t(labelKey)}
                </button>
              ))}
            </div>

            {blocks.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-black/10 p-12 text-center dark:border-white/10">
                <i className="ri-layout-2-line text-4xl text-neutral-300 dark:text-neutral-600" />
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("story.editor.no_blocks")}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {blocks.map((block, index) => (
                  <BlockShell
                    key={String(block.id)}
                    type={block.type}
                    title={blockTitle(block.type)}
                    index={index}
                    total={blocks.length}
                    onMoveUp={() => setBlocks((prev) => moveBlock(prev, index, -1))}
                    onMoveDown={() => setBlocks((prev) => moveBlock(prev, index, 1))}
                    onRemove={() => setBlocks((prev) => removeBlock(prev, block.id))}
                  >
                    {block.type === "rich_text" && (
                      <RichTextBlock
                        payload={block.payload as { markdown: string }}
                        onChange={(patch) => setBlocks((prev) => updateBlockPayload(prev, block.id, patch))}
                      />
                    )}
                    {block.type === "video" && (
                      <VideoBlock
                        payload={block.payload as { title?: string }}
                        onChange={(patch) => setBlocks((prev) => updateBlockPayload(prev, block.id, patch))}
                      />
                    )}
                    {block.type === "audio" && (
                      <AudioBlock
                        payload={block.payload as { title?: string }}
                        onChange={(patch) => setBlocks((prev) => updateBlockPayload(prev, block.id, patch))}
                      />
                    )}
                  </BlockShell>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <AlertUI />
    </>
  );
}
