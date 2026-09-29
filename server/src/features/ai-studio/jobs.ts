/**
 * Stage 4 · AI Studio job / artifact 数据操作。
 *
 * 约定：
 * - job.status: pending → processing → completed | failed
 * - 所有 AI 输出先存 ai_artifacts.output_json（draft，accepted_at 为空）；
 *   accept 才写入正文/转录（transcribe→transcripts，derive→stories.summary），
 *   reject 丢弃 artifact 行。
 */
import { asc, desc, eq } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import {
    aiArtifacts,
    aiJobs,
    contentBlocks,
    mediaAssets,
    stories,
    transcripts,
} from "../../db/schema";
import {
    deleteMediaAssetById,
    insertMediaAsset,
    updateMediaAssetById,
} from "../media/repository";
import { buildDirectUploadKey } from "../media/r2-direct";
import type { AIStudioJobKind } from "./models";
import {
    MINIMAX_VIDEO_DOWNLOAD_TIMEOUT_MS,
    MINIMAX_VIDEO_MAX_BYTES,
    MINIMAX_VIDEO_MODEL,
    aiStudioJobType,
} from "./models";
import { relayFileUrl, resolveMinimaxRelay } from "./minimax";

export interface JobRow {
    id: number;
    jobType: string;
    status: string;
    createdAt: unknown;
    updatedAt: unknown;
}

export interface ArtifactRow {
    id: number;
    jobId: number;
    outputJson: string;
    acceptedAt: unknown;
    createdAt: unknown;
}

function toJobRow(row: typeof aiJobs.$inferSelect): JobRow {
    return {
        id: row.id,
        jobType: row.jobType,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function toArtifactRow(row: typeof aiArtifacts.$inferSelect): ArtifactRow {
    return {
        id: row.id,
        jobId: row.jobId,
        outputJson: row.outputJson,
        acceptedAt: row.acceptedAt,
        createdAt: row.createdAt,
    };
}

export function serializeJob(row: JobRow) {
    return {
        id: row.id,
        job_type: row.jobType,
        status: row.status,
        created_at:
            row.createdAt instanceof Date
                ? Math.floor(row.createdAt.getTime() / 1000)
                : row.createdAt,
        updated_at:
            row.updatedAt instanceof Date
                ? Math.floor(row.updatedAt.getTime() / 1000)
                : row.updatedAt,
    };
}

function serializeArtifact(row: ArtifactRow) {
    let output: unknown = null;
    try {
        output = JSON.parse(row.outputJson);
    } catch {
        output = row.outputJson;
    }
    return {
        id: row.id,
        output_json: output,
        accepted_at:
            row.acceptedAt instanceof Date
                ? Math.floor(row.acceptedAt.getTime() / 1000)
                : row.acceptedAt,
        created_at:
            row.createdAt instanceof Date
                ? Math.floor(row.createdAt.getTime() / 1000)
                : row.createdAt,
    };
}

export async function createJob(
    db: DB,
    kind: AIStudioJobKind,
    inputRefs: Record<string, unknown>,
    modelRef = "",
): Promise<JobRow> {
    const rows = await db
        .insert(aiJobs)
        .values({
            jobType: aiStudioJobType(kind),
            inputRefsJson: JSON.stringify(inputRefs ?? {}),
            modelRef,
            status: "pending",
        })
        .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create ai_job");
    return toJobRow(row);
}

export async function setJobStatus(
    db: DB,
    jobId: number,
    status: "pending" | "processing" | "completed" | "failed",
): Promise<void> {
    await db.update(aiJobs).set({ status }).where(eq(aiJobs.id, jobId));
}

export async function listJobs(
    db: DB,
    options: { status?: string; page?: number; limit?: number },
): Promise<{ jobs: ReturnType<typeof serializeJob>[]; page: number; hasNext: boolean }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const page = Math.max(options.page ?? 1, 1);
    const offset = (page - 1) * limit;

    const where = options.status ? eq(aiJobs.status, options.status) : undefined;
    const rows = await db.query.aiJobs.findMany({
        where,
        orderBy: desc(aiJobs.id),
        limit: limit + 1,
        offset,
    });
    const hasNext = rows.length > limit;
    return {
        jobs: rows.slice(0, limit).map((r) => serializeJob(toJobRow(r))),
        page,
        hasNext,
    };
}

export async function getJobWithArtifacts(
    db: DB,
    jobId: number,
): Promise<{ job: ReturnType<typeof serializeJob>; artifacts: ReturnType<typeof serializeArtifact>[] } | null> {
    const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
    if (!job) return null;
    const arts = await db.query.aiArtifacts.findMany({
        where: eq(aiArtifacts.jobId, jobId),
        orderBy: desc(aiArtifacts.id),
    });
    return {
        job: serializeJob(toJobRow(job)),
        artifacts: arts.map((a) => serializeArtifact(toArtifactRow(a))),
    };
}

export async function saveArtifact(
    db: DB,
    jobId: number,
    output: unknown,
): Promise<ArtifactRow> {
    const rows = await db
        .insert(aiArtifacts)
        .values({ jobId, outputJson: JSON.stringify(output ?? {}) })
        .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to save ai_artifact");
    return toArtifactRow(row);
}

export async function getArtifact(db: DB, artifactId: number): Promise<ArtifactRow | null> {
    const row = await db.query.aiArtifacts.findFirst({
        where: eq(aiArtifacts.id, artifactId),
    });
    return row ? toArtifactRow(row) : null;
}

export async function getJob(db: DB, jobId: number): Promise<JobRow | null> {
    const row = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
    return row ? toJobRow(row) : null;
}

/** 读取 job.inputRefsJson（video 任务的 relayJobId 等提交态存这里，避免加表）。 */
export async function readJobInputRefs(db: DB, jobId: number): Promise<Record<string, unknown>> {
    const row = await db.query.aiJobs.findFirst({
        columns: { inputRefsJson: true },
        where: eq(aiJobs.id, jobId),
    });
    if (!row) return {};
    try {
        const parsed = JSON.parse(row.inputRefsJson ?? "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/** 合并写入 job.inputRefsJson（幂等提交/状态回填用）。 */
export async function updateJobInputRefs(
    db: DB,
    jobId: number,
    patch: Record<string, unknown>,
): Promise<void> {
    const current = await readJobInputRefs(db, jobId);
    await db
        .update(aiJobs)
        .set({ inputRefsJson: JSON.stringify({ ...current, ...patch }) })
        .where(eq(aiJobs.id, jobId));
}

function parseOutputJson(outputJson: string): Record<string, any> {
    try {
        const parsed = JSON.parse(outputJson);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * accept artifact：按产物 kind 写入正文/转录/媒体库，设置 accepted_at。
 * 幂等：已 accept 过返回 applied:false。
 *
 * video 产物需要 env（从 relay 下载成片 → R2），调用方传入 opts.env。
 */
export async function acceptArtifact(
    db: DB,
    artifactId: number,
    opts?: { env?: Env },
): Promise<{ ok: true; applied: boolean } | { ok: false; error: string }> {
    const artifact = await getArtifact(db, artifactId);
    if (!artifact) return { ok: false, error: "Artifact not found" };
    if (artifact.acceptedAt) return { ok: true, applied: false };

    const output = parseOutputJson(artifact.outputJson);
    const kind = output.kind as string | undefined;
    const now = new Date();

    if (kind === "transcript") {
        // 转写 accept → upsert transcripts（draft 状态，不直接发布）
        const assetId = Number(output.assetId);
        if (!Number.isInteger(assetId)) {
            return { ok: false, error: "Transcript artifact missing assetId" };
        }
        const existing = await db.query.transcripts.findFirst({
            where: eq(transcripts.assetId, assetId),
        });
        const values = {
            language: String(output.language ?? ""),
            text: String(output.text ?? ""),
            segmentsJson: JSON.stringify(output.segments ?? []),
            status: "draft",
            updatedAt: now,
        };
        if (existing) {
            await db.update(transcripts).set(values).where(eq(transcripts.id, existing.id));
        } else {
            await db.insert(transcripts).values({ assetId, ...values, createdAt: now });
        }
    } else if (kind === "derive") {
        // 摘要 accept → 写入 stories.summary（不改 story 状态）
        const storyId = Number(output.storyId);
        const summary = String(output.summary ?? "").trim();
        if (!Number.isInteger(storyId) || !summary) {
            return { ok: false, error: "Derive artifact missing storyId/summary" };
        }
        await db.update(stories).set({ summary }).where(eq(stories.id, storyId));
        // sections / platformCopy 为参考素材，无目标表可写，保留在 artifact 中
    } else if (kind === "error") {
        return { ok: false, error: "Cannot accept an error artifact" };
    } else if (kind === "video") {
        // 视频 accept → 从 minimax-relay 下载成片 → R2 + media_assets 入库
        const relayJobId = typeof output.relayJobId === "string" ? output.relayJobId : "";
        if (!relayJobId) {
            return { ok: false, error: "Video artifact missing relayJobId" };
        }
        const env = opts?.env;
        if (!env) {
            return { ok: false, error: "Video accept 需要运行环境（env）" };
        }
        const relay = resolveMinimaxRelay(env);
        if (!relay.ok) {
            return { ok: false, error: relay.error };
        }
        if (!env.R2_BUCKET) {
            return { ok: false, error: "R2_BUCKET binding 未配置" };
        }
        let resp: Response;
        try {
            resp = await fetch(relayFileUrl(relay.config.url, relayJobId), {
                headers: { Authorization: `Bearer ${relay.config.secret}` },
                signal: AbortSignal.timeout(MINIMAX_VIDEO_DOWNLOAD_TIMEOUT_MS),
            });
        } catch (error) {
            return {
                ok: false,
                error: `从中转服务下载成片失败：${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (resp.status === 404) {
            return { ok: false, error: "中转侧成片不存在或已过期，请重新生成" };
        }
        if (!resp.ok) {
            return { ok: false, error: `下载成片失败：HTTP ${resp.status}` };
        }
        // 大文件流式直写 R2，不经过 Worker 内存缓冲（Worker 内存上限 128MB，
        // 而成片上限 500MB）。relay 的 /file 会带 Content-Length，先做前置校验。
        const contentLengthHeader = resp.headers.get("content-length");
        const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
        if (Number.isFinite(contentLength)) {
            if (contentLength <= 0) {
                return { ok: false, error: "成片内容为空" };
            }
            if (contentLength > MINIMAX_VIDEO_MAX_BYTES) {
                return { ok: false, error: "成片超过体积上限，拒绝入库" };
            }
        }
        if (!resp.body) {
            return { ok: false, error: "成片内容为空" };
        }
        const mime =
            resp.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
        const prompt = String(output.prompt ?? "").trim();
        const nowVideo = new Date();
        const inserted = await insertMediaAsset(db, {
            kind: "video",
            source: "r2",
            mime,
            title: prompt.slice(0, 200) || `MiniMax H3 ${relayJobId}`,
            duration: typeof output.duration === "number" ? output.duration : null,
            uploadSessionJson: JSON.stringify({
                minimaxRelayJobId: relayJobId,
                model: MINIMAX_VIDEO_MODEL,
            }),
            createdAt: nowVideo,
            updatedAt: nowVideo,
        });
        if (!inserted) {
            return { ok: false, error: "Failed to insert media asset" };
        }
        const assetId = inserted.insertedId;
        const key = buildDirectUploadKey(assetId, `minimax-h3-${relayJobId}.mp4`);
        try {
            // ReadableStream 直写 R2：Worker 只做管道，不缓冲整文件
            await env.R2_BUCKET.put(key, resp.body, {
                httpMetadata: { contentType: mime },
            });
        } catch (error) {
            // R2 写入失败：删孤儿行与残留对象，不留残留
            await env.R2_BUCKET.delete(key).catch(() => undefined);
            await deleteMediaAssetById(db, assetId);
            console.error("[ai-studio] video accept: R2 写入失败:", error);
            return { ok: false, error: "成片写入 R2 失败" };
        }
        if (!Number.isFinite(contentLength)) {
            // 无 Content-Length 时兜底：按 R2 实际落盘体积复核上限
            const head = await env.R2_BUCKET.head(key).catch(() => null);
            if (!head || head.size > MINIMAX_VIDEO_MAX_BYTES) {
                await env.R2_BUCKET.delete(key).catch(() => undefined);
                await deleteMediaAssetById(db, assetId);
                return { ok: false, error: "成片超过体积上限，拒绝入库" };
            }
        }
        await updateMediaAssetById(db, assetId, { r2Key: key, updatedAt: new Date() });
        // 回填 assetId，前端可直接用媒体库播放器预览
        output.assetId = assetId;
        await db
            .update(aiArtifacts)
            .set({ outputJson: JSON.stringify(output) })
            .where(eq(aiArtifacts.id, artifactId));
    } else if (kind !== "check" && kind !== "retrieval-test" && kind !== "embed") {
        return { ok: false, error: `Artifact kind '${kind ?? "unknown"}' cannot be accepted` };
    }
    // kind: check / retrieval-test / embed：产物本身即最终形态，无正文写入

    await db
        .update(aiArtifacts)
        .set({ acceptedAt: now })
        .where(eq(aiArtifacts.id, artifactId));
    return { ok: true, applied: true };
}

/** reject：丢弃 artifact 行（job 保留作历史）。幂等。 */
export async function rejectArtifact(
    db: DB,
    artifactId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const artifact = await getArtifact(db, artifactId);
    if (!artifact) return { ok: true }; // 已丢弃也算成功（幂等）
    await db.delete(aiArtifacts).where(eq(aiArtifacts.id, artifactId));
    return { ok: true };
}

// ---------------------------------------------------------------------------
// processor 需要的读取 helpers
// ---------------------------------------------------------------------------

export interface StoryContent {
    id: number;
    slug: string;
    title: string | null;
    summary: string;
    status: string;
    verifiedAt: unknown;
    blocks: Array<{ id: number; type: string; position: number; payloadJson: string }>;
}

/** 按 slug 查 story id（/api/ask/recommend 同时接受 storyId 与 slug）。 */
export async function findStoryIdBySlug(db: DB, slug: string): Promise<number | null> {
    const row = await db.query.stories.findFirst({
        columns: { id: true },
        where: eq(stories.slug, slug),
    });
    return row?.id ?? null;
}

export async function loadStoryContent(db: DB, storyId: number): Promise<StoryContent | null> {
    const story = await db.query.stories.findFirst({ where: eq(stories.id, storyId) });
    if (!story) return null;
    const blocks = await db.query.contentBlocks.findMany({
        where: eq(contentBlocks.storyId, storyId),
        orderBy: asc(contentBlocks.position),
    });
    const sorted = [...blocks];
    return {
        id: story.id,
        slug: story.slug,
        title: story.title,
        summary: story.summary,
        status: story.status,
        verifiedAt: story.verifiedAt,
        blocks: sorted.map((b) => ({
            id: b.id,
            type: b.type,
            position: b.position,
            payloadJson: b.payloadJson,
        })),
    };
}

export interface AudioAsset {
    id: number;
    kind: string;
    r2Key: string | null;
    mime: string;
    duration: number | null;
}

export async function loadAudioAsset(db: DB, assetId: number): Promise<AudioAsset | null> {
    const row = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, assetId) });
    if (!row) return null;
    return {
        id: row.id,
        kind: row.kind,
        r2Key: row.r2Key,
        mime: row.mime,
        duration: row.duration,
    };
}
