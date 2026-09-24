/**
 * Stage 4 · 文本向量（bge-base-en-v1.5，768 维）+ Vectorize 读写。
 *
 * 向量 id 约定（Vectorize metadata 值只能是 string/number/boolean/string[]）：
 *   s{storyId}b{blockId}c{chunkIndex}   内容块切块
 *   s{storyId}h0                        story 头（标题+摘要）
 *   s{storyId}t{assetId}c{chunkIndex}    转录文本切块
 * metadata: { storyId, storySlug, title, blockId|null, kind, text(片段), url }
 */
import { getWorkerAIModelId, runWorkerAIModel } from "../../utils/ai";
import type { DB } from "../../core/hono-types";
import { eq } from "drizzle-orm";
import { storyVectors } from "../../db/schema";
import {
    ASK_TOPK_FULL,
    ASK_TOPK_QUICK,
    EMBED_BATCH_SIZE,
    EMBED_MODEL,
    EMBEDDING_DIMENSIONS,
    RETRIEVAL_SCORE_FLOOR,
    VECTORIZE_UPSERT_BATCH_SIZE,
} from "./models";

export interface VectorChunk {
    id: string;
    storyId: number;
    storySlug: string;
    title: string;
    blockId: number | null;
    kind: "block" | "header" | "transcript";
    text: string;
    url: string;
}

export interface ScoredChunk extends VectorChunk {
    score: number;
}

function parseEmbeddingResponse(response: unknown): number[][] {
    if (!response || typeof response !== "object") {
        throw new Error("Embedding 返回了空响应");
    }
    const r = response as Record<string, any>;
    const data = r.data;
    if (!Array.isArray(data) || data.length === 0 || !Array.isArray(data[0])) {
        throw new Error(`Embedding 返回格式异常: ${JSON.stringify(response).slice(0, 200)}`);
    }
    return data as number[][];
}

/**
 * 批量取文本向量。输入为空返回 []。维度异常时抛错（防 index 维度漂移）。
 *
 * 按 EMBED_BATCH_SIZE 分批调用 AI；options.onBatch 在每次实际 AI 调用后触发
 * 一次，供调用方按真实调用次数记账（ai_usage 每次 AI 调用记一行）。
 */
export interface EmbedTextsOptions {
    onBatch?: (info: { batchIndex: number; batchSize: number }) => void | Promise<void>;
}

export async function embedTexts(
    env: Env,
    texts: string[],
    options: EmbedTextsOptions = {},
): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    let batchIndex = 0;
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const response = await runWorkerAIModel(env, EMBED_MODEL, { text: batch });
        const vectors = parseEmbeddingResponse(response);
        if (vectors.length !== batch.length) {
            throw new Error(`Embedding 条数不匹配: 输入 ${batch.length}，返回 ${vectors.length}`);
        }
        for (const v of vectors) {
            if (v.length !== EMBEDDING_DIMENSIONS) {
                throw new Error(
                    `Embedding 维度异常: 期望 ${EMBEDDING_DIMENSIONS}，实际 ${v.length}`,
                );
            }
        }
        out.push(...vectors);
        await options.onBatch?.({ batchIndex: batchIndex++, batchSize: batch.length });
    }
    return out;
}

export async function embedOne(env: Env, text: string): Promise<number[]> {
    const vectors = await embedTexts(env, [text]);
    if (!vectors[0]) throw new Error("Embedding 返回为空");
    return vectors[0];
}

function getVectorize(env: Env): VectorizeIndex {
    if (!env.VECTORIZE) {
        throw new Error("VECTORIZE binding is not configured（staging 部署需加 vectorize binding）");
    }
    return env.VECTORIZE;
}

/** 向量按 VECTORIZE_UPSERT_BATCH_SIZE 分批删除（deleteByIds） */
export async function deleteChunks(env: Env, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const index = getVectorize(env);
    let done = 0;
    for (let i = 0; i < ids.length; i += VECTORIZE_UPSERT_BATCH_SIZE) {
        await index.deleteByIds(ids.slice(i, i + VECTORIZE_UPSERT_BATCH_SIZE));
        done += Math.min(VECTORIZE_UPSERT_BATCH_SIZE, ids.length - i);
    }
    return done;
}

// ---------------------------------------------------------------------------
// 向量清单 manifest：story_id -> 实际写入的 vector id 列表
// ---------------------------------------------------------------------------

/** 读取某 story 上次 embed 实际写入的 vector id 清单（无记录返回 []） */
export async function getStoryVectorIds(db: DB, storyId: number): Promise<string[]> {
    const row = await db.query.storyVectors.findFirst({
        where: eq(storyVectors.storyId, storyId),
    });
    if (!row) return [];
    try {
        const parsed: unknown = JSON.parse(row.vectorIdsJson);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
        return [];
    }
}

/** 覆盖写入某 story 的向量清单 */
export async function setStoryVectorIds(db: DB, storyId: number, ids: string[]): Promise<void> {
    const now = new Date();
    await db
        .insert(storyVectors)
        .values({ storyId, vectorIdsJson: JSON.stringify(ids), updatedAt: now })
        .onConflictDoUpdate({
            target: storyVectors.storyId,
            set: { vectorIdsJson: JSON.stringify(ids), updatedAt: now },
        });
}

/** 删除某 story 的向量清单记录 */
export async function clearStoryVectorIds(db: DB, storyId: number): Promise<void> {
    await db.delete(storyVectors).where(eq(storyVectors.storyId, storyId));
}

/** 向量 + metadata 批量 upsert（按 VECTORIZE_UPSERT_BATCH_SIZE 分批） */
export async function upsertChunks(
    env: Env,
    items: Array<{ chunk: VectorChunk; vector: number[] }>,
): Promise<number> {
    if (items.length === 0) return 0;
    const index = getVectorize(env);
    let done = 0;
    for (let i = 0; i < items.length; i += VECTORIZE_UPSERT_BATCH_SIZE) {
        const batch = items.slice(i, i + VECTORIZE_UPSERT_BATCH_SIZE);
        await index.upsert(
            batch.map(({ chunk, vector }) => ({
                id: chunk.id,
                values: vector,
                metadata: {
                    storyId: chunk.storyId,
                    storySlug: chunk.storySlug,
                    title: chunk.title,
                    blockId: chunk.blockId ?? -1,
                    kind: chunk.kind,
                    text: chunk.text.slice(0, 1000),
                    url: chunk.url,
                },
            })),
        );
        done += batch.length;
    }
    return done;
}

export interface RetrievalMatch {
    chunk: VectorChunk;
    score: number;
}

/**
 * 向量检索。返回按分数降序的 chunk 列表（已过滤低于 RETRIEVAL_SCORE_FLOOR 的）。
 */
export async function querySimilar(
    env: Env,
    vector: number[],
    topK: number,
): Promise<RetrievalMatch[]> {
    const index = getVectorize(env);
    // 注意：仓库内 @cloudflare/workers-types 较旧，VectorizeIndex.query 把
    // returnMetadata 类型化为 boolean；运行时（workerd/线上）true 即返回全部
    // 已存 metadata，与 "all" 语义一致。
    const res = await index.query(vector, { topK, returnMetadata: true });
    const matches: RetrievalMatch[] = [];
    for (const m of res.matches ?? []) {
        const score = typeof m.score === "number" ? m.score : 0;
        if (score < RETRIEVAL_SCORE_FLOOR) continue;
        const md = (m.metadata ?? {}) as Record<string, any>;
        if (typeof md.storySlug !== "string" || typeof md.text !== "string") continue;
        matches.push({
            score,
            chunk: {
                id: m.id,
                storyId: typeof md.storyId === "number" ? md.storyId : 0,
                storySlug: md.storySlug,
                title: typeof md.title === "string" ? md.title : "",
                blockId: typeof md.blockId === "number" && md.blockId >= 0 ? md.blockId : null,
                kind: md.kind === "header" || md.kind === "transcript" ? md.kind : "block",
                text: md.text,
                url: typeof md.url === "string" ? md.url : "",
            },
        });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches;
}

/** 站内问答用的检索入口（mode 决定 topK） */
export async function retrieveForQuestion(
    env: Env,
    question: string,
    mode: "quick" | "full",
): Promise<{ matches: RetrievalMatch[]; vector: number[] }> {
    const vector = await embedOne(env, question);
    const matches = await querySimilar(env, vector, mode === "full" ? ASK_TOPK_FULL : ASK_TOPK_QUICK);
    return { matches, vector };
}
