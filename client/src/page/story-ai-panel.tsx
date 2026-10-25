// Story AI panel for the story editor: AI compose + AI revise for stories.
//
// Mirrors the feed AI panels (writing-ai-compose / writing-ai-revise) but with
// one deliberate difference: nothing here saves or publishes. Compose inserts
// the generated markdown as a NEW rich_text block in the editor, revise only
// replaces the selected block's markdown in the editor; both still require
// the editor's Save button to reach the server.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";
import { useAlert } from "../components/dialog";
import { collectStorySourceText, createBlock } from "../components/story-blocks";
import type { ContentBlock } from "../api/story";

type ReviseMode = "polish" | "expand" | "shorten" | "proofread" | "custom";

const REVISE_MODES: ReviseMode[] = ["polish", "expand", "shorten", "proofread", "custom"];

const inputClassName =
  "w-full rounded-xl border border-black/10 bg-w px-4 py-2.5 text-sm t-primary dark:border-white/10";

function snippet(markdown: string): string {
  const flat = markdown.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat || "（空段落）";
}

export function StoryAIPanel({
  storyId,
  blocks,
  setBlocks,
}: {
  /** Undefined for a brand-new unsaved story: the AI endpoints need a story id. */
  storyId?: number;
  blocks: ContentBlock[];
  setBlocks: (next: ContentBlock[]) => void;
}) {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();

  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [length, setLength] = useState<"short" | "medium" | "long">("medium");
  const [useExisting, setUseExisting] = useState(true);
  const [composing, setComposing] = useState(false);
  const [composed, setComposed] = useState<string | null>(null);

  const richTextBlocks = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === "rich_text");
  const [reviseIndex, setReviseIndex] = useState(0);
  const [reviseMode, setReviseMode] = useState<ReviseMode>("polish");
  const [reviseInstruction, setReviseInstruction] = useState("");
  const [revising, setRevising] = useState(false);
  const [revised, setRevised] = useState<string | null>(null);

  if (storyId === undefined) {
    return (
      <div className="rounded-2xl border border-black/10 bg-w p-4 dark:border-white/10 sm:p-6">
        <p className="text-sm t-secondary">{t("story.editor.ai_unsaved_hint")}</p>
        <AlertUI />
      </div>
    );
  }

  const selectedRevise = richTextBlocks[Math.min(reviseIndex, Math.max(richTextBlocks.length - 1, 0))];

  async function submitCompose() {
    if (composing) return;
    const sourceText = useExisting ? collectStorySourceText(blocks) : "";
    if (!topic.trim() && !sourceText) {
      showAlert(t("story.editor.ai_topic_empty"));
      return;
    }
    setComposing(true);
    setComposed(null);
    const { data, error } = await client.story.aiCompose(storyId!, {
      topic: topic.trim(),
      style: style.trim() || undefined,
      length,
      sourceText: sourceText || undefined,
    });
    setComposing(false);
    if (error || !data) {
      showAlert(String(error?.value ?? t("story.editor.ai_failed")));
      return;
    }
    setComposed(data.markdown);
  }

  function insertComposed() {
    if (composed == null) return;
    const block = createBlock("rich_text", blocks.length);
    block.payload = { markdown: composed };
    setBlocks([...blocks, block]);
    setComposed(null);
  }

  async function submitRevise() {
    if (revising || !selectedRevise) return;
    if (reviseMode === "custom" && !reviseInstruction.trim()) {
      showAlert(t("ai_revise.instruction_empty"));
      return;
    }
    setRevising(true);
    setRevised(null);
    const content = String(
      (selectedRevise.block.payload as { markdown?: string }).markdown ?? "",
    );
    const { data, error } = await client.story.aiRevise(storyId!, {
      mode: reviseMode,
      instruction: reviseInstruction.trim() || undefined,
      content,
    });
    setRevising(false);
    if (error || !data) {
      showAlert(String(error?.value ?? t("story.editor.ai_failed")));
      return;
    }
    setRevised(data.revised);
  }

  function applyRevised() {
    if (revised == null || !selectedRevise) return;
    setBlocks(
      blocks.map((block, index) =>
        index === selectedRevise.index
          ? { ...block, payload: { ...block.payload, markdown: revised } }
          : block,
      ),
    );
    setRevised(null);
  }

  return (
    <div className="rounded-2xl border border-black/10 bg-w p-4 dark:border-white/10 sm:p-6">
      <p className="text-sm font-semibold t-primary">{t("story.editor.ai_title")}</p>
      <p className="mt-1 text-sm t-secondary">{t("story.editor.ai_desc")}</p>

      <div className="mt-4 grid gap-3">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={t("story.editor.ai_topic_placeholder")}
          aria-label={t("story.editor.ai_topic_placeholder")}
          className={inputClassName}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder={t("story.editor.ai_style_placeholder")}
            aria-label={t("story.editor.ai_style_placeholder")}
            className={inputClassName}
          />
          <select
            value={length}
            onChange={(e) => setLength(e.target.value as typeof length)}
            aria-label={t("story.editor.ai_length")}
            className={inputClassName}
          >
            {(["short", "medium", "long"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`ai_compose.length.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm t-secondary">
          <input
            type="checkbox"
            checked={useExisting}
            onChange={(e) => setUseExisting(e.target.checked)}
          />
          {t("story.editor.ai_use_existing")}
        </label>
        <div>
          <button
            type="button"
            onClick={submitCompose}
            disabled={composing}
            className="inline-flex items-center gap-2 rounded-full bg-theme px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {composing && <ReactLoading type="spin" height={16} width={16} />}
            {t("story.editor.ai_generate")}
          </button>
        </div>
        {composed != null && (
          <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
            <p className="text-sm font-medium t-primary">{t("story.editor.ai_result")}</p>
            <textarea
              value={composed}
              onChange={(e) => setComposed(e.target.value)}
              rows={8}
              className={`${inputClassName} mt-2 font-mono text-xs`}
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={insertComposed}
                className="rounded-full bg-theme px-4 py-1.5 text-sm font-medium text-white"
              >
                {t("story.editor.ai_insert_block")}
              </button>
              <button
                type="button"
                onClick={() => setComposed(null)}
                className="rounded-full border border-black/10 px-4 py-1.5 text-sm t-secondary dark:border-white/10"
              >
                {t("ai_revise.discard")}
              </button>
            </div>
            <p className="mt-2 text-xs text-neutral-500">{t("story.editor.ai_insert_hint")}</p>
          </div>
        )}
      </div>

      <div className="mt-6 border-t border-black/5 pt-4 dark:border-white/5">
        <p className="text-sm font-semibold t-primary">{t("ai_revise.title")}</p>
        {richTextBlocks.length === 0 ? (
          <p className="mt-2 text-sm t-secondary">{t("story.editor.ai_no_rich_text")}</p>
        ) : (
          <div className="mt-3 grid gap-3">
            <select
              value={Math.min(reviseIndex, richTextBlocks.length - 1)}
              onChange={(e) => setReviseIndex(Number(e.target.value))}
              aria-label={t("story.editor.ai_pick_block")}
              className={inputClassName}
            >
              {richTextBlocks.map(({ block, index }, i) => (
                <option key={String(block.id ?? index)} value={i}>
                  {t("story.editor.ai_block_option", {
                    index: index + 1,
                    snippet: snippet(String((block.payload as { markdown?: string }).markdown ?? "")),
                  })}
                </option>
              ))}
            </select>
            <div className="grid gap-3 sm:grid-cols-2">
              <select
                value={reviseMode}
                onChange={(e) => setReviseMode(e.target.value as ReviseMode)}
                aria-label={t("ai_revise.title")}
                className={inputClassName}
              >
                {REVISE_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`ai_revise.mode.${mode}`)}
                  </option>
                ))}
              </select>
              <input
                value={reviseInstruction}
                onChange={(e) => setReviseInstruction(e.target.value)}
                placeholder={
                  reviseMode === "custom"
                    ? t("ai_revise.instruction_placeholder_custom")
                    : t("ai_revise.instruction_placeholder")
                }
                aria-label={t("ai_revise.instruction_placeholder")}
                className={inputClassName}
              />
            </div>
            <div>
              <button
                type="button"
                onClick={submitRevise}
                disabled={revising}
                className="inline-flex items-center gap-2 rounded-full bg-theme px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {revising && <ReactLoading type="spin" height={16} width={16} />}
                {t("ai_revise.submit")}
              </button>
            </div>
            {revised != null && (
              <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
                <p className="text-sm font-medium t-primary">{t("ai_revise.result")}</p>
                <textarea
                  value={revised}
                  onChange={(e) => setRevised(e.target.value)}
                  rows={8}
                  className={`${inputClassName} mt-2 font-mono text-xs`}
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={applyRevised}
                    className="rounded-full bg-theme px-4 py-1.5 text-sm font-medium text-white"
                  >
                    {t("ai_revise.apply")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRevised(null)}
                    className="rounded-full border border-black/10 px-4 py-1.5 text-sm t-secondary dark:border-white/10"
                  >
                    {t("ai_revise.discard")}
                  </button>
                </div>
                <p className="mt-2 text-xs text-neutral-500">{t("ai_revise.apply_hint")}</p>
              </div>
            )}
          </div>
        )}
      </div>
      <AlertUI />
    </div>
  );
}
