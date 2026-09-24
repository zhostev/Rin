/**
 * Stage 4 · AI Studio 队列任务处理（queue consumer 调用）。
 *
 * 任务类型 aistudio.*（定义见 server/src/queue/tasks.ts），处理流程：
 * pending → processing → completed | failed；失败时存 {kind:'error'} artifact
 * 说明原因，job 状态置 failed。
 */
import { inArray, asc, eq } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import { contentBlocks, mediaAssets, stories, transcripts } from "../../db/schema";
import {
    AISTUDIO_CHECK_TASK,
    AISTUDIO_DERIVE_TASK,
    AISTUDIO_EMBED_TASK,
    AISTUDIO_RETRIEVAL_TEST_TASK,
    AISTUDIO_TRANSCRIBE_TASK,
    type AIStudioTaskPayload,
} from "../../queue/tasks";
import {
    extractAIText,
    extractAIUsage,
    getWorkerAIModelId,
    runWorkerAIModel,
    stripReasoningTags,
} from "../../utils/ai";
import { chunkText, extractAssetIds, extractBlockText, extractUrls } from "./chunk";
import { deleteChunks, embedOne, embedTexts, querySimilar, upsertChunks, type VectorChunk } from "./embed";
import { checkAIGuard, recordUsage } from "./guard";
import {
    loadAudioAsset,
    loadStoryContent,
    saveArtifact,
    setJobStatus,
    getJob,
} from "./jobs";
import {
    ASK_SYSTEM_PROMPT,
    CHECK_STALE_FACT_SYSTEM_PROMPT,
    CHAT_MODEL,
    DERIVE_SYSTEM_PROMPT,
    EMBED_MODEL,
    EMBEDDING_DIMENSIONS,
    QA_VECTORIZE_INDEX,
    TRANSCRIBE_DEFAULT_MAX_MINUTES,
    WHISPER_MODEL,
    type AIStudioJobKind,
} from "./models";
import { transcribeAudio } from "./whisper";

const CHAT_MAX_TOKENS = 1500;

function storyUrl(env: Env, slug: string): string {
    const base = (env.FRONTEND_URL || "").replace(/\/+$/, "");
    return base ? `${base}/story/${slug}` : `/story/${slug}`;
}

async function failJob(db: DB, jobId: number, message: string, rawPreview?: string): Promise<void> {
    const output: Record<string, any> = { kind: "error", message };
    if (typeof rawPreview === "string" && rawPreview.length > 0) {
        output.rawPreview = rawPreview.slice(0, 500);
    }
    await saveArtifact(db, jobId, output);
    await setJobStatus(db, jobId, "failed");
}

function extractJsonCandidate(text: string): string {
    const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    // 模型可能在 JSON 前后加解释文字：截取第一个 { 到最后一个 } 之间的部分
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return cleaned.slice(start, end + 1);
    }
    return cleaned;
}

export function parseJsonObject(text: string): Record<string, any> | null {
    const cleaned = extractJsonCandidate(text);
    try {
        const parsed = JSON.parse(cleaned);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function extractJsonArrayCandidate(text: string): string {
    const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start >= 0 && end > start) {
        return cleaned.slice(start, end + 1);
    }
    return cleaned;
}

export function parseJsonArray(text: string): Array<Record<string, any>> | null {
    const cleaned = extractJsonArrayCandidate(text);
    try {
        const parsed = JSON.parse(cleaned);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// transcribe：R2 音频 → whisper → 分段/时间码 → draft artifact
// ---------------------------------------------------------------------------

async function processTranscribe(env: Env, db: DB, payload: AIStudioTaskPayload): Promise<void> {
    const { jobId, assetId } = payload;
    if (!Number.isInteger(assetId)) {
        await failJob(db, jobId, "transcribe 需要 input.assetId");
        return;
    }

    const asset = await loadAudioAsset(db, assetId as number);
    if (!asset) {
        await failJob(db, jobId, `找不到 media asset ${assetId}`);
        return;
    }
    if (asset.kind !== "audio") {
        await failJob(db, jobId, `asset ${assetId} 不是音频（kind=${asset.kind}），转写仅支持音频`);
        return;
    }
    if (!asset.r2Key || !env.R2_BUCKET) {
        await failJob(
            db,
            jobId,
            !asset.r2Key ? `asset ${assetId} 没有 r2_key` : "R2_BUCKET binding 未配置",
        );
        return;
    }

    const obj = await env.R2_BUCKET.get(asset.r2Key);
    if (!obj) {
        await failJob(db, jobId, `R2 中找不到对象 ${asset.r2Key}`);
        return;
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.length === 0) {
        await failJob(db, jobId, `R2 对象 ${asset.r2Key} 为空`);
        return;
    }

    const rawMax = payload.params?.maxMinutes;
    const maxMinutes =
        typeof rawMax === "number" && rawMax > 0
            ? Math.min(rawMax, 60)
            : TRANSCRIBE_DEFAULT_MAX_MINUTES;

    const result = await transcribeAudio(env, bytes, {
        durationSec: asset.duration,
        maxMinutes,
    });
    await recordUsage(db, { jobId, model: getWorkerAIModelId(WHISPER_MODEL) });

    if (!result.text) {
        await failJob(db, jobId, "Whisper 返回了空转写文本（可能是静音或无法识别的音频）");
        return;
    }

    await saveArtifact(db, jobId, {
        kind: "transcript",
        assetId: asset.id,
        language: result.language,
        text: result.text,
        segments: result.segments,
        words: result.words,
        truncated: result.truncated,
        model: result.model,
    });
}

// ---------------------------------------------------------------------------
// derive：摘要 / 章节 / 平台文案
// ---------------------------------------------------------------------------

async function processDerive(env: Env, db: DB, payload: AIStudioTaskPayload): Promise<void> {
    const { jobId, storyId } = payload;
    if (!Number.isInteger(storyId)) {
        await failJob(db, jobId, "derive 需要 input.storyId");
        return;
    }

    const story = await loadStoryContent(db, storyId as number);
    if (!story) {
        await failJob(db, jobId, `找不到 story ${storyId}`);
        return;
    }

    const bodyText = story.blocks.map((b) => extractBlockText(b.payloadJson)).join("\n\n");
    const content = `标题：${story.title ?? ""}\n\n${bodyText}`.slice(0, 6000);
    if (!content.trim()) {
        await failJob(db, jobId, `story ${storyId} 没有可用的正文内容`);
        return;
    }

    const raw = await runWorkerAIModel(env, CHAT_MODEL, {
        messages: [
            { role: "system", content: DERIVE_SYSTEM_PROMPT },
            { role: "user", content },
        ],
        max_tokens: CHAT_MAX_TOKENS,
        temperature: 0.3,
    });
    const usage = extractAIUsage(raw);
    await recordUsage(db, {
        jobId,
        model: getWorkerAIModelId(CHAT_MODEL),
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
    });

    const text = stripReasoningTags(extractAIText(raw) ?? "");
    const parsed = parseJsonObject(text);
    if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) {
        await failJob(db, jobId, "AI 返回的 JSON 无法解析或缺少 summary", text);
        return;
    }

    await saveArtifact(db, jobId, {
        kind: "derive",
        storyId: story.id,
        summary: parsed.summary.trim(),
        sections: Array.isArray(parsed.sections) ? parsed.sections : [],
        platformCopy:
            parsed.platformCopy && typeof parsed.platformCopy === "object" ? parsed.platformCopy : {},
        model: getWorkerAIModelId(CHAT_MODEL),
    });
}

// ---------------------------------------------------------------------------
// check：断链 / 缺失 alt / 过期事实 / 元数据
// ---------------------------------------------------------------------------

export interface CheckIssue {
    type: "broken_link" | "missing_alt" | "stale_fact" | "metadata";
    detail: string;
    location: string;
}

async function checkLinks(urls: string[]): Promise<CheckIssue[]> {
    const issues: CheckIssue[] = [];
    const targets = [...new Set(urls)].slice(0, 30);
    const CONCURRENCY = 6;

    const checkOne = async (url: string): Promise<CheckIssue | null> => {
        // 只检查 http(s)
        if (!/^https?:\/\//i.test(url)) return null;
        try {
            let res: Response | null = null;
            try {
                res = await fetch(url, {
                    method: "HEAD",
                    redirect: "follow",
                    signal: AbortSignal.timeout(8000),
                });
            } catch {
                // 部分站点拒绝 HEAD，回退 GET（只读 headers）
                res = await fetch(url, {
                    method: "GET",
                    redirect: "follow",
                    signal: AbortSignal.timeout(8000),
                });
            }
            if (res && (res.status < 200 || res.status >= 400)) {
                return { type: "broken_link", detail: `${url} 返回 HTTP ${res.status}`, location: "正文链接" };
            }
            return null;
        } catch (error) {
            return {
                type: "broken_link",
                detail: `${url} 请求失败：${error instanceof Error ? error.message : String(error)}`,
                location: "正文链接",
            };
        }
    };

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = await Promise.all(targets.slice(i, i + CONCURRENCY).map(checkOne));
        for (const issue of batch) {
            if (issue) issues.push(issue);
        }
    }
    return issues;
}

async function processCheck(env: Env, db: DB, payload: AIStudioTaskPayload): Promise<void> {
    const { jobId, storyId } = payload;
    if (!Number.isInteger(storyId)) {
        await failJob(db, jobId, "check 需要 input.storyId");
        return;
    }

    const story = await loadStoryContent(db, storyId as number);
    if (!story) {
        await failJob(db, jobId, `找不到 story ${storyId}`);
        return;
    }

    const issues: CheckIssue[] = [];

    // 1. 元数据
    if (!story.title?.trim()) {
        issues.push({ type: "metadata", detail: "缺少标题", location: "story" });
    }
    if (!story.summary?.trim()) {
        issues.push({ type: "metadata", detail: "缺少摘要（summary 为空）", location: "story" });
    }

    // 2. 缺失 alt：收集块引用的 asset id，一次查出
    const assetIds = new Set<number>();
    const blockAssetMap = new Map<number, number[]>(); // blockId -> assetIds
    for (const block of story.blocks) {
        const ids = extractAssetIds(block.payloadJson);
        if (ids.length > 0) {
            blockAssetMap.set(block.id, ids);
            for (const id of ids) assetIds.add(id);
        }
    }
    if (assetIds.size > 0) {
        const rows = await db.query.mediaAssets.findMany({
            where: inArray(mediaAssets.id, [...assetIds]),
        });
        const altById = new Map(rows.map((r) => [r.id, (r.altText ?? "").trim()]));
        for (const [blockId, ids] of blockAssetMap) {
            for (const id of ids) {
                if (!altById.get(id)) {
                    issues.push({
                        type: "missing_alt",
                        detail: `asset ${id} 缺少 alt 文本`,
                        location: `block ${blockId}`,
                    });
                }
            }
        }
    }

    // 3. 断链
    const allText = story.blocks.map((b) => extractBlockText(b.payloadJson)).join("\n");
    const urls = extractUrls(allText);
    issues.push(...(await checkLinks(urls)));

    // 4. 过期事实（LLM 启发式）
    const content = `标题：${story.title ?? ""}\n\n${allText}`.slice(0, 6000);
    if (content.trim()) {
        try {
            const raw = await runWorkerAIModel(env, CHAT_MODEL, {
                messages: [
                    { role: "system", content: CHECK_STALE_FACT_SYSTEM_PROMPT },
                    { role: "user", content },
                ],
                max_tokens: 800,
                temperature: 0.2,
            });
            const usage = extractAIUsage(raw);
            await recordUsage(db, {
                jobId,
                model: getWorkerAIModelId(CHAT_MODEL),
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
            });
            const parsed = parseJsonArray(stripReasoningTags(extractAIText(raw) ?? ""));
            if (parsed) {
                for (const item of parsed) {
                    if (typeof item.detail === "string" && item.detail.trim()) {
                        issues.push({
                            type: "stale_fact",
                            detail: item.detail.trim(),
                            location: typeof item.location === "string" ? item.location.slice(0, 120) : "正文",
                        });
                    }
                }
            }
        } catch (error) {
            console.error("[ai-studio] check stale_fact LLM 调用失败（已跳过）:", error);
        }
    }

    await saveArtifact(db, jobId, {
        kind: "check",
        storyId: story.id,
        checkedAt: Math.floor(Date.now() / 1000),
        issues,
    });
}

// ---------------------------------------------------------------------------
// retrieval-test：给定问题，返回命中的 chunk 列表（人工评估检索质量）
// ---------------------------------------------------------------------------

async function processRetrievalTest(env: Env, db: DB, payload: AIStudioTaskPayload): Promise<void> {
    const { jobId, question } = payload;
    if (typeof question !== "string" || !question.trim()) {
        await failJob(db, jobId, "retrieval-test 需要 input.question");
        return;
    }

    const vector = await embedOne(env, question.trim());
    await recordUsage(db, { jobId, model: getWorkerAIModelId(EMBED_MODEL) });

    const matches = await querySimilar(env, vector, 8);
    await saveArtifact(db, jobId, {
        kind: "retrieval-test",
        question: question.trim(),
        chunks: matches.map((m) => ({
            id: m.chunk.id,
            storyId: m.chunk.storyId,
            storySlug: m.chunk.storySlug,
            title: m.chunk.title,
            blockId: m.chunk.blockId,
            text: m.chunk.text.slice(0, 500),
            score: Math.round(m.score * 10000) / 10000,
            url: m.chunk.url,
        })),
    });
}

// ---------------------------------------------------------------------------
// embed：全站 stories / blocks / transcripts 切块 → embedding → Vectorize upsert
// ---------------------------------------------------------------------------

const VISIBLE_STORY_STATUSES = ["published", "updated"];

/** 构造某 story 的全部索引块（与 embed 任务共用同一确定性 ID 规则）。 */
export interface StoryChunkSource {
    story: { id: number; slug: string; title: string | null; summary: string | null };
    blocks: Array<{ id: number; payloadJson: string | null }>;
    transcripts: Array<{ assetId: number; text: string | null }>;
}

export function buildStoryChunks(src: StoryChunkSource, url: string): VectorChunk[] {
    const { story } = src;
    const chunks: VectorChunk[] = [];
    // story 头：标题 + 摘要
    const headerText = `${story.title ?? ""}\n${story.summary ?? ""}`.trim();
    for (const c of chunkText(headerText)) {
        chunks.push({
            id: `s${story.id}h${c.chunkIndex}`,
            storyId: story.id,
            storySlug: story.slug,
            title: story.title ?? "",
            blockId: null,
            kind: "header",
            text: c.text,
            url,
        });
    }

    const assetIds = new Set<number>();
    for (const block of src.blocks) {
        for (const c of chunkText(extractBlockText(block.payloadJson))) {
            chunks.push({
                id: `s${story.id}b${block.id}c${c.chunkIndex}`,
                storyId: story.id,
                storySlug: story.slug,
                title: story.title ?? "",
                blockId: block.id,
                kind: "block",
                text: c.text,
                url,
            });
        }
        for (const aid of extractAssetIds(block.payloadJson)) assetIds.add(aid);
    }

    // 转录文本：按块引用的 asset 归属到 story
    for (const tr of src.transcripts) {
        if (!assetIds.has(tr.assetId)) continue;
        if (!tr.text?.trim()) continue;
        for (const c of chunkText(tr.text)) {
            chunks.push({
                id: `s${story.id}t${tr.assetId}c${c.chunkIndex}`,
                storyId: story.id,
                storySlug: story.slug,
                title: story.title ?? "",
                blockId: null,
                kind: "transcript",
                text: c.text,
                url,
            });
        }
    }
    return chunks;
}

async function processEmbed(env: Env, db: DB, payload: AIStudioTaskPayload): Promise<void> {
    const { jobId } = payload;
    const onlyIds = Array.isArray(payload.params?.storyIds)
        ? (payload.params!.storyIds as unknown[]).filter((v): v is number => Number.isInteger(v))
        : null;

    const storyRows = await db.query.stories.findMany({
        where: onlyIds ? inArray(stories.id, onlyIds) : inArray(stories.status, VISIBLE_STORY_STATUSES),
    });
    if (storyRows.length === 0) {
        await failJob(db, jobId, "没有可索引的 story（仅索引 published/updated 状态）");
        return;
    }

    const chunks: VectorChunk[] = [];
    for (const story of storyRows) {
        const url = storyUrl(env, story.slug);
        const blocks = await db.query.contentBlocks.findMany({
            where: eq(contentBlocks.storyId, story.id),
            orderBy: asc(contentBlocks.position),
        });
        const assetIds = new Set<number>();
        for (const block of blocks) {
            for (const aid of extractAssetIds(block.payloadJson)) assetIds.add(aid);
        }
        const trs = assetIds.size > 0
            ? await db.query.transcripts.findMany({
                where: inArray(transcripts.assetId, [...assetIds]),
            })
            : [];
        chunks.push(...buildStoryChunks({ story, blocks, transcripts: trs }, url));
    }

    if (chunks.length === 0) {
        await failJob(db, jobId, "切块结果为空，无可索引文本");
        return;
    }

    const model = getWorkerAIModelId(EMBED_MODEL);
    // 每次实际 AI 调用记一行用量（embedTexts 按 EMBED_BATCH_SIZE 分批调用）
    const vectors = await embedTexts(env, chunks.map((c) => c.text), {
        onBatch: ({ batchSize }) => recordUsage(db, { jobId, model, tokensIn: batchSize }),
    });

    // 先删后写：避免同 ID 向量残留旧 metadata（SQLite 删除后 ID 可能被复用）
    await deleteChunks(env, chunks.map((c) => c.id));

    const upserted = await upsertChunks(
        env,
        chunks.map((chunk, i) => ({ chunk, vector: vectors[i]! })),
    );

    await saveArtifact(db, jobId, {
        kind: "embed",
        chunks: chunks.length,
        vectors: upserted,
        model: getWorkerAIModelId(EMBED_MODEL),
        dimensions: EMBEDDING_DIMENSIONS,
        index: QA_VECTORIZE_INDEX,
    });
}

// ---------------------------------------------------------------------------
// 入口：queue consumer 调用
// ---------------------------------------------------------------------------

export async function processAIStudioTask(
    env: Env,
    db: DB,
    task: { type: string; payload: AIStudioTaskPayload },
): Promise<void> {
    const { jobId } = task.payload;
    const job = Number.isInteger(jobId) ? await getJob(db, jobId as number) : null;
    if (!job) return;

    const guard = await checkAIGuard(db);
    if (!guard.ok) {
        await failJob(db, job.id, guard.code === "ai_disabled" ? "AI 功能已关闭（ai_enabled=0）" : "今日 AI 调用配额已用完");
        return;
    }

    await setJobStatus(db, job.id, "processing");
    try {
        switch (task.type) {
            case AISTUDIO_TRANSCRIBE_TASK:
                await processTranscribe(env, db, task.payload);
                break;
            case AISTUDIO_DERIVE_TASK:
                await processDerive(env, db, task.payload);
                break;
            case AISTUDIO_CHECK_TASK:
                await processCheck(env, db, task.payload);
                break;
            case AISTUDIO_RETRIEVAL_TEST_TASK:
                await processRetrievalTest(env, db, task.payload);
                break;
            case AISTUDIO_EMBED_TASK:
                await processEmbed(env, db, task.payload);
                break;
            default:
                await failJob(db, job.id, `未知任务类型 ${task.type}`);
                return;
        }
        await setJobStatus(db, job.id, "completed");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ai-studio] job ${job.id} failed:`, error);
        await failJob(db, job.id, message);
    }
}

/** 生成一段文本的 AI 摘要（/api/ask 内部引用时复用 feed 既有能力，不在此实现） */
export async function summarizeWithChat(
    env: Env,
    db: DB,
    jobId: number | null,
    systemPrompt: string,
    userContent: string,
    maxTokens = CHAT_MAX_TOKENS,
): Promise<{ text: string; model: string }> {
    const raw = await runWorkerAIModel(env, CHAT_MODEL, {
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
    });
    const usage = extractAIUsage(raw);
    await recordUsage(db, {
        jobId,
        model: getWorkerAIModelId(CHAT_MODEL),
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
    });
    return { text: stripReasoningTags(extractAIText(raw) ?? ""), model: getWorkerAIModelId(CHAT_MODEL) };
}

/** 站内问答的 LLM 回答（ask.ts 调用） */
export async function answerWithCitations(
    env: Env,
    db: DB,
    question: string,
    context: string,
): Promise<{ text: string; model: string }> {
    return summarizeWithChat(
        env,
        db,
        null,
        ASK_SYSTEM_PROMPT,
        `问题：${question}\n\n站内内容片段：\n${context}`,
        800,
    );
}

export type { AIStudioJobKind };
