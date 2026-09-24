// BlockShell: shared chrome for story content blocks in the editor.
// Title row + move up/down + remove. No @rin/ui dependency (see AGENTS.md).

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BlockType } from "../../api/story";

const BLOCK_ICONS: Record<BlockType, string> = {
  rich_text: "ri-text",
  quote: "ri-double-quotes-l",
  code: "ri-code-line",
  callout: "ri-information-line",
  image: "ri-image-line",
  gallery: "ri-gallery-line",
  video: "ri-video-line",
  audio: "ri-music-2-line",
  attachment: "ri-attachment-line",
  divider: "ri-separator",
  cta: "ri-cursor-line",
};

export function BlockShell({
  type,
  title,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onRemove,
  children,
}: {
  type: BlockType;
  title: string;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  const iconButton =
    "inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100";

  return (
    <div className="rounded-2xl border border-black/10 bg-w dark:border-white/10">
      <div className="flex items-center gap-2 border-b border-black/5 px-4 py-2.5 dark:border-white/5">
        <i className={`${BLOCK_ICONS[type]} text-base text-theme`} />
        <span className="text-sm font-medium t-primary">{title}</span>
        <span className="text-xs text-neutral-400">#{index + 1}</span>
        <div className="flex-1" />
        <button type="button" aria-label={t("story.editor.move_up")} title={t("story.editor.move_up")} className={iconButton} onClick={onMoveUp} disabled={index === 0}>
          <i className="ri-arrow-up-line" />
        </button>
        <button type="button" aria-label={t("story.editor.move_down")} title={t("story.editor.move_down")} className={iconButton} onClick={onMoveDown} disabled={index === total - 1}>
          <i className="ri-arrow-down-line" />
        </button>
        <button type="button" aria-label={t("story.editor.remove_block")} title={t("story.editor.remove_block")} className={`${iconButton} hover:!text-red-500`} onClick={onRemove}>
          <i className="ri-delete-bin-line" />
        </button>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
