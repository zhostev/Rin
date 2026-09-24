// RichTextBlock: markdown body block. Monaco is lazy-loaded so the editor
// chunk is only fetched when this block mounts (keeps first paint light).

import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import type { RichTextPayload } from "../../api/story";

const MarkdownEditor = lazy(() =>
  import("../markdown_editor").then((module) => ({ default: module.MarkdownEditor })),
);

function EditorFallback() {
  return (
    <div className="flex h-64 items-center justify-center rounded-xl bg-secondary">
      <i className="ri-loader-4-line animate-spin text-2xl text-neutral-400" />
    </div>
  );
}

export function RichTextBlock({
  payload,
  onChange,
}: {
  payload: RichTextPayload;
  onChange: (patch: Partial<RichTextPayload>) => void;
}) {
  const { t } = useTranslation();

  return (
    <div>
      <Suspense fallback={<EditorFallback />}>
        <MarkdownEditor
          content={payload.markdown ?? ""}
          setContent={(markdown) => onChange({ markdown })}
          placeholder={t("story.editor.rich_text_placeholder")}
          height="420px"
        />
      </Suspense>
    </div>
  );
}
