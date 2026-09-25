import type { AIComposeImageMode, ComposeLength } from "@rin/api";
import { FlatPanel } from "@rin/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";
import { useAlert } from "../components/dialog";
import { MediaPicker, setPickedNote, type PickedAsset } from "../components/media-picker";
import { mediaPlaybackRelativeUrl, uploadMediaFile } from "../utils/media-upload";

export const COMPOSE_POLL_INTERVAL_MS = 3000;
export const COMPOSE_POLL_TIMEOUT_MS = 300000;
/** 与服务端 VISION_IMAGE_MAX_COUNT 对齐。 */
export const COMPOSE_MAX_SHOTS = 5;

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

/** Pure so the topic-or-shots rule can be tested directly. */
export function canSubmitCompose(input: { topic: string; shotCount: number }): boolean {
  return input.topic.trim().length > 0 || input.shotCount > 0;
}

const LENGTHS: ComposeLength[] = ["short", "medium", "long"];

const IMAGE_MODES: AIComposeImageMode[] = ["none", "generate", "search"];
const IMAGE_COUNTS = [1, 2, 3] as const;

export function AIComposePanel() {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  // 独立成页后默认展开，不再是写作页里的折叠面板。
  const [open, setOpen] = useState(true);
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [length, setLength] = useState<ComposeLength>("medium");
  const [assets, setAssets] = useState<PickedAsset[]>([]);
  const [imageMode, setImageMode] = useState<AIComposeImageMode>("none");
  const [imageCount, setImageCount] = useState<number>(2);
  // 截图生文：上传到媒体库的截图，服务端下载后喂给视觉模型读图。
  const [shots, setShots] = useState<PickedAsset[]>([]);
  const [uploadingShots, setUploadingShots] = useState(false);
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
            window.location.href = `/feed/${id}`;
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

    // 截图生文可以不填选题：只看图写作。
    if (!canSubmitCompose({ topic, shotCount: shots.length })) {
      showAlert(t("ai_compose.topic_or_shots_empty"));
      return;
    }

    setBusy(true);
    setPhase("pending");
    cancelled.current = false;

    const { data, error } = await client.feed.aiCompose({
      topic: topic.trim(),
      assets,
      visionAssets: shots.map((shot) => ({ id: shot.id, note: shot.note })),
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

  async function addShots(files: FileList | null) {
    if (!files || files.length === 0 || uploadingShots || busy) return;
    const remaining = COMPOSE_MAX_SHOTS - shots.length;
    if (remaining <= 0) {
      showAlert(t("ai_compose.shots.max_hint", { max: COMPOSE_MAX_SHOTS }));
      return;
    }
    setUploadingShots(true);
    try {
      for (const file of Array.from(files).slice(0, remaining)) {
        if (!file.type.startsWith("image/")) continue;
        const { asset } = await uploadMediaFile(file, "image", { t });
        setShots((prev) =>
          prev.length >= COMPOSE_MAX_SHOTS
            ? prev
            : [...prev, { id: String(asset.id), note: "" }],
        );
      }
    } catch (error) {
      showAlert(String(error instanceof Error ? error.message : error));
    } finally {
      setUploadingShots(false);
    }
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
            <p className="text-sm font-medium t-primary">{t("ai_compose.shots.title")}</p>
            <p className="text-xs t-secondary">{t("ai_compose.shots.desc")}</p>
            {shots.length > 0 && (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                {shots.map((shot, index) => (
                  <div key={shot.id} className="relative">
                    <div className="aspect-square overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
                      <img
                        src={mediaPlaybackRelativeUrl(shot.id)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-theme text-xs font-medium text-white">
                      {index + 1}
                    </span>
                    <button
                      type="button"
                      aria-label={t("ai_compose.shots.remove")}
                      onClick={() => setShots(shots.filter((item) => item.id !== shot.id))}
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white"
                    >
                      <i className="ri-close-line" aria-hidden="true" />
                    </button>
                    <input
                      type="text"
                      value={shot.note}
                      onChange={(event) =>
                        setShots(setPickedNote(shots, shot.id, event.target.value))
                      }
                      placeholder={t("ai_compose.shots.note_placeholder")}
                      className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-2 py-1 text-xs outline-none focus:border-theme dark:border-white/10"
                    />
                  </div>
                ))}
              </div>
            )}
            <label
              className={`inline-flex w-fit cursor-pointer items-center justify-center gap-2 rounded-xl bg-secondary px-4 py-2.5 text-sm t-secondary transition-colors hover:t-primary ${
                uploadingShots || shots.length >= COMPOSE_MAX_SHOTS
                  ? "pointer-events-none opacity-60"
                  : ""
              }`}
            >
              {uploadingShots && <ReactLoading type="spin" height={14} width={14} />}
              <i className="ri-image-add-line" aria-hidden="true" />
              <span>
                {uploadingShots
                  ? t("ai_compose.shots.uploading")
                  : t("ai_compose.shots.add", { max: COMPOSE_MAX_SHOTS })}
              </span>
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                disabled={uploadingShots || busy || shots.length >= COMPOSE_MAX_SHOTS}
                onChange={(event) => {
                  void addShots(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          </div>

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
