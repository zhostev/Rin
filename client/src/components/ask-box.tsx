// Stage 4: reusable "AI 问本站" question box. Used by /ask and embeddable
// anywhere else (e.g. search page entry). Pure presentational: the parent owns
// the request lifecycle via onSubmit.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AskMode } from "../api/ai-studio";
import { Button } from "./button";

const MODES: AskMode[] = ["quick", "full"];

export function AskBox({
  initialQuestion = "",
  initialMode = "quick",
  asking = false,
  onSubmit,
}: {
  initialQuestion?: string;
  initialMode?: AskMode;
  asking?: boolean;
  onSubmit: (question: string, mode: AskMode) => void;
}) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState(initialQuestion);
  const [mode, setMode] = useState<AskMode>(initialMode);

  const canSubmit = question.trim().length > 0 && !asking;

  function submit() {
    if (canSubmit) onSubmit(question.trim(), mode);
  }

  return (
    <div className="flex w-full flex-col gap-3 rounded-2xl border border-black/10 bg-w p-4 dark:border-white/10 md:p-5">
      <div className="flex items-center gap-2">
        <i className="ri-sparkling-2-line text-xl text-theme" />
        <p className="text-base font-semibold t-primary">{t("ask.box_title")}</p>
      </div>

      <textarea
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        rows={3}
        placeholder={t("ask.placeholder")}
        className="w-full resize-y rounded-xl border border-black/10 bg-transparent p-3 text-sm leading-6 t-primary outline-none focus:border-theme dark:border-white/10"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="tablist" aria-label={t("ask.mode_label")}>
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={mode === option}
              onClick={() => setMode(option)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                mode === option ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
              }`}
              title={t(`ask.mode_${option}_hint`)}
            >
              {t(`ask.mode_${option}`)}
            </button>
          ))}
        </div>
        <Button
          title={asking ? t("ask.asking") : t("ask.submit")}
          disabled={!canSubmit}
          onClick={submit}
        />
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("ask.disclaimer")}</p>
    </div>
  );
}
