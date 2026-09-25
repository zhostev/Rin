import type { AIReviseMode } from "@rin/api";
import { FlatPanel } from "@rin/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";
import { useAlert } from "../components/dialog";

const MODES: AIReviseMode[] = ["polish", "expand", "shorten", "proofread", "custom"];

export function AIRevisePanel({
  feedId,
  onApply,
}: {
  feedId: number;
  onApply: (content: string) => void;
}) {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AIReviseMode>("polish");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [revised, setRevised] = useState<string | null>(null);

  async function submit() {
    if (busy) return;

    if (mode === "custom" && !instruction.trim()) {
      showAlert(t("ai_revise.instruction_empty"));
      return;
    }

    setBusy(true);
    setRevised(null);

    const { data, error } = await client.feed.aiRevise(feedId, {
      mode,
      instruction: instruction.trim() || undefined,
    });

    setBusy(false);

    if (error || !data) {
      showAlert(String(error?.value ?? t("ai_revise.failed")));
      return;
    }

    setRevised(data.revised);
  }

  function apply() {
    if (revised == null) return;
    onApply(revised);
    setRevised(null);
    setOpen(false);
  }

  return (
    <FlatPanel className="p-4 sm:p-5 md:p-6">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-theme/70">
            {t("ai_revise.title")}
          </p>
          <p className="mt-2 text-sm t-secondary">{t("ai_revise.desc")}</p>
        </div>
        <i className={open ? "ri-arrow-up-s-line ri-lg" : "ri-arrow-down-s-line ri-lg"} aria-hidden="true" />
      </button>

      {open && (
        <div className="mt-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {MODES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={`rounded-xl px-3 py-2 text-sm transition-colors ${
                  mode === option ? "bg-theme text-white" : "bg-secondary t-secondary"
                }`}
              >
                {t(`ai_revise.mode.${option}`)}
              </button>
            ))}
          </div>

          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={t(
              mode === "custom"
                ? "ai_revise.instruction_placeholder_custom"
                : "ai_revise.instruction_placeholder",
            )}
            rows={3}
            className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-theme dark:border-white/10"
          />

          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-theme px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-theme-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <ReactLoading type="spin" height={16} width={16} />}
            <span>{busy ? t("ai_revise.working") : t("ai_revise.submit")}</span>
          </button>

          {revised != null && (
            <div className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] t-secondary">
                {t("ai_revise.result")}
              </p>
              <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
                {revised}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={apply}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-theme px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-theme-hover"
                >
                  {t("ai_revise.apply")}
                </button>
                <button
                  type="button"
                  onClick={() => setRevised(null)}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-secondary px-5 py-2.5 text-sm t-secondary"
                >
                  {t("ai_revise.discard")}
                </button>
              </div>
              <p className="text-xs t-secondary">{t("ai_revise.apply_hint")}</p>
            </div>
          )}
        </div>
      )}

      <AlertUI />
    </FlatPanel>
  );
}
