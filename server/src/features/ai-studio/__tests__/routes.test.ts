import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Variables } from "../../../core/hono-types";
import { aiArtifacts, aiJobs, aiSettings, aiUsage, stories, transcripts } from "../../../db/schema";
import { AIStudioService } from "../routes";

type TestApp = Hono<{ Bindings: Env; Variables: Variables }>;

interface BuildOptions {
    admin?: boolean;
    settings?: Record<string, string>;
    usageCount?: number;
    onSend?: (task: unknown) => void;
    noQueue?: boolean;
    jobs?: any[];
    jobDetail?: { job: any; artifacts: any[] } | null;
    artifact?: any | null;
    existingTranscript?: any | null;
    insertedJob?: any;
}

function tableName(table: unknown): string {
    if (table === aiJobs) return "ai_jobs";
    if (table === aiArtifacts) return "ai_artifacts";
    if (table === aiSettings) return "ai_settings";
    if (table === aiUsage) return "ai_usage";
    if (table === transcripts) return "transcripts";
    if (table === stories) return "stories";
    return "unknown";
}

function buildApp(options: BuildOptions = {}) {
    const app: TestApp = new Hono<{ Bindings: Env; Variables: Variables }>();
    const ops: Array<{ op: string; table: string; values?: unknown }> = [];
    const sent: unknown[] = [];
    const settingsRows = Object.entries(
        options.settings ?? { ai_enabled: "1", daily_call_quota: "200" },
    ).map(([key, value]) => ({ key, value }));

    const usageChain: any = {};
    usageChain.where = () => usageChain;
    usageChain.groupBy = () => usageChain;
    usageChain.orderBy = async () => [];
    usageChain.then = (resolve: any, reject: any) =>
        Promise.resolve([{ n: options.usageCount ?? 0 }]).then(resolve, reject);

    const insertedJob = options.insertedJob ?? {
        id: 7,
        jobType: "aistudio.transcribe",
        inputRefsJson: "{}",
        modelRef: "@cf/openai/whisper",
        status: "pending",
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
        updatedAt: new Date("2026-09-24T00:00:00.000Z"),
    };

    const db: any = {
        ops,
        select: () => ({
            from: (table: unknown) => {
                if (table === aiSettings) return Promise.resolve(settingsRows);
                if (table === aiUsage) return usageChain;
                throw new Error("unexpected select table");
            },
        }),
        insert: (table: unknown) => ({
            values: (values: unknown) => {
                ops.push({ op: "insert", table: tableName(table), values });
                const chain: any = {
                    returning: async () =>
                        table === aiJobs ? [insertedJob] : [{ id: 11 }],
                    onConflictDoUpdate: async () => undefined,
                    then: (resolve: any, reject: any) =>
                        Promise.resolve(undefined).then(resolve, reject),
                };
                return chain;
            },
        }),
        update: (table: unknown) => ({
            set: (values: unknown) => {
                ops.push({ op: "update", table: tableName(table), values });
                return { where: async () => undefined };
            },
        }),
        delete: (table: unknown) => {
            ops.push({ op: "delete", table: tableName(table) });
            return { where: async () => undefined };
        },
        query: {
            aiJobs: {
                findMany: async () => options.jobs ?? [],
                findFirst: async () => options.jobDetail?.job ?? null,
            },
            aiArtifacts: {
                findMany: async () => options.jobDetail?.artifacts ?? [],
                findFirst: async () => options.artifact ?? null,
            },
            transcripts: {
                findFirst: async () => options.existingTranscript ?? null,
            },
        },
    };

    const env: any = options.noQueue
        ? {}
        : {
              TASK_QUEUE: {
                  send: async (task: unknown) => {
                      sent.push(task);
                      await options.onSend?.(task);
                  },
              },
          };

    app.use("*", async (c, next) => {
        c.set("db", db);
        c.set("admin", options.admin ?? true);
        c.set("env", env);
        await next();
    });

    app.route("/", AIStudioService());
    return { app, ops, sent, db };
}

function post(app: TestApp, path: string, body?: unknown) {
    return app.request(path, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
    });
}

describe("POST /jobs", () => {
    it("rejects non-admin with 403", async () => {
        const { app } = buildApp({ admin: false });
        const res = await post(app, "/jobs", { kind: "embed" });
        expect(res.status).toBe(403);
    });

    it("returns 503 ai_disabled when the kill switch is off", async () => {
        const { app } = buildApp({ settings: { ai_enabled: "0", daily_call_quota: "200" } });
        const res = await post(app, "/jobs", { kind: "embed" });
        expect(res.status).toBe(503);
        const body = (await res.json()) as any;
        expect(body.error.code).toBe("ai_disabled");
    });

    it("returns 429 quota_exceeded when the daily quota is used up", async () => {
        const { app } = buildApp({
            settings: { ai_enabled: "1", daily_call_quota: "5" },
            usageCount: 5,
        });
        const res = await post(app, "/jobs", { kind: "embed" });
        expect(res.status).toBe(429);
        const body = (await res.json()) as any;
        expect(body.error.code).toBe("quota_exceeded");
    });

    it("rejects unknown kind with 400", async () => {
        const { app } = buildApp();
        const res = await post(app, "/jobs", { kind: "nope" });
        expect(res.status).toBe(400);
        const body = (await res.json()) as any;
        expect(body.error.code).toBe("invalid_kind");
    });

    it("requires assetId for transcribe", async () => {
        const { app } = buildApp();
        const res = await post(app, "/jobs", { kind: "transcribe", input: {} });
        expect(res.status).toBe(400);
    });

    it("requires question for retrieval-test", async () => {
        const { app } = buildApp();
        const res = await post(app, "/jobs", { kind: "retrieval-test", input: { question: " " } });
        expect(res.status).toBe(400);
    });

    it("creates the job and enqueues the task", async () => {
        const { app, sent } = buildApp();
        const res = await post(app, "/jobs", { kind: "transcribe", input: { assetId: 9 } });
        expect(res.status).toBe(201);
        const body = (await res.json()) as any;
        expect(body).toMatchObject({ id: 7, job_type: "aistudio.transcribe", status: "pending" });
        expect(sent.length).toBe(1);
        const task = sent[0] as any;
        expect(task.type).toBe("aistudio.transcribe");
        expect(task.payload.jobId).toBe(7);
        expect(task.payload.assetId).toBe(9);
    });

    it("marks the job failed when the queue is unavailable", async () => {
        const { app, ops } = buildApp({ noQueue: true });
        const res = await post(app, "/jobs", { kind: "embed" });
        expect(res.status).toBe(500);
        const body = (await res.json()) as any;
        expect(body.error.code).toBe("queue_unavailable");
        expect(ops.some((o) => o.op === "update" && o.table === "ai_jobs")).toBe(true);
    });
});

describe("GET /jobs", () => {
    it("returns the contracted list shape", async () => {
        const { app } = buildApp({
            jobs: [
                {
                    id: 1,
                    jobType: "aistudio.embed",
                    status: "completed",
                    createdAt: new Date("2026-09-24T00:00:00.000Z"),
                    updatedAt: new Date("2026-09-24T00:00:00.000Z"),
                },
            ],
        });
        const res = await app.request("/jobs?page=1");
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.page).toBe(1);
        expect(body.hasNext).toBe(false);
        expect(body.jobs[0]).toMatchObject({ id: 1, job_type: "aistudio.embed", status: "completed" });
    });

    it("is guarded by ai_enabled", async () => {
        const { app } = buildApp({ settings: { ai_enabled: "0" } });
        const res = await app.request("/jobs");
        expect(res.status).toBe(503);
    });
});

describe("GET /jobs/:id", () => {
    it("returns job with artifacts", async () => {
        const job = {
            id: 7,
            jobType: "aistudio.transcribe",
            status: "completed",
            createdAt: new Date("2026-09-24T00:00:00.000Z"),
            updatedAt: new Date("2026-09-24T00:00:00.000Z"),
        };
        const { app } = buildApp({
            jobDetail: {
                job,
                artifacts: [
                    {
                        id: 11,
                        jobId: 7,
                        outputJson: JSON.stringify({ kind: "transcript", text: "hi" }),
                        acceptedAt: null,
                        createdAt: new Date("2026-09-24T00:00:00.000Z"),
                    },
                ],
            },
        });
        const res = await app.request("/jobs/7");
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.job.id).toBe(7);
        expect(body.artifacts.length).toBe(1);
        expect(body.artifacts[0].output_json).toMatchObject({ kind: "transcript" });
        expect(body.artifacts[0].accepted_at).toBeNull();
    });

    it("returns 404 for unknown job", async () => {
        const { app } = buildApp({ jobDetail: null });
        const res = await app.request("/jobs/999");
        expect(res.status).toBe(404);
    });
});

describe("POST /artifacts/:id/accept", () => {
    const transcriptArtifact = {
        id: 11,
        jobId: 7,
        outputJson: JSON.stringify({
            kind: "transcript",
            assetId: 9,
            language: "zh",
            text: "转写全文",
            segments: [{ start: 0, end: 1, text: "转写全文" }],
        }),
        acceptedAt: null,
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
    };

    it("writes the transcript on accept", async () => {
        const { app, ops } = buildApp({ artifact: transcriptArtifact });
        const res = await post(app, "/artifacts/11/accept");
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body).toEqual({ ok: true, applied: true });

        const transcriptInsert = ops.find((o) => o.op === "insert" && o.table === "transcripts");
        expect(transcriptInsert).toBeDefined();
        expect(transcriptInsert!.values).toMatchObject({ assetId: 9, text: "转写全文", status: "draft" });

        const acceptedMark = ops.find((o) => o.op === "update" && o.table === "ai_artifacts");
        expect(acceptedMark).toBeDefined();
        expect((acceptedMark!.values as any).acceptedAt).toBeInstanceOf(Date);
    });

    it("is idempotent when already accepted", async () => {
        const { app, ops } = buildApp({
            artifact: { ...transcriptArtifact, acceptedAt: new Date("2026-09-24T01:00:00.000Z") },
        });
        const res = await post(app, "/artifacts/11/accept");
        expect(res.status).toBe(200);
        expect((await res.json()) as any).toEqual({ ok: true, applied: false });
        expect(ops.some((o) => o.table === "transcripts")).toBe(false);
    });

    it("returns 404 for unknown artifact", async () => {
        const { app } = buildApp({ artifact: null });
        const res = await post(app, "/artifacts/999/accept");
        expect(res.status).toBe(404);
    });

    it("refuses error artifacts without marking accepted", async () => {
        const { app, ops } = buildApp({
            artifact: {
                ...transcriptArtifact,
                outputJson: JSON.stringify({ kind: "error", message: "boom" }),
            },
        });
        const res = await post(app, "/artifacts/11/accept");
        expect(res.status).toBe(400);
        expect((await res.json()) as any).toEqual({
            error: { code: "accept_failed", message: "Cannot accept an error artifact" },
        });
        expect(ops.some((o) => o.op === "update" && o.table === "ai_artifacts")).toBe(false);
    });

    it("refuses unknown kinds without marking accepted", async () => {
        const { app, ops } = buildApp({
            artifact: {
                ...transcriptArtifact,
                outputJson: JSON.stringify({ kind: "mystery" }),
            },
        });
        const res = await post(app, "/artifacts/11/accept");
        expect(res.status).toBe(400);
        expect(ops.some((o) => o.op === "update" && o.table === "ai_artifacts")).toBe(false);
    });
});

describe("POST /artifacts/:id/reject", () => {
    it("discards the artifact", async () => {
        const { app, ops } = buildApp({ artifact: { id: 11 } });
        const res = await post(app, "/artifacts/11/reject");
        expect(res.status).toBe(200);
        expect((await res.json()) as any).toEqual({ ok: true });
        expect(ops.some((o) => o.op === "delete" && o.table === "ai_artifacts")).toBe(true);
    });
});

describe("GET /settings", () => {
    it("returns the contracted shape (and stays available when disabled)", async () => {
        const { app } = buildApp({ settings: { ai_enabled: "0", daily_call_quota: "50" } });
        const res = await app.request("/settings");
        expect(res.status).toBe(200);
        expect((await res.json()) as any).toEqual({ ai_enabled: false, daily_call_quota: 50 });
    });

    it("rejects non-admin", async () => {
        const { app } = buildApp({ admin: false });
        expect((await app.request("/settings")).status).toBe(403);
    });
});

describe("PUT /settings", () => {
    it("updates settings", async () => {
        const { app, ops } = buildApp();
        const res = await app.request("/settings", {
            method: "PUT",
            body: JSON.stringify({ ai_enabled: false, daily_call_quota: 42 }),
            headers: { "Content-Type": "application/json" },
        });
        expect(res.status).toBe(200);
        expect((await res.json()) as any).toEqual({ ok: true });
        const writes = ops.filter((o) => o.op === "insert" && o.table === "ai_settings");
        expect(writes.length).toBe(2);
    });

    it("rejects invalid quota", async () => {
        const { app } = buildApp();
        const res = await app.request("/settings", {
            method: "PUT",
            body: JSON.stringify({ daily_call_quota: 0 }),
            headers: { "Content-Type": "application/json" },
        });
        expect(res.status).toBe(400);
    });

    it("stays available when AI is disabled (kill-switch recovery)", async () => {
        const { app } = buildApp({ settings: { ai_enabled: "0" } });
        const res = await app.request("/settings", {
            method: "PUT",
            body: JSON.stringify({ ai_enabled: true }),
            headers: { "Content-Type": "application/json" },
        });
        expect(res.status).toBe(200);
    });
});

describe("GET /usage", () => {
    it("returns the contracted shape", async () => {
        const { app } = buildApp({ usageCount: 3 });
        const res = await app.request("/usage?days=7");
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.days).toBe(7);
        expect(body.total).toEqual({ calls: 3 });
        expect(Array.isArray(body.byModel)).toBe(true);
    });
});
