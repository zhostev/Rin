import { describe, it, expect } from "bun:test";
import { aiSettings } from "../../../db/schema";
import { buildStoryChunks, parseJsonArray, parseJsonObject, processAIStudioTask, resolveDeriveMaxTokens } from "../processors";

const story = { id: 7, slug: "hello", title: "标题", summary: "摘要" };

describe("buildStoryChunks", () => {
    it("builds deterministic chunk ids for header and blocks", () => {
        const chunks = buildStoryChunks(
            {
                story,
                blocks: [
                    { id: 11, payloadJson: JSON.stringify({ markdown: "正文一" }) },
                    { id: 12, payloadJson: JSON.stringify({ markdown: "正文二" }) },
                ],
                transcripts: [],
            },
            "/story/hello",
        );
        const ids = chunks.map((c) => c.id);
        expect(ids).toContain("s7h0");
        expect(ids).toContain("s7b11c0");
        expect(ids).toContain("s7b12c0");
        // 两次构造结果一致（删除路径与索引路径共用）
        const again = buildStoryChunks(
            {
                story,
                blocks: [
                    { id: 11, payloadJson: JSON.stringify({ markdown: "正文一" }) },
                    { id: 12, payloadJson: JSON.stringify({ markdown: "正文二" }) },
                ],
                transcripts: [],
            },
            "/story/hello",
        );
        expect(again.map((c) => c.id)).toEqual(ids);
    });

    it("includes transcript chunks keyed by asset id", () => {
        const chunks = buildStoryChunks(
            {
                story,
                blocks: [{ id: 11, payloadJson: JSON.stringify({ assetId: 42 }) }],
                transcripts: [{ assetId: 42, text: "转写文本内容" }],
            },
            "/story/hello",
        );
        const ids = chunks.map((c) => c.id);
        expect(ids).toContain("s7t42c0");
        expect(chunks.find((c) => c.id === "s7t42c0")!.kind).toBe("transcript");
    });

    it("ignores transcripts not referenced by blocks", () => {
        const chunks = buildStoryChunks(
            {
                story,
                blocks: [{ id: 11, payloadJson: JSON.stringify({ markdown: "正文" }) }],
                transcripts: [{ assetId: 99, text: "无人引用的转写" }],
            },
            "/story/hello",
        );
        expect(chunks.some((c) => c.kind === "transcript")).toBe(false);
    });
});

describe("parseJsonObject", () => {
    it("parses plain JSON", () => {
        expect(parseJsonObject('{"summary": "好"}')).toEqual({ summary: "好" });
    });

    it("strips markdown fences", () => {
        expect(parseJsonObject('```json\n{"summary": "好"}\n```')).toEqual({ summary: "好" });
    });

    it("extracts JSON wrapped in preamble/postamble text", () => {
        const text = "好的，这是你要的摘要：\n{\"summary\": \"模型输出带了前言\"}\n希望对你有帮助。";
        expect(parseJsonObject(text)).toEqual({ summary: "模型输出带了前言" });
    });

    it("returns null for non-JSON", () => {
        expect(parseJsonObject("今天天气不错")).toBeNull();
    });
});

describe("parseJsonArray", () => {
    it("extracts array wrapped in text", () => {
        const text = "发现以下问题：\n[{\"detail\": \"过期\"}]\n以上。";
        expect(parseJsonArray(text)).toEqual([{ detail: "过期" }]);
    });

    it("returns null for non-array JSON", () => {
        expect(parseJsonArray('{"a": 1}')).toBeNull();
    });
});

describe("resolveDeriveMaxTokens", () => {
    it("reserves thinking headroom so reasoning models do not truncate the JSON", () => {
        // 与 feed-ai-revise / ai-images 一致：推理模型的思考过程计入 max_tokens，
        // 没有预留会导致 derive 的 JSON 被截断 → "AI 返回的 JSON 无法解析或缺少 summary"。
        expect(resolveDeriveMaxTokens()).toBeGreaterThan(4000);
    });
});

describe("processAIStudioTask", () => {
    function fakeDispatcherDb(assetKind: string | null) {
        let status = "pending";
        const seenStatuses: string[] = [];
        const settingsRows = [
            { key: "ai_enabled", value: "1" },
            { key: "daily_call_quota", value: "200" },
        ];
        const db: any = {
            seenStatuses,
            query: {
                aiJobs: {
                    findFirst: async () => ({
                        id: 1,
                        jobType: "aistudio.transcribe",
                        status,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    }),
                },
                mediaAssets: {
                    findFirst: async () =>
                        assetKind === null
                            ? null
                            : {
                                  id: 70,
                                  kind: assetKind,
                                  r2Key: "media/k",
                                  mime: "image/png",
                                  duration: null,
                              },
                },
            },
            select: () => ({
                from: (table: unknown) => {
                    if (table === aiSettings) return Promise.resolve(settingsRows);
                    return { where: async () => [{ n: 0 }] };
                },
            }),
            insert: () => ({
                values: () => ({
                    returning: async () => [
                        { id: 1, jobId: 1, outputJson: "{}", acceptedAt: null, createdAt: new Date() },
                    ],
                }),
            }),
            update: () => ({
                set: (values: any) => {
                    status = values.status;
                    seenStatuses.push(values.status);
                    return { where: async () => undefined };
                },
            }),
        };
        return db;
    }

    it("keeps failed status when a processor validation fails (no completed overwrite)", async () => {
        const db = fakeDispatcherDb("image");
        await processAIStudioTask({} as any, db, {
            type: "aistudio.transcribe",
            payload: { jobId: 1, assetId: 70 } as any,
        });
        // processing → failed；修复前分发器会无条件再写 completed，把 failed 覆盖掉
        expect(db.seenStatuses).toEqual(["processing", "failed"]);
    });
});
