import { describe, expect, it } from "bun:test";
import {
    deleteFeedTTSAsset,
    processFeedAITTSTask,
    resolveTTSTaskPlan,
    syncFeedAITTSQueueState,
    ttsR2Key,
} from "../feed-ai-tts";
import { TTS_MAX_CHARS } from "../../utils/tts";

describe("ttsR2Key", () => {
    it("builds a versioned key that never overwrites older audio", () => {
        expect(ttsR2Key(12, 1759000000)).toBe("tts/feed-12-1759000000.mp3");
    });
});

describe("resolveTTSTaskPlan", () => {
    it("rejects content that is empty after cleaning", () => {
        const plan = resolveTTSTaskPlan("![](https://x/y.png)\n\n```js\ncode\n```");
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.error).toContain("为空");
    });

    it("rejects overlong speech text", () => {
        const plan = resolveTTSTaskPlan("中".repeat(TTS_MAX_CHARS + 1));
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.error).toContain("过长");
    });

    it("accepts normal articles and chunks them", () => {
        const plan = resolveTTSTaskPlan("# 标题\n\n这是正文第一段。\n\n这是第二段。");
        expect(plan.ok).toBe(true);
        if (plan.ok) {
            expect(plan.text).toContain("标题。");
            expect(plan.chunks.length).toBeGreaterThan(0);
        }
    });
});

// ---------------------------------------------------------------------------
// processFeedAITTSTask：用最小 fake db 覆盖核心分支
// ---------------------------------------------------------------------------

function makeFeedRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        alias: null,
        title: "测试文章",
        content: "你好，这是一篇测试文章。",
        draft: 0,
        listed: 1,
        ai_tts_status: "idle",
        ai_tts_error: "",
        tts_asset_id: null as number | null,
        createdAt: new Date("2026-09-28T10:00:00.000Z"),
        updatedAt: new Date("2026-09-28T10:00:00.000Z"),
        ...overrides,
    };
}

function makeFakeDb(feedRow: ReturnType<typeof makeFeedRow>) {
    const calls: string[] = [];
    const db = {
        query: {
            feeds: { findFirst: async () => feedRow },
            mediaAssets: { findFirst: async () => null },
        },
        update: (_table: unknown) => ({
            set: (values: Record<string, unknown>) => {
                calls.push(`update:${JSON.stringify(values)}`);
                Object.assign(feedRow, values);
                return { where: async () => undefined };
            },
        }),
        insert: (_table: unknown) => ({
            values: (v: Record<string, unknown>) => {
                calls.push(`insert:${String(v.kind)}/${String(v.r2Key)}`);
                return { returning: async () => [{ id: 7 }] };
            },
        }),
        delete: (_table: unknown) => {
            calls.push("delete");
            return { where: async () => undefined };
        },
    };
    return { db: db as any, calls, feedRow };
}

function makeEnv() {
    const puts: Array<{ key: string; size: number }> = [];
    return {
        env: {
            AI: {
                run: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer,
            },
            R2_BUCKET: {
                put: async (key: string, body: Uint8Array) => {
                    puts.push({ key, size: body.length });
                },
                delete: async () => undefined,
            },
        } as unknown as Env,
        puts,
    };
}

const noopCache = {} as any;
const noopConfig = { get: async () => undefined };
const noopClearFeedCache = async () => undefined;
const updatedAtUnix = Math.floor(new Date("2026-09-28T10:00:00.000Z").getTime() / 1000);

describe("processFeedAITTSTask", () => {
    it("ignores tasks whose expectedUpdatedAt does not match (stale task)", async () => {
        const { db, calls, feedRow } = makeFakeDb(makeFeedRow());
        const { env } = makeEnv();
        await processFeedAITTSTask(
            env,
            db,
            noopCache,
            noopConfig,
            { feedId: 1, expectedUpdatedAtUnix: 1 },
            noopClearFeedCache,
        );
        expect(calls).toEqual([]);
        expect(feedRow.ai_tts_status).toBe("idle");
    });

    it("marks failed when speech text is empty after cleaning", async () => {
        const { db, feedRow } = makeFakeDb(
            makeFeedRow({ content: "![](https://x/y.png)" }),
        );
        const { env, puts } = makeEnv();
        await processFeedAITTSTask(
            env,
            db,
            noopCache,
            noopConfig,
            { feedId: 1, expectedUpdatedAtUnix: updatedAtUnix },
            noopClearFeedCache,
        );
        expect(feedRow.ai_tts_status).toBe("failed");
        expect(feedRow.ai_tts_error).toContain("为空");
        expect(puts).toEqual([]);
    });

    it("marks failed when speech text exceeds the limit", async () => {
        const { db, feedRow } = makeFakeDb(
            makeFeedRow({ content: "中".repeat(TTS_MAX_CHARS + 1) }),
        );
        const { env, puts } = makeEnv();
        await processFeedAITTSTask(
            env,
            db,
            noopCache,
            noopConfig,
            { feedId: 1, expectedUpdatedAtUnix: updatedAtUnix },
            noopClearFeedCache,
        );
        expect(feedRow.ai_tts_status).toBe("failed");
        expect(feedRow.ai_tts_error).toContain("过长");
        expect(puts).toEqual([]);
    });

    it("marks failed when Workers AI rejects (e.g. 401 without permission)", async () => {
        const { db, calls, feedRow } = makeFakeDb(makeFeedRow());
        const env = {
            AI: {
                run: async () => {
                    throw new Error("401 Unauthorized");
                },
            },
            R2_BUCKET: { put: async () => undefined, delete: async () => undefined },
        } as unknown as Env;
        await processFeedAITTSTask(
            env,
            db,
            noopCache,
            noopConfig,
            { feedId: 1, expectedUpdatedAtUnix: updatedAtUnix },
            noopClearFeedCache,
        );
        expect(feedRow.ai_tts_status).toBe("failed");
        expect(feedRow.ai_tts_error).toContain("401");
        expect(calls.some((c) => c.startsWith("insert:"))).toBe(false);
    });

    it("completes the happy path: synth -> concat -> R2 -> media_assets -> feeds", async () => {
        const { db, calls, feedRow } = makeFakeDb(makeFeedRow());
        const { env, puts } = makeEnv();
        await processFeedAITTSTask(
            env,
            db,
            noopCache,
            noopConfig,
            { feedId: 1, expectedUpdatedAtUnix: updatedAtUnix },
            noopClearFeedCache,
        );
        expect(feedRow.ai_tts_status).toBe("completed");
        expect(feedRow.ai_tts_error).toBe("");
        expect(feedRow.tts_asset_id).toBe(7);
        expect(puts).toHaveLength(1);
        expect(puts[0].key).toBe(`tts/feed-1-${updatedAtUnix}.mp3`);
        expect(puts[0].size).toBeGreaterThan(0);
        expect(calls.some((c) => c === "insert:audio/tts/feed-1-" + updatedAtUnix + ".mp3")).toBe(true);
    });

    it("resets to idle for draft feeds", async () => {
        const { db, feedRow } = makeFakeDb(makeFeedRow({ draft: 1 }));
        const { env } = makeEnv();
        await processFeedAITTSTask(
            env,
            db,
            noopCache,
            noopConfig,
            { feedId: 1, expectedUpdatedAtUnix: updatedAtUnix },
            noopClearFeedCache,
        );
        expect(feedRow.ai_tts_status).toBe("idle");
    });
});

describe("syncFeedAITTSQueueState", () => {
    it("fails fast with a clear message when the AI binding is missing", async () => {
        const { db, feedRow } = makeFakeDb(makeFeedRow());
        await syncFeedAITTSQueueState(db, {} as Env, 1, {
            draft: false,
            updatedAt: new Date("2026-09-28T10:00:00.000Z"),
        });
        expect(feedRow.ai_tts_status).toBe("failed");
        expect(feedRow.ai_tts_error).toContain("AI binding");
    });

    it("stays idle for drafts", async () => {
        const { db, feedRow } = makeFakeDb(makeFeedRow());
        const { env } = makeEnv();
        await syncFeedAITTSQueueState(db, env, 1, {
            draft: true,
            updatedAt: new Date("2026-09-28T10:00:00.000Z"),
        });
        expect(feedRow.ai_tts_status).toBe("idle");
    });

    it("marks failed when the task queue is not configured", async () => {
        const { db, feedRow } = makeFakeDb(makeFeedRow());
        // 有 AI binding 但没有 TASK_QUEUE：enqueue 抛错 → failed
        const env = { AI: { run: async () => undefined } } as unknown as Env;
        await syncFeedAITTSQueueState(db, env, 1, {
            draft: false,
            updatedAt: new Date("2026-09-28T10:00:00.000Z"),
        });
        expect(feedRow.ai_tts_status).toBe("failed");
        expect(feedRow.ai_tts_error).toContain("TASK_QUEUE");
    });
});

describe("deleteFeedTTSAsset", () => {
    it("is a no-op without an asset id", async () => {
        const { db, calls } = makeFakeDb(makeFeedRow());
        const { env } = makeEnv();
        await deleteFeedTTSAsset(env, db, 1, null);
        expect(calls).toEqual([]);
    });
});
