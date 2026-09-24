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
import type { AIStudioJobKind } from "./models";
import { aiStudioJobType } from "./models";

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

function parseOutputJson(outputJson: string): Record<string, any> {
    try {
        const parsed = JSON.parse(outputJson);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * accept artifact：按产物 kind 写入正文/转录，设置 accepted_at。
 * 幂等：已 accept 过返回 applied:false。
 */
export async function acceptArtifact(
    db: DB,
    artifactId: number,
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
