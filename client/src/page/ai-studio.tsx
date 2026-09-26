// Stage 4 AI Studio admin page: /admin/ai-studio.
//
// Tabs: task list (with polling) + new-job wizard, usage dashboard, settings.
// The backend lane builds the API in parallel; every loader falls back to
// clearly-labeled mock fixtures when the endpoint is unreachable so the page
// always renders. Remove nothing when the backend lands — real data simply
// replaces the mocks.

import { Modal, SearchableSelect, SettingsBadge, SettingsCard, SettingsCardBody, SettingsCardHeader, SettingsCardRow, Spinner } from "@rin/ui";
import * as Switch from "@radix-ui/react-switch";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import type {
  AIArtifact,
  AIJob,
  AIJobInput,
  AIJobKind,
  AIJobMaterial,
  AIJobStatus,
  AISettings,
  AIUsageResponse,
} from "../api/ai-studio";
import { buildAIJobInput } from "../api/ai-studio";
import { client } from "../app/runtime";
import { Button } from "../components/button";
import { useAlert } from "../components/dialog";
import { useApiResource } from "../hooks/use-api-resource";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { diffJsonLeaves, diffTextLines, extractDraftText } from "../utils/ai-studio-diff";
import type { StoryDetailResponse } from "../api/story";

/** Polling cadence for the job list (also asserted by unit tests). */
export const AI_STUDIO_POLL_INTERVAL_MS = 5000;

type JobTab = "jobs" | "usage" | "settings";
type JobFilter = AIJobStatus | "all";

// ---------------------------------------------------------------------------
// Mock fixtures: used only while the backend lane has not shipped the endpoints.
// ---------------------------------------------------------------------------

const MOCK_JOBS: AIJob[] = [
  {
    id: "mock-1",
    job_type: "transcribe",
    status: "processing",
    input: { assetId: 12 },
    created_at: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 1).toISOString(),
  },
  {
    id: "mock-2",
    job_type: "derive",
    status: "ready",
    input: { storyId: 3 },
    params: { derive: "summary" },
    created_at: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
  },
  {
    id: "mock-3",
    job_type: "check",
    status: "failed",
    input: { storyId: 7 },
    params: { checks: ["broken_links", "missing_alt"] },
    error: "model_timeout: upstream model did not respond in 120s",
    created_at: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 178).toISOString(),
  },
];

const MOCK_ARTIFACTS: Record<string, AIArtifact[]> = {
  "mock-2": [
    {
      id: "mock-a1",
      output_json: {
        draft: "本站内容包导出与多语言同步的完整流程。\n\n1. 在后台「内容包」中完成编辑并发布。\n2. 通过设置页配置同步目标语言。\n3. 定期检查断链与媒体元数据。",
        summary: "内容包发布与多语言同步流程说明。",
      },
      accepted_at: null,
      created_at: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
    },
  ],
};

const MOCK_USAGE: AIUsageResponse = {
  days: 30,
  total: { calls: 128 },
  byModel: [
    { model: "mock-model-a", calls: 96 },
    { model: "mock-model-b", calls: 32 },
  ],
};

const MOCK_SETTINGS: AISettings = { ai_enabled: true, daily_call_quota: 200 };

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** Card tone (SettingsCard supports default/success/danger/warning). */
function cardToneForStatus(status: AIJobStatus): "success" | "warning" | "danger" {
  if (status === "ready") return "success";
  if (status === "failed") return "danger";
  return "warning";
}

/** Badge tone (SettingsBadge supports neutral/success/warning). */
function toneForStatus(status: AIJobStatus): "success" | "warning" | "neutral" {
  if (status === "ready") return "success";
  if (status === "pending" || status === "processing") return "warning";
  return "neutral";
}

function StatusBadge({ status }: { status: AIJobStatus }) {
  const { t } = useTranslation();
  return <SettingsBadge tone={toneForStatus(status)}>{t(`ai_studio.jobs.status.${status}`)}</SettingsBadge>;
}

function MockBadge() {
  const { t } = useTranslation();
  return (
    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
      {t("ai_studio.demo_badge")}
    </span>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Render any JSON value as a compact key-value tree. */
function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (Array.isArray(value)) {
    return (
      <div className={depth > 0 ? "ml-4 border-l border-black/10 pl-3 dark:border-white/10" : ""}>
        {value.map((item, index) => (
          <div key={index} className="py-0.5">
            <span className="mr-2 font-mono text-xs text-neutral-400">[{index}]</span>
            <JsonTree value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div className={depth > 0 ? "ml-4 border-l border-black/10 pl-3 dark:border-white/10" : ""}>
        {entries.map(([key, item]) => (
          <div key={key} className="py-0.5">
            <span className="mr-2 font-mono text-xs font-medium text-theme">{key}</span>
            {typeof item === "object" && item !== null ? (
              <JsonTree value={item} depth={depth + 1} />
            ) : (
              <span className="whitespace-pre-wrap break-words text-sm t-primary">{String(item)}</span>
            )}
          </div>
        ))}
      </div>
    );
  }
  return <span className="whitespace-pre-wrap break-words text-sm t-primary">{String(value)}</span>;
}

function leafValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// New-job wizard: material -> capability -> review -> submit
// ---------------------------------------------------------------------------

type MaterialKind = AIJobMaterial;
type DeriveType = "summary" | "chapters" | "platform_copy";
type CheckItem = "broken_links" | "missing_alt" | "stale_facts" | "metadata";

const CAPABILITIES: AIJobKind[] = ["transcribe", "derive", "check", "retrieval-test", "embed"];
const DERIVE_TYPES: DeriveType[] = ["summary", "chapters", "platform_copy"];
const CHECK_ITEMS: CheckItem[] = ["broken_links", "missing_alt", "stale_facts", "metadata"];

function JobWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  const [step, setStep] = useState(1);
  const [material, setMaterial] = useState<MaterialKind>("story");
  const [storyId, setStoryId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [text, setText] = useState("");
  const [capability, setCapability] = useState<AIJobKind>("transcribe");
  const [deriveType, setDeriveType] = useState<DeriveType>("summary");
  const [checks, setChecks] = useState<CheckItem[]>(["broken_links"]);
  const [question, setQuestion] = useState("");
  const [stories, setStories] = useState<Array<{ value: string; label: string }>>([]);
  const [assets, setAssets] = useState<Array<{ value: string; label: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  // Load pickers lazily when the wizard opens.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    client.story
      .list({ limit: 50 })
      .then(({ data, error }) => {
        if (!error && data) {
          setStories(
            data.stories.map((story) => ({
              value: String(story.id),
              label: story.title || story.slug,
            })),
          );
        }
      })
      .catch(() => undefined);
    client.media
      .list(undefined, { limit: 50 })
      .then(({ data, error }) => {
        if (!error && data) {
          setAssets(
            data.data.map((asset) => ({
              value: String(asset.id),
              label: asset.title || asset.alt || `${asset.kind} #${asset.id}`,
            })),
          );
        }
      })
      .catch(() => undefined);
  }, [open ]);

  const materialValid = useMemo(() => {
    // Backend requires integer ids; the pickers hold string values, so
    // validate the numeric conversion here (and convert in buildPayload).
    if (material === "story") return storyId !== "" && Number.isInteger(Number(storyId));
    if (material === "asset") return assetId !== "" && Number.isInteger(Number(assetId));
    return text.trim().length > 0;
  }, [material, storyId, assetId, text]);

  const capabilityValid = useMemo(() => {
    if (capability === "derive") return true;
    if (capability === "check") return checks.length > 0;
    if (capability === "retrieval-test") return question.trim().length > 0;
    return true;
  }, [capability, checks, question]);

  const canNext = step === 1 ? materialValid : step === 2 ? capabilityValid : true;

  function buildPayload(): { kind: AIJobKind; input: AIJobInput; params?: Record<string, unknown> } {
    // buildAIJobInput converts picker string ids to numbers; the backend
    // schema requires integers ("input.assetId must be a number" otherwise).
    const input = buildAIJobInput(material, { storyId, assetId, text });
    if (capability === "retrieval-test") input.question = question.trim();
    const params: Record<string, unknown> = {};
    if (capability === "derive") params.derive = deriveType;
    if (capability === "check") params.checks = checks;
    return {
      kind: capability,
      input,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    };
  }

  async function submit() {
    setSubmitting(true);
    try {
      const { error } = await client.aiStudio.createJob(buildPayload());
      if (error) {
        showAlert(error.value);
        return;
      }
      showAlert(t("ai_studio.wizard.created"));
      onCreated();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  function toggleCheck(item: CheckItem) {
    setChecks((current) =>
      current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item],
    );
  }

  return (
    <Modal isOpen={open} onRequestClose={onClose} contentLabel={t("ai_studio.wizard.title")} size="lg">
      <AlertUI />
      <div className="flex flex-col gap-5 p-1">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold t-primary">{t("ai_studio.wizard.title")}</h2>
          <span className="text-sm text-neutral-500">
            {t("ai_studio.wizard.step_of", { step, total: 3 })}
          </span>
        </div>

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <div className="flex gap-2">
              {(["story", "asset", "text"] as MaterialKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setMaterial(kind)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    material === kind ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
                  }`}
                >
                  {t(`ai_studio.wizard.material_${kind}`)}
                </button>
              ))}
            </div>
            {material === "story" ? (
              <SearchableSelect
                value={storyId}
                onChange={setStoryId}
                options={stories}
                placeholder={t("ai_studio.wizard.pick_story")}
                searchPlaceholder={t("ai_studio.wizard.pick_story")}
                emptyLabel={t("ai_studio.wizard.pick_empty")}
              />
            ) : null}
            {material === "asset" ? (
              <SearchableSelect
                value={assetId}
                onChange={setAssetId}
                options={assets}
                placeholder={t("ai_studio.wizard.pick_asset")}
                searchPlaceholder={t("ai_studio.wizard.pick_asset")}
                emptyLabel={t("ai_studio.wizard.pick_empty")}
              />
            ) : null}
            {material === "text" ? (
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={8}
                placeholder={t("ai_studio.wizard.paste_text_placeholder")}
                className="w-full rounded-xl border border-black/10 bg-w p-3 text-sm t-primary outline-none focus:border-theme dark:border-white/10"
              />
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-3">
            {CAPABILITIES.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setCapability(kind)}
                className={`rounded-2xl border p-4 text-left transition-colors ${
                  capability === kind
                    ? "border-theme bg-theme/5"
                    : "border-black/10 hover:border-black/25 dark:border-white/10 dark:hover:border-white/25"
                }`}
              >
                <p className="text-sm font-semibold t-primary">{t(`ai_studio.wizard.capability_${kind.replace("-", "_")}`)}</p>
                <p className="mt-1 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
                  {t(`ai_studio.wizard.capability_${kind.replace("-", "_")}_desc`)}
                </p>
              </button>
            ))}

            {capability === "derive" ? (
              <div className="flex flex-wrap gap-2 pl-1">
                {DERIVE_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setDeriveType(type)}
                    className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${
                      deriveType === type ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
                    }`}
                  >
                    {t(`ai_studio.wizard.derive_${type}`)}
                  </button>
                ))}
              </div>
            ) : null}

            {capability === "check" ? (
              <div className="flex flex-wrap gap-2 pl-1">
                {CHECK_ITEMS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => toggleCheck(item)}
                    className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${
                      checks.includes(item) ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
                    }`}
                  >
                    {t(`ai_studio.wizard.check_${item}`)}
                  </button>
                ))}
              </div>
            ) : null}

            {capability === "retrieval-test" ? (
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={t("ai_studio.wizard.question_placeholder")}
                className="w-full rounded-xl border border-black/10 bg-w p-3 text-sm t-primary outline-none focus:border-theme dark:border-white/10"
              />
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-3 text-sm">
            <SettingsCard>
              <SettingsCardBody>
                <div className="space-y-1.5 t-primary">
                  <p>
                    <span className="text-neutral-500">{t("ai_studio.wizard.review_material")}: </span>
                    {material === "story"
                      ? stories.find((option) => option.value === storyId)?.label ?? storyId
                      : material === "asset"
                        ? assets.find((option) => option.value === assetId)?.label ?? assetId
                        : t("ai_studio.wizard.review_pasted_text", { chars: text.trim().length })}
                  </p>
                  <p>
                    <span className="text-neutral-500">{t("ai_studio.wizard.review_capability")}: </span>
                    {t(`ai_studio.wizard.capability_${capability.replace("-", "_")}`)}
                    {capability === "derive" ? ` · ${t(`ai_studio.wizard.derive_${deriveType}`)}` : null}
                    {capability === "check" ? ` · ${checks.map((item) => t(`ai_studio.wizard.check_${item}`)).join("、")}` : null}
                  </p>
                  {capability === "retrieval-test" ? (
                    <p>
                      <span className="text-neutral-500">{t("ai_studio.wizard.review_question")}: </span>
                      {question.trim()}
                    </p>
                  ) : null}
                </div>
              </SettingsCardBody>
            </SettingsCard>
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <div>
            {step > 1 ? (
              <Button secondary title={t("ai_studio.wizard.back")} onClick={() => setStep(step - 1)} />
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button secondary title={t("cancel")} onClick={onClose} />
            {step < 3 ? (
              <Button title={t("ai_studio.wizard.next")} disabled={!canNext} onClick={() => setStep(step + 1)} />
            ) : (
              <Button title={submitting ? t("ai_studio.wizard.submitting") : t("ai_studio.wizard.submit")} disabled={submitting} onClick={() => void submit()} />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Job detail: artifacts, generic diff view, accept / reject
// ---------------------------------------------------------------------------

function storyBodyText(detail: StoryDetailResponse): string {
  return detail.blocks
    .map((block) => {
      const payload = block.payload as Record<string, unknown> | null;
      if (!payload) return "";
      if (typeof payload.markdown === "string") return payload.markdown;
      if (typeof payload.text === "string") return payload.text;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function TextDiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const { t } = useTranslation();
  const lines = useMemo(() => diffTextLines(oldText, newText), [oldText, newText]);
  const changed = lines.filter((line) => line.type !== "same").length;
  return (
    <div>
      <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
        {t("ai_studio.detail.diff_stats", { changed })}
      </p>
      <div className="overflow-x-auto rounded-xl border border-black/10 bg-black/[0.02] font-mono text-xs leading-5 dark:border-white/10 dark:bg-white/[0.02]">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`whitespace-pre-wrap px-3 py-0.5 ${
              line.type === "add"
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : line.type === "del"
                  ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                  : "text-neutral-500 dark:text-neutral-400"
            }`}
          >
            <span className="mr-2 inline-block w-4 select-none opacity-60">
              {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
            </span>
            {line.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

function ArtifactCard({
  artifact,
  job,
  onChanged,
}: {
  artifact: AIArtifact;
  job: AIJob;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  const [view, setView] = useState<"result" | "diff">("result");
  const [acting, setActing] = useState<"accept" | "reject" | null>(null);
  const [currentText, setCurrentText] = useState<string | null>(null);
  const [currentTextFailed, setCurrentTextFailed] = useState(false);

  const draftText = useMemo(() => extractDraftText(artifact.output_json), [artifact.output_json]);

  // Load the current body/transcript for the diff view when it is first opened.
  useEffect(() => {
    if (view !== "diff" || currentText !== null || currentTextFailed) return;
    const storyId = job.input?.storyId;
    if (!storyId) {
      setCurrentTextFailed(true);
      return;
    }
    client.story
      .get(storyId)
      .then(({ data, error }) => {
        if (error || !data) {
          setCurrentTextFailed(true);
          return;
        }
        setCurrentText(storyBodyText(data));
      })
      .catch(() => setCurrentTextFailed(true));
  }, [view, currentText, currentTextFailed, job.input?.storyId]);

  async function act(action: "accept" | "reject") {
    setActing(action);
    try {
      const { error } =
        action === "accept"
          ? await client.aiStudio.acceptArtifact(artifact.id)
          : await client.aiStudio.rejectArtifact(artifact.id);
      if (error) {
        showAlert(error.value);
        return;
      }
      onChanged();
    } finally {
      setActing(null);
    }
  }

  const jsonDiffRows = useMemo(() => {
    if (view !== "diff" || draftText) return [];
    // No text pair available: diff the artifact JSON against an empty baseline.
    return diffJsonLeaves(null, artifact.output_json).filter((row) => row.change !== "same");
  }, [view, draftText, artifact.output_json]);

  return (
    <SettingsCard>
      <AlertUI />
      <SettingsCardHeader
        title={t("ai_studio.detail.artifact_title", { id: String(artifact.id) })}
        description={formatDateTime(artifact.created_at)}
        badge={
          artifact.accepted_at ? (
            <SettingsBadge tone="success">{t("ai_studio.detail.applied")}</SettingsBadge>
          ) : undefined
        }
      />
      <SettingsCardBody>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            {(["result", "diff"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setView(tab)}
                className={`rounded-full px-3.5 py-1 text-sm font-medium ${
                  view === tab ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
                }`}
              >
                {t(`ai_studio.detail.view_${tab}`)}
              </button>
            ))}
          </div>

          {view === "result" ? <JsonTree value={artifact.output_json} /> : null}

          {view === "diff" ? (
            draftText && currentText !== null ? (
              <TextDiffView oldText={currentText} newText={draftText} />
            ) : draftText && currentTextFailed ? (
              <div>
                <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                  {t("ai_studio.detail.no_current_text")}
                </p>
                <TextDiffView oldText="" newText={draftText} />
              </div>
            ) : !draftText ? (
              <div className="flex flex-col gap-1.5">
                {jsonDiffRows.length === 0 ? (
                  <p className="text-sm text-neutral-500">{t("ai_studio.detail.no_diff_rows")}</p>
                ) : (
                  jsonDiffRows.map((row) => (
                    <div
                      key={row.path}
                      className={`rounded-lg px-3 py-1.5 text-xs ${
                        row.change === "added"
                          ? "bg-emerald-500/10"
                          : row.change === "removed"
                            ? "bg-rose-500/10"
                            : "bg-amber-500/10"
                      }`}
                    >
                      <span className="font-mono font-medium text-theme">{row.path}</span>
                      <span className="ml-2 font-medium">
                        {t(`ai_studio.detail.json_${row.change}`)}
                      </span>
                      <div className="mt-1 whitespace-pre-wrap break-words font-mono text-neutral-600 dark:text-neutral-300">
                        {row.change !== "added" ? <div>− {leafValueText(row.oldValue)}</div> : null}
                        {row.change !== "removed" ? <div>+ {leafValueText(row.newValue)}</div> : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 py-6 text-sm text-neutral-500">
                <Spinner label={t("ai_studio.detail.loading_current")} />
                <span>{t("ai_studio.detail.loading_current")}</span>
              </div>
            )
          ) : null}

          {artifact.accepted_at ? (
            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-300">
              {t("ai_studio.detail.applied_at", { date: formatDateTime(artifact.accepted_at) })}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                title={acting === "accept" ? t("ai_studio.detail.accepting") : t("ai_studio.detail.accept")}
                disabled={acting !== null}
                onClick={() => void act("accept")}
              />
              <Button
                secondary
                title={acting === "reject" ? t("ai_studio.detail.rejecting") : t("ai_studio.detail.reject")}
                disabled={acting !== null}
                onClick={() => void act("reject")}
              />
            </div>
          )}
        </div>
      </SettingsCardBody>
    </SettingsCard>
  );
}

function JobDetail({ jobId, onClose }: { jobId: number | string; onClose: () => void }) {
  const { t } = useTranslation();
  const [mockMode, setMockMode] = useState(false);
  const loadDetail = useCallback(async () => {
    const { data, error } = await client.aiStudio.getJob(jobId);
    if (error || !data) {
      setMockMode(true);
      const job = MOCK_JOBS.find((entry) => String(entry.id) === String(jobId));
      if (!job) return { data: null as never };
      return { data: { job, artifacts: MOCK_ARTIFACTS[String(jobId)] ?? [] } };
    }
    setMockMode(false);
    return { data };
  }, [jobId]);
  const { data, loading, error, reload } = useApiResource(loadDetail);

  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-theme/30 bg-theme/[0.03] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold t-primary">
          {t("ai_studio.detail.title", { id: String(jobId) })}
        </h3>
        <div className="flex items-center gap-2">
          {mockMode ? <MockBadge /> : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
            aria-label={t("close")}
          >
            <i className="ri-close-line text-lg" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-neutral-500">
          <Spinner label={t("ai_studio.detail.loading")} />
          <span>{t("ai_studio.detail.loading")}</span>
        </div>
      ) : null}

      {error ? (
        <SettingsCard tone="danger">
          <SettingsCardHeader title={t("ai_studio.detail.load_failed")} description={error} />
        </SettingsCard>
      ) : null}

      {!loading && !error && data ? (
        <>
          {data.job.error ? (
            <SettingsCard tone="danger">
              <SettingsCardBody>
                <p className="whitespace-pre-wrap text-sm text-rose-600 dark:text-rose-300">
                  {data.job.error}
                </p>
              </SettingsCardBody>
            </SettingsCard>
          ) : null}
          {artifacts.length === 0 ? (
            <p className="py-4 text-center text-sm text-neutral-500">{t("ai_studio.detail.empty")}</p>
          ) : (
            artifacts.map((artifact) => (
              <ArtifactCard
                key={String(artifact.id)}
                artifact={artifact}
                job={data.job}
                onChanged={() => void reload()}
              />
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs tab: list + filter + polling + wizard + detail
// ---------------------------------------------------------------------------

const JOB_FILTERS: JobFilter[] = ["all", "pending", "processing", "ready", "failed"];

function JobsPanel({ aiEnabled }: { aiEnabled: boolean }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<JobFilter>("all");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | string | null>(null);
  const [mockMode, setMockMode] = useState(false);

  const loadJobs = useCallback(async () => {
    const { data, error } = await client.aiStudio.listJobs({
      status: filter === "all" ? undefined : filter,
      page: 1,
    });
    if (error || !data) {
      setMockMode(true);
      const jobs =
        filter === "all" ? MOCK_JOBS : MOCK_JOBS.filter((job) => job.status === filter);
      return { data: { jobs, page: 1, hasNext: false } };
    }
    setMockMode(false);
    return { data };
  }, [filter]);

  const { data, loading, error, reload } = useApiResource(loadJobs);

  // Poll the list while the tab is open so processing jobs resolve live.
  useEffect(() => {
    const timer = setInterval(() => {
      void reload();
    }, AI_STUDIO_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {JOB_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${
                filter === option ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
              }`}
            >
              {t(`ai_studio.jobs.filter_${option}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {mockMode ? <MockBadge /> : null}
          <Button
            title={t("ai_studio.jobs.new")}
            disabled={!aiEnabled}
            onClick={() => setWizardOpen(true)}
          />
        </div>
      </div>

      {!aiEnabled ? (
        <SettingsCard tone="warning">
          <SettingsCardHeader
            title={t("ai_studio.disabled_title")}
            description={t("ai_studio.disabled_jobs")}
          />
        </SettingsCard>
      ) : null}

      {loading && jobs.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-sm text-neutral-500">
          <Spinner label={t("ai_studio.jobs.loading")} />
          <span>{t("ai_studio.jobs.loading")}</span>
        </div>
      ) : null}

      {error ? (
        <SettingsCard tone="danger">
          <SettingsCardHeader title={t("ai_studio.jobs.load_failed")} description={error} />
        </SettingsCard>
      ) : null}

      {!loading && !error && jobs.length === 0 ? (
        <SettingsCard>
          <SettingsCardHeader
            title={t("ai_studio.jobs.empty_title")}
            description={t("ai_studio.jobs.empty_description")}
          />
        </SettingsCard>
      ) : null}

      <div className="flex flex-col gap-3">
        {jobs.map((job) => (
          <div key={String(job.id)}>
            <SettingsCard tone={cardToneForStatus(job.status)}>
              <div className="flex items-start justify-between gap-3">
                <SettingsCardHeader
                  title={`#${String(job.id)} · ${t(`ai_studio.wizard.capability_${job.job_type.replace("-", "_")}`)}`}
                  description={formatDateTime(job.created_at)}
                  badge={<StatusBadge status={job.status} />}
                />
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
                  className="shrink-0 rounded-full p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
                  aria-label={t("ai_studio.jobs.toggle_detail")}
                >
                  <i
                    className={`ri-arrow-down-s-line text-lg transition-transform ${
                      expandedId === job.id ? "rotate-180" : ""
                    }`}
                  />
                </button>
              </div>
              <SettingsCardBody>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {job.input?.storyId ? (
                    <span>
                      {t("ai_studio.jobs.input_story")}: {String(job.input.storyId)}
                    </span>
                  ) : null}
                  {job.input?.assetId ? (
                    <span>
                      {t("ai_studio.jobs.input_asset")}: {String(job.input.assetId)}
                    </span>
                  ) : null}
                  {job.input?.question ? (
                    <span className="max-w-full truncate">
                      {t("ai_studio.jobs.input_question")}: {job.input.question}
                    </span>
                  ) : null}
                  {job.error ? (
                    <span className="text-rose-600 dark:text-rose-300">{job.error}</span>
                  ) : null}
                </div>
              </SettingsCardBody>
            </SettingsCard>
            {expandedId === job.id ? (
              <div className="mt-3">
                <JobDetail jobId={job.id} onClose={() => setExpandedId(null)} />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <JobWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => void reload()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage tab
// ---------------------------------------------------------------------------

function UsagePanel() {
  const { t } = useTranslation();
  const [mockMode, setMockMode] = useState(false);
  const loadUsage = useCallback(async () => {
    const { data, error } = await client.aiStudio.getUsage(30);
    if (error || !data) {
      setMockMode(true);
      return { data: MOCK_USAGE };
    }
    setMockMode(false);
    return { data };
  }, []);
  const { data, loading, error } = useApiResource(loadUsage);

  const byModel = Array.isArray(data?.byModel) ? data.byModel : [];
  const maxCalls = Math.max(1, ...byModel.map((row) => row.calls));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold t-primary">
          {t("ai_studio.usage.title", { days: data?.days ?? 30 })}
        </h3>
        {mockMode ? <MockBadge /> : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-neutral-500">
          <Spinner label={t("ai_studio.usage.loading")} />
          <span>{t("ai_studio.usage.loading")}</span>
        </div>
      ) : null}

      {error ? (
        <SettingsCard tone="danger">
          <SettingsCardHeader title={t("ai_studio.usage.load_failed")} description={error} />
        </SettingsCard>
      ) : null}

      {!loading && !error && data ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <SettingsCard tone="success">
              <SettingsCardHeader
                title={String(data.total.calls)}
                description={t("ai_studio.usage.total_calls")}
              />
            </SettingsCard>
            <SettingsCard>
              <SettingsCardHeader
                title={String(byModel.length)}
                description={t("ai_studio.usage.models_used")}
              />
            </SettingsCard>
            <SettingsCard>
              <SettingsCardHeader
                title={String(data.days)}
                description={t("ai_studio.usage.window_days")}
              />
            </SettingsCard>
          </div>

          <SettingsCard>
            <SettingsCardHeader
              title={t("ai_studio.usage.by_model")}
              description={t("ai_studio.usage.by_model_desc")}
            />
            <SettingsCardBody>
              {byModel.length === 0 ? (
                <p className="text-sm text-neutral-500">{t("ai_studio.usage.empty")}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {byModel.map((row) => (
                    <div key={row.model}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-mono t-primary">{row.model}</span>
                        <span className="text-neutral-500">{row.calls}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                        <div
                          className="h-full rounded-full bg-theme"
                          style={{ width: `${Math.round((row.calls / maxCalls) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SettingsCardBody>
          </SettingsCard>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab: master switch + daily quota
// ---------------------------------------------------------------------------

function SettingsPanel({
  settings,
  mockMode,
  onSaved,
}: {
  settings: AISettings;
  mockMode: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  const [enabled, setEnabled] = useState(settings.ai_enabled);
  const [quota, setQuota] = useState(String(settings.daily_call_quota));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEnabled(settings.ai_enabled);
    setQuota(String(settings.daily_call_quota));
  }, [settings]);

  async function save() {
    const parsedQuota = Number.parseInt(quota, 10);
    if (!Number.isFinite(parsedQuota) || parsedQuota < 0) {
      showAlert(t("ai_studio.settings.quota_invalid"));
      return;
    }
    setSaving(true);
    try {
      const { error } = await client.aiStudio.updateSettings({
        ai_enabled: enabled,
        daily_call_quota: parsedQuota,
      });
      if (error) {
        showAlert(error.value);
        return;
      }
      showAlert(t("ai_studio.settings.saved"));
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <AlertUI />
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold t-primary">{t("ai_studio.settings.title")}</h3>
        {mockMode ? <MockBadge /> : null}
      </div>

      <SettingsCard tone={enabled ? "success" : "warning"}>
        <SettingsCardRow
          header={
            <SettingsCardHeader
              title={t("ai_studio.settings.enabled_title")}
              description={t("ai_studio.settings.enabled_desc")}
            />
          }
          action={
            <Switch.Root
              className="SwitchRoot"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked)}
            >
              <Switch.Thumb className="SwitchThumb" />
            </Switch.Root>
          }
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          title={t("ai_studio.settings.quota_title")}
          description={t("ai_studio.settings.quota_desc")}
        />
        <SettingsCardBody>
          <input
            type="number"
            min={0}
            value={quota}
            onChange={(event) => setQuota(event.target.value)}
            className="w-40 rounded-xl border border-black/10 bg-w p-2.5 text-sm t-primary outline-none focus:border-theme dark:border-white/10"
          />
        </SettingsCardBody>
      </SettingsCard>

      <div>
        <Button
          title={saving ? t("ai_studio.settings.saving") : t("ai_studio.settings.save")}
          disabled={saving}
          onClick={() => void save()}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const TABS: JobTab[] = ["jobs", "usage", "settings"];

export function AIStudioPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const [tab, setTab] = useState<JobTab>("jobs");
  const [mockSettings, setMockSettings] = useState(false);

  const loadSettings = useCallback(async () => {
    const { data, error } = await client.aiStudio.getSettings();
    if (error || !data) {
      setMockSettings(true);
      return { data: MOCK_SETTINGS };
    }
    setMockSettings(false);
    return { data };
  }, []);
  const { data: settings, reload: reloadSettings } = useApiResource<AISettings>(loadSettings);

  const aiEnabled = settings?.ai_enabled ?? true;

  return (
    <div className="flex w-full flex-col gap-4">
      <Helmet>
        <title>{`${t("ai_studio.title")} - ${siteConfig.name}`}</title>
      </Helmet>

      <div className="flex gap-2">
        {TABS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === option ? "bg-w text-theme shadow" : "t-secondary hover:t-primary"
            }`}
          >
            {t(`ai_studio.tabs.${option}`)}
          </button>
        ))}
      </div>

      {!aiEnabled ? (
        <SettingsCard tone="danger">
          <SettingsCardHeader
            title={t("ai_studio.disabled_title")}
            description={t("ai_studio.disabled_banner")}
          />
        </SettingsCard>
      ) : null}

      {tab === "jobs" ? <JobsPanel aiEnabled={aiEnabled} /> : null}
      {tab === "usage" ? <UsagePanel /> : null}
      {tab === "settings" && settings ? (
        <SettingsPanel
          settings={settings}
          mockMode={mockSettings}
          onSaved={() => void reloadSettings()}
        />
      ) : null}
    </div>
  );
}
