import { describe, it, expect, afterEach } from "bun:test";
import { aiArtifacts, aiJobs, aiSettings, mediaAssets } from "../../../db/schema";
import { acceptArtifact } from "../jobs";
import { minimaxVideoSweep } from "../minimax-sweep";
import { processAIStudioTask } from "../processors";

const RELAY_URL = "https://relay.example";
const RELAY_SECRET = "s3cret";

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

interface FakeDb {
    statuses: string[];
    artifacts: Array<{ jobId: number; outputJson: string }>;
    inputRefsJson: string;
    mediaInserts: unknown[];
    deletedMedia: number[];
    r2Puts: Array<{ key: string; body: unknown }>;
    r2Deletes: string[];
    jobs: Array<{ id: number }>;
    artifactRow: { id: number; outputJson: string } | null;
}

function makeDb(over: Partial<FakeDb> = {}): { db: any; state: FakeDb } {
    const state: FakeDb = {
        statuses: [],
        artifacts: [],
        inputRefsJson: JSON.stringify({}),
        mediaInserts: [],
        deletedMedia: [],
        r2Puts: [],
        r2Deletes: [],
        jobs: [],
        artifactRow: null,
        ...over,
    };
    const db: any = {
        query: {
            aiJobs: {
                findFirst: async () => ({
                    id: 5,
                    jobType: "aistudio.video",
                    status: "processing",
                    inputRefsJson: state.inputRefsJson,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
                findMany: async () => state.jobs,
            },
            aiArtifacts: {
                findFirst: async () =>
                    state.artifactRow
                        ? {
                              id: state.artifactRow.id,
                              jobId: 5,
                              outputJson: state.artifactRow.outputJson,
                              acceptedAt: null,
                              createdAt: new Date(),
                          }
                        : null,
                findMany: async () => [],
            },
        },
        select: () => ({
            from: (table: unknown) => {
                if (table === aiSettings) {
                    return Promise.resolve([
                        { key: "ai_enabled", value: "1" },
                        { key: "daily_call_quota", value: "200" },
                    ]);
                }
                return { where: async () => [{ n: 0 }] };
            },
        }),
        insert: (table: unknown) => ({
            values: (vals: any) => {
                if (table === aiArtifacts) {
                    state.artifacts.push(vals);
                    return {
                        returning: async () => [
                            { id: state.artifacts.length, ...vals },
                        ],
                    };
                }
                if (table === mediaAssets) {
                    state.mediaInserts.push(vals);
                    return { returning: async () => [{ insertedId: 42 }] };
                }
                return { returning: async () => [{}] };
            },
        }),
        update: (table: unknown) => ({
            set: (vals: any) => {
                if (table === aiJobs) {
                    if (typeof vals.status === "string") state.statuses.push(vals.status);
                    if (typeof vals.inputRefsJson === "string") {
                        state.inputRefsJson = vals.inputRefsJson;
                    }
                }
                return { where: async () => undefined };
            },
        }),
        delete: () => ({
            where: async () => {
                state.deletedMedia.push(1);
                return undefined;
            },
        }),
    };
    return { db, state };
}

function makeEnv(state?: FakeDb): any {
    const puts = state?.r2Puts ?? [];
    const deletes = state?.r2Deletes ?? [];
    return {
        MINIMAX_RELAY_URL: RELAY_URL,
        MINIMAX_RELAY_SECRET: RELAY_SECRET,
        R2_BUCKET: {
            put: async (key: string, body: unknown) => {
                puts.push({ key, body });
            },
            head: async () => null,
            delete: async (key: string) => {
                deletes.push(key);
            },
        },
    };
}

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = (async (url: any, init?: any) => handler(String(url), init)) as any;
}

function videoPayload(over: Record<string, unknown> = {}) {
    return {
        jobId: 5,
        prompt: "一只猫在月光下散步",
        params: { duration: 6, resolution: "768P", ratio: "16:9" },
        ...over,
    };
}

describe("processVideo 提交", () => {
    it("提交成功后写 relayJobId 到 inputRefsJson，job 保持 processing", async () => {
        const { db, state } = makeDb();
        const seen: Array<{ url: string; body: any }> = [];
        stubFetch((url) => {
            seen.push({ url, body: null });
            return jsonResponse({ ok: true, job_id: "relay-abc" });
        });
        // 捕获提交 body
        globalThis.fetch = (async (url: any, init: any) => {
            seen.push({ url: String(url), body: JSON.parse(init.body) });
            return jsonResponse({ ok: true, job_id: "relay-abc" });
        }) as any;

        await processAIStudioTask(makeEnv(), db, {
            type: "aistudio.video",
            payload: videoPayload() as any,
        });

        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe(`${RELAY_URL}/video`);
        expect(seen[0].body.client_job_id).toBe("aistudio-5");
        expect(seen[0].body.prompt).toBe("一只猫在月光下散步");
        expect(seen[0].body.duration).toBe(6);
        expect(JSON.parse(state.inputRefsJson).relayJobId).toBe("relay-abc");
        // 只提交不收尾：processing → 不出现 completed/failed
        expect(state.statuses).toEqual(["processing"]);
    });

    it("inputRefs 已有 relayJobId 时不再重复提交（queue 重投幂等）", async () => {
        const { db, state } = makeDb({
            inputRefsJson: JSON.stringify({ relayJobId: "relay-abc" }),
        });
        let calls = 0;
        stubFetch(() => {
            calls += 1;
            return jsonResponse({ ok: true, job_id: "relay-xyz" });
        });

        await processAIStudioTask(makeEnv(), db, {
            type: "aistudio.video",
            payload: videoPayload() as any,
        });

        expect(calls).toBe(0);
        expect(state.statuses).toEqual(["processing"]);
    });

    it("prompt 为空直接 failed，不调 relay", async () => {
        const { db, state } = makeDb();
        let calls = 0;
        stubFetch(() => {
            calls += 1;
            return jsonResponse({ ok: true, job_id: "relay-abc" });
        });

        await processAIStudioTask(makeEnv(), db, {
            type: "aistudio.video",
            payload: videoPayload({ prompt: "  " }) as any,
        });

        expect(calls).toBe(0);
        expect(state.statuses).toEqual(["processing", "failed"]);
        expect(state.artifacts[0]?.outputJson).toContain('"kind":"error"');
    });

    it("relay 未配置时 failed，不调网络", async () => {
        const { db, state } = makeDb();
        let calls = 0;
        stubFetch(() => {
            calls += 1;
            return jsonResponse({ ok: true, job_id: "relay-abc" });
        });

        await processAIStudioTask({} as any, db, {
            type: "aistudio.video",
            payload: videoPayload() as any,
        });

        expect(calls).toBe(0);
        expect(state.statuses).toEqual(["processing", "failed"]);
    });
});

describe("minimaxVideoSweep 轮询收尾", () => {
    const env = {
        MINIMAX_RELAY_URL: RELAY_URL,
        MINIMAX_RELAY_SECRET: RELAY_SECRET,
    } as any;

    it("relay succeeded → 存 video artifact 并 completed", async () => {
        const { db, state } = makeDb({
            jobs: [{ id: 5 }],
            inputRefsJson: JSON.stringify({ relayJobId: "relay-abc" }),
        });
        stubFetch((url) => {
            expect(url).toBe(`${RELAY_URL}/video/relay-abc`);
            return jsonResponse({
                ok: true,
                job_id: "relay-abc",
                status: "succeeded",
                prompt: "一只猫在月光下散步",
                duration: 6,
                resolution: "768P",
                ratio: "16:9",
                bytes: 12345,
            });
        });

        const result = await minimaxVideoSweep(env, db);

        expect(result).toEqual({ checked: 1, completed: 1, failed: 0 });
        const output = JSON.parse(state.artifacts[0].outputJson);
        expect(output.kind).toBe("video");
        expect(output.relayJobId).toBe("relay-abc");
        expect(output.bytes).toBe(12345);
        expect(state.statuses).toEqual(["completed"]);
    });

    it("relay failed → 存 error artifact 并 failed", async () => {
        const { db, state } = makeDb({
            jobs: [{ id: 5 }],
            inputRefsJson: JSON.stringify({ relayJobId: "relay-abc" }),
        });
        stubFetch(() =>
            jsonResponse({ ok: true, job_id: "relay-abc", status: "failed", error: "余额不足" }),
        );

        const result = await minimaxVideoSweep(env, db);

        expect(result).toEqual({ checked: 1, completed: 0, failed: 1 });
        expect(state.artifacts[0].outputJson).toContain("余额不足");
        expect(state.statuses).toEqual(["failed"]);
    });

    it("relay 不可达（网络错）→ 不动，下轮再试", async () => {
        const { db, state } = makeDb({
            jobs: [{ id: 5 }],
            inputRefsJson: JSON.stringify({ relayJobId: "relay-abc" }),
        });
        stubFetch(() => {
            throw new Error("connect timeout");
        });

        const result = await minimaxVideoSweep(env, db);

        expect(result).toEqual({ checked: 1, completed: 0, failed: 0 });
        expect(state.statuses).toEqual([]);
        expect(state.artifacts).toHaveLength(0);
    });

    it("relay running → 不动", async () => {
        const { db, state } = makeDb({
            jobs: [{ id: 5 }],
            inputRefsJson: JSON.stringify({ relayJobId: "relay-abc" }),
        });
        stubFetch(() => jsonResponse({ ok: true, job_id: "relay-abc", status: "running" }));

        const result = await minimaxVideoSweep(env, db);

        expect(result).toEqual({ checked: 1, completed: 0, failed: 0 });
        expect(state.statuses).toEqual([]);
    });

    it("inputRefs 无 relayJobId → failed（残留无法追踪）", async () => {
        const { db, state } = makeDb({ jobs: [{ id: 5 }] });
        let calls = 0;
        stubFetch(() => {
            calls += 1;
            return jsonResponse({ ok: true });
        });

        const result = await minimaxVideoSweep(env, db);

        expect(result).toEqual({ checked: 1, completed: 0, failed: 1 });
        expect(calls).toBe(0);
        expect(state.statuses).toEqual(["failed"]);
    });

    it("relay 未配置 → 静默跳过", async () => {
        const { db } = makeDb({ jobs: [{ id: 5 }] });
        const result = await minimaxVideoSweep({} as any, db);
        expect(result).toEqual({ checked: 0, completed: 0, failed: 0 });
    });
});

describe("acceptArtifact video 流式入库", () => {
    function streamResponse(bytes: number, contentLength: string | null): Response {
        const chunk = new Uint8Array(1024).fill(7);
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent >= bytes) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk);
                sent += chunk.length;
            },
        });
        const headers: Record<string, string> = { "Content-Type": "video/mp4" };
        if (contentLength !== null) headers["Content-Length"] = contentLength;
        return new Response(stream as any, { status: 200, headers });
    }

    function videoArtifactDb() {
        return makeDb({
            artifactRow: {
                id: 9,
                outputJson: JSON.stringify({
                    kind: "video",
                    relayJobId: "relay-abc",
                    prompt: "测试视频",
                    duration: 6,
                }),
            },
        });
    }

    it("ReadableStream 直写 R2，不缓冲整文件", async () => {
        const { db, state } = videoArtifactDb();
        stubFetch(() => streamResponse(10 * 1024, String(10 * 1024)));

        const result = await acceptArtifact(db, 9, { env: makeEnv(state) });

        expect(result).toEqual({ ok: true, applied: true });
        expect(state.r2Puts).toHaveLength(1);
        // 关键断言：传给 R2 的是流，不是整块内存缓冲
        expect(state.r2Puts[0].body).toBeInstanceOf(ReadableStream);
        expect(state.mediaInserts[0]).toMatchObject({ kind: "video", source: "r2" });
        expect(state.deletedMedia).toHaveLength(0);
    });

    it("Content-Length 超限直接拒绝，不下载不入库", async () => {
        const { db, state } = videoArtifactDb();
        let calls = 0;
        stubFetch(() => {
            calls += 1;
            return streamResponse(0, String(600 * 1024 * 1024));
        });

        const result = await acceptArtifact(db, 9, { env: makeEnv(state) });

        expect(result.ok).toBe(false);
        expect(state.r2Puts).toHaveLength(0);
        expect(state.mediaInserts).toHaveLength(0);
        expect(calls).toBe(1);
    });

    it("artifact 不存在返回 not found", async () => {
        const { db, state } = makeDb({ artifactRow: null });
        const result = await acceptArtifact(db, 999, { env: makeEnv(state) });
        expect(result).toEqual({ ok: false, error: "Artifact not found" });
    });
});
