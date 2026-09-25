import type { AIComposeImageMode, ComposeLength } from "@rin/api";
import { FlatPanel } from "@rin/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";
import { useAlert } from "../components/dialog";
import { MediaPicker, type PickedAsset } from "../components/media-picker";

export const COMPOSE_POLL_INTERVAL_MS = 3000;
export const COMPOSE_POLL_TIMEOUT_MS = 300000;

/** Pure so the timeout-is-not-a-failure rule can be tested directly. */
export function nextPollDecision(input: { status: string; elapsedMs: number }):
  | "continue"
  | "done"
  | "failed"
  | "timeout" {
  if (input.status === "completed") return "done";
  if (input.status === "failed") return "failed";
  if (input.elapsedMs > COMPOSE_POLL_TIMEOUT_MS) return "timeout";
  return "continue";
}

const LENGTHS: ComposeLength[] = ["short", "medium", "long"];

const IMAGE_MODES: AIComposeImageMode[] = ["none", "generate", "search"];
const IMAGE_COUNTS = [1, 2, 3] as const;

export function AIComposePanel() {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [length, setLength] = useState<ComposeLength>("medium");
  const [assets, setAssets] = useState<PickedAsset[]>([]);
  const [imageMode, setImageMode] = useState<AIComposeImageMode>("none");
  const [imageCount, setImageCount] = useState<number>(2);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const cancelled = useRef(false);

  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, []);

  async function poll(id: number) {
    const startedAt = Date.now();

    while (!cancelled.current) {
      await new Promise((resolve) => setTimeout(resolve, COMPOSE_POLL_INTERVAL_MS));

      const { data, error } = await client.feed.aiComposeStatus(id);
      if (error) {
        setBusy(false);
        showAlert(String(error.value ?? t("ai_compose.status_failed")));
        return;
      }

      const decision = nextPollDecision({
        status: data?.status ?? "pending",
        elapsedMs: Date.now() - startedAt,
      });

      setPhase(data?.status ?? "pending");

      if (decision === "done") {
        setBusy(false);
        window.location.href = `/feed/${id}`;
        return;
      }

      if (decision === "failed") {
        setBusy(false);
        showAlert(
          `${data?.error || t("ai_compose.failed")}\n\n${t("ai_compose.failed_draft_hint")}`,
          () => {
            window.location.href = `/writing/${id}`;
          },
        );
        return;
      }

      if (decision === "timeout") {
        setBusy(false);
        showAlert(t("ai_compose.timeout"));
        return;
      }
    }
  }

  async function submit() {
    if (busy) return;

    if (!topic.trim()) {
      showAlert(t("ai_compose.topic_empty"));
      return;
    }

    setBusy(true);
    setPhase("pending");
    cancelled.current = false;

    const { data, error } = await client.feed.aiCompose({
      topic: topic.trim(),
      assets,
      length,
      style: style.trim() || undefined,
      imageMode,
      imageCount: imageMode === "none" ? undefined : imageCount,
    });

    if (error || !data) {
      setBusy(false);
      showAlert(String(error?.value ?? t("ai_compose.failed")));
      return;
    }

    void poll(data.id);
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
            {t("ai_compose.title")}
          </p>
          <p className="mt-2 text-sm t-secondary">{t("ai_compose.desc")}</p>
        </div>
        <i className={open ? "ri-arrow-up-s-line ri-lg" : "ri-arrow-down-s-line ri-lg"} aria-hidden="true" />
      </button>

      {open && (
        <div className="mt-5 flex flex-col gap-4">
          <input
            type="text"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder={t("ai_compose.topic_placeholder")}
            className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-theme dark:border-white/10"
          />

          <div className="flex flex-wrap items-center gap-2">
            {LENGTHS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLength(option)}
                className={`rounded-xl px-3 py-2 text-sm transition-colors ${
                  length === option ? "bg-theme text-white" : "bg-secondary t-secondary"
                }`}
              >
                {t(`ai_compose.length.${option}`)}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            placeholder={t("ai_compose.style_placeholder")}
            className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-theme dark:border-white/10"
          />

          <MediaPicker value={assets} onChange={setAssets} />

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium t-primary">{t("ai_compose.image_mode.title")}</p>
            <div className="flex flex-wrap items-center gap-2">
              {IMAGE_MODES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setImageMode(option)}
                  className={`rounded-xl px-3 py-2 text-sm transition-colors ${
                    imageMode === option ? "bg-theme text-white" : "bg-secondary t-secondary"
                  }`}
                >
                  {t(`ai_compose.image_mode.${option}`)}
                </button>
              ))}
            </div>
            {imageMode !== "none" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs t-secondary">{t("ai_compose.image_count")}</span>
                {IMAGE_COUNTS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setImageCount(option)}
                    className={`rounded-xl px-3 py-1.5 text-sm transition-colors ${
                      imageCount === option ? "bg-theme text-white" : "bg-secondary t-secondary"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            {imageMode === "search" && (
              <p className="text-xs t-secondary">{t("ai_compose.image_search_hint")}</p>
            )}
          </div>

          <p className="text-xs t-secondary">{t("ai_compose.publish_warning")}</p>

          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-theme px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-theme-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <ReactLoading type="spin" height={16} width={16} />}
            <span>{busy ? t(`ai_compose.phase.${phase || "pending"}`) : t("ai_compose.submit")}</span>
          </button>
        </div>
      )}

      <AlertUI />
    </FlatPanel>
  );
}
