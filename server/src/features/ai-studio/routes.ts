/**
 * Stage 4 · AI Studio 管理路由（挂载到 /api/admin/ai-studio，需管理员鉴权）。
 *
 * POST /jobs        创建 job 并投递到队列      -> 201 {id, job_type, status}
 * GET  /jobs        job 列表（?status=&page=）  -> {jobs, page, hasNext}
 * GET  /jobs/:id    job + artifacts           -> {job, artifacts}
 * POST /artifacts/:id/accept  接受（写入正文/转录） -> 200 {ok, applied}
 * POST /artifacts/:id/reject  拒绝（丢弃）          -> 200 {ok}
 * GET  /usage        用量统计（?days=30）        -> {days, total, byModel}
 * GET  /settings     开关与配额                 -> {ai_enabled, daily_call_quota}
 * PUT  /settings     更新开关与配额             -> 200 {ok}
 *
 * 守卫：除 /settings 外，所有路由先过 checkAIGuard —
 *   ai_enabled=0 → 503 {error:{code:'ai_disabled'}}
 *   当日调用数 >= daily_call_quota → 429 {error:{code:'quota_exceeded'}}
 * /settings 例外：关闭后必须还能通过它重新打开，否则 kill-switch 不可逆。
 */
import { t } from "@rin/api";
import { Hono } from "hono";
import type { AppContext, Variables } from "../../core/hono-types";
import { adminOnly, withJsonBody } from "../../core/route-boundaries";
import { createTaskQueue } from "../../queue";
import {
    createAIStudioTask,
    type AIStudioTaskPayload,
    type AIStudioTaskType,
} from "../../queue/tasks";
import { getWorkerAIModelId } from "../../utils/ai";
import {
    checkAIGuard,
    readAISettings,
    summarizeUsage,
    writeAISettings,
    type AIGuardFailure,
} from "./guard";
import {
    acceptArtifact,
    createJob,
    getArtifact,
    getJobWithArtifacts,
    listJobs,
    rejectArtifact,
    saveArtifact,
    setJobStatus,
} from "./jobs";
import {
    AI_STUDIO_JOB_KINDS,
    CHAT_MODEL,
    EMBED_MODEL,
    WHISPER_MODEL,
    aiStudioJobType,
    isAIStudioJobKind,
    type AIStudioJobKind,
} from "./models";

type HonoApp = Hono<{ Bindings: Env; Variables: Variables }>;

const KIND_MODELS: Record<AIStudioJobKind, string> = {
    transcribe: WHISPER_MODEL,
    derive: CHAT_MODEL,
    check: CHAT_MODEL,
    "retrieval-test": EMBED_MODEL,
    embed: EMBED_MODEL,
};

const KIND_QUEUE_TYPES: Record<AIStudioJobKind, AIStudioTaskType> = {
    transcribe: "aistudio.transcribe",
    derive: "aistudio.derive",
    check: "aistudio.check",
    "retrieval-test": "aistudio.retrieval-test",
    embed: "aistudio.embed",
};

function guardError(c: AppContext, failure: AIGuardFailure) {
    return c.json(
        { error: { code: failure.code, message: failure.message } },
        failure.status,
    );
}

/** 管理路由守卫：admin → AI 总开关/配额 → handler */
function aiStudioRoute(
    handler: (c: AppContext) => Response | Promise<Response>,
) {
    return adminOnly(async (c) => {
        const guard = await checkAIGuard(c.get("db"));
        if (!guard.ok) return guardError(c, guard);
        return handler(c);
    }, { message: "Permission denied", status: 403 });
}

const createJobSchema = t.Object({
    kind: t.String(),
    input: t.Optional(
        t.Object({
            storyId: t.Optional(t.Integer()),
            assetId: t.Optional(t.Integer()),
            text: t.Optional(t.String()),
            question: t.Optional(t.String()),
        }),
    ),
    params: t.Optional(t.Object({}, { additionalProperties: true })),
});

type CreateJobBody = {
    kind: string;
    input?: { storyId?: number; assetId?: number; text?: string; question?: string };
    params?: Record<string, unknown>;
};

function validateJobInput(
    kind: AIStudioJobKind,
    input: CreateJobBody["input"],
): { ok: true; payload: AIStudioTaskPayload } | { ok: false; error: string } {
    // jobId 由创建后填入，这里先占位
    const base = { jobId: -1 };
    switch (kind) {
        case "transcribe":
            if (!Number.isInteger(input?.assetId)) {
                return { ok: false, error: "transcribe 需要 input.assetId（整数）" };
            }
            return { ok: true, payload: { ...base, assetId: input!.assetId } };
        case "derive":
        case "check":
            if (!Number.isInteger(input?.storyId)) {
                return { ok: false, error: `${kind} 需要 input.storyId（整数）` };
            }
            return { ok: true, payload: { ...base, storyId: input!.storyId } };
        case "retrieval-test":
            if (typeof input?.question !== "string" || !input.question.trim()) {
                return { ok: false, error: "retrieval-test 需要 input.question（非空字符串）" };
            }
            return { ok: true, payload: { ...base, question: input.question.trim() } };
        case "embed":
            return { ok: true, payload: { ...base } };
    }
}

async function enqueueJob(
    env: Env,
    jobId: number,
    kind: AIStudioJobKind,
    payload: AIStudioTaskPayload,
    params?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await createTaskQueue(env).send(
            createAIStudioTask(KIND_QUEUE_TYPES[kind], { ...payload, jobId, params }),
        );
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

const settingsSchema = t.Object({
    ai_enabled: t.Optional(t.Boolean()),
    daily_call_quota: t.Optional(t.Integer()),
});

type SettingsBody = { ai_enabled?: boolean; daily_call_quota?: number };

export function AIStudioService(): HonoApp {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();

    // POST /jobs
    app.post(
        "/jobs",
        aiStudioRoute(
            withJsonBody<CreateJobBody>(createJobSchema, async (c, body) => {
                const db = c.get("db");
                const env = c.get("env");

                if (!isAIStudioJobKind(body.kind)) {
                    return c.json(
                        {
                            error: {
                                code: "invalid_kind",
                                message: `kind 必须是 ${AI_STUDIO_JOB_KINDS.join("|")} 之一`,
                            },
                        },
                        400,
                    );
                }
                const kind = body.kind;

                const validated = validateJobInput(kind, body.input);
                if (!validated.ok) {
                    return c.json({ error: { code: "invalid_input", message: validated.error } }, 400);
                }

                const modelRef = getWorkerAIModelId(KIND_MODELS[kind]);
                const job = await createJob(
                    db,
                    kind,
                    { kind, ...(body.input ?? {}), ...(body.params ?? {}) },
                    modelRef,
                );

                const enqueued = await enqueueJob(env, job.id, kind, validated.payload, body.params);
                if (!enqueued.ok) {
                    await saveArtifact(db, job.id, { kind: "error", message: enqueued.error });
                    await setJobStatus(db, job.id, "failed");
                    return c.json(
                        { error: { code: "queue_unavailable", message: enqueued.error } },
                        500,
                    );
                }

                return c.json({ id: job.id, job_type: aiStudioJobType(kind), status: "pending" }, 201);
            }),
        ),
    );

    // GET /jobs?status=&page=
    app.get(
        "/jobs",
        aiStudioRoute(async (c) => {
            const db = c.get("db");
            const status = c.req.query("status") || undefined;
            const page = Number.parseInt(c.req.query("page") ?? "1", 10);
            const result = await listJobs(db, {
                status,
                page: Number.isFinite(page) ? page : 1,
            });
            return c.json(result);
        }),
    );

    // GET /jobs/:id
    app.get(
        "/jobs/:id",
        aiStudioRoute(async (c) => {
            const db = c.get("db");
            const id = Number.parseInt(c.req.param("id"), 10);
            if (!Number.isFinite(id)) return c.text("Invalid id", 400);
            const result = await getJobWithArtifacts(db, id);
            if (!result) return c.text("Not found", 404);
            return c.json(result);
        }),
    );

    // POST /artifacts/:id/accept
    app.post(
        "/artifacts/:id/accept",
        aiStudioRoute(async (c) => {
            const db = c.get("db");
            const id = Number.parseInt(c.req.param("id"), 10);
            if (!Number.isFinite(id)) return c.text("Invalid id", 400);
            const artifact = await getArtifact(db, id);
            if (!artifact) return c.text("Not found", 404);
            const result = await acceptArtifact(db, id);
            if (!result.ok) {
                return c.json({ error: { code: "accept_failed", message: result.error } }, 400);
            }
            return c.json({ ok: true, applied: result.applied });
        }),
    );

    // POST /artifacts/:id/reject
    app.post(
        "/artifacts/:id/reject",
        aiStudioRoute(async (c) => {
            const db = c.get("db");
            const id = Number.parseInt(c.req.param("id"), 10);
            if (!Number.isFinite(id)) return c.text("Invalid id", 400);
            await rejectArtifact(db, id);
            return c.json({ ok: true });
        }),
    );

    // GET /usage?days=30
    app.get(
        "/usage",
        aiStudioRoute(async (c) => {
            const db = c.get("db");
            const raw = Number.parseInt(c.req.query("days") ?? "30", 10);
            const days = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 365) : 30;
            return c.json(await summarizeUsage(db, days));
        }),
    );

    // GET /settings（免 AI 守卫：关闭后需能重新打开）
    app.get(
        "/settings",
        adminOnly(async (c) => {
            const settings = await readAISettings(c.get("db"));
            return c.json({
                ai_enabled: settings.aiEnabled,
                daily_call_quota: settings.dailyCallQuota,
            });
        }, { message: "Permission denied", status: 403 }),
    );

    // PUT /settings（免 AI 守卫，理由同上）
    app.put(
        "/settings",
        adminOnly(
            withJsonBody<SettingsBody>(settingsSchema, async (c, body) => {
                if (body.daily_call_quota !== undefined) {
                    if (!Number.isInteger(body.daily_call_quota) || body.daily_call_quota < 1 || body.daily_call_quota > 100000) {
                        return c.json(
                            { error: { code: "invalid_quota", message: "daily_call_quota 必须是 1–100000 的整数" } },
                            400,
                        );
                    }
                }
                await writeAISettings(c.get("db"), {
                    aiEnabled: body.ai_enabled,
                    dailyCallQuota: body.daily_call_quota,
                });
                return c.json({ ok: true });
            }),
            { format: "json" },
        ),
    );

    return app;
}
