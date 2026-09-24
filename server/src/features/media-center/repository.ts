/**
 * Stage 3 · 媒体中心数据访问。
 *
 * 资产 ↔ story 的归属关系不在 media_assets 上冗余存 story_id：
 * 资产是通过内容块 payload（payload.asset_id / payload.asset.id / 数组项 id）
 * 嵌入 story 的，这里在查询时从 content_blocks 反查归属。
 * 好处：新建 story 嵌入资产后无需额外写回，媒体页自动出现；
 * 坏处：每次列表查询多一次 content_blocks 扫描——个人站点量级可接受。
 */
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import {
    contentBlocks,
    mediaAssets,
    mediaEvents,
    series,
    stories,
    storySeries,
    transcripts,
} from "../../db/schema";
import type { MediaAssetRow } from "../media/repository";

export const MEDIA_BLOCK_TYPES = ["image", "gallery", "video", "audio"] as const;

/** status=published 的 story 算“已发布”；updated 是发布后的旧文维护，同样公开可见。 */
export const VISIBLE_STORY_STATUSES = ["published", "updated"] as const;

export interface AssetStoryInfo {
    storyId: number;
    storySlug: string;
    storyTitle: string | null;
    storyStatus: string;
    publishedAt: Date | null;
    storyUpdatedAt: Date;
}

function extractAssetIds(payload: unknown): number[] {
    const ids: number[] = [];
    if (typeof payload !== "object" || payload === null) {
        return ids;
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.asset_id === "number" && Number.isInteger(record.asset_id)) {
        ids.push(record.asset_id);
    }
    const asset = record.asset;
    if (typeof asset === "object" && asset !== null) {
        const id = (asset as Record<string, unknown>).id;
        if (typeof id === "number" && Number.isInteger(id)) {
            ids.push(id);
        }
    }
    // 防御：图集类 payload 可能用 images/items 数组挂多个资产
    for (const key of ["images", "items"]) {
        const list = record[key];
        if (Array.isArray(list)) {
            for (const entry of list) {
                if (typeof entry === "object" && entry !== null) {
                    const id = (entry as Record<string, unknown>).id;
                    if (typeof id === "number" && Number.isInteger(id)) {
                        ids.push(id);
                    }
                }
            }
        }
    }
    return ids;
}

/**
 * 构建 assetId → 归属 story 的映射。
 * 一个资产可能被多个 story 引用：按 story.updatedAt 倒序，取最近更新的那个
 * 作为主归属（决定 year / updated 等过滤语义），保证结果确定。
 *
 * statuses 不传 = 不限制 story 状态（管理端/后台场景用）。
 */
export async function buildAssetStoryMap(
    db: DB,
    statuses?: readonly string[],
): Promise<Map<number, AssetStoryInfo>> {
    const whereClause = statuses
        ? and(inArray(stories.status, [...statuses]), inArray(contentBlocks.type, [...MEDIA_BLOCK_TYPES]))
        : inArray(contentBlocks.type, [...MEDIA_BLOCK_TYPES]);

    const rows = await db
        .select({
            storyId: stories.id,
            storySlug: stories.slug,
            storyTitle: stories.title,
            storyStatus: stories.status,
            publishedAt: stories.publishedAt,
            storyUpdatedAt: stories.updatedAt,
            payloadJson: contentBlocks.payloadJson,
        })
        .from(contentBlocks)
        .innerJoin(stories, eq(contentBlocks.storyId, stories.id))
        .where(whereClause)
        .orderBy(desc(stories.updatedAt));

    const map = new Map<number, AssetStoryInfo>();
    for (const row of rows) {
        let payload: unknown = null;
        try {
            payload = JSON.parse(row.payloadJson);
        } catch {
            continue; // 脏 payload 跳过，不影响其它资产
        }
        const info: AssetStoryInfo = {
            storyId: row.storyId,
            storySlug: row.storySlug,
            storyTitle: row.storyTitle,
            storyStatus: row.storyStatus,
            publishedAt: row.publishedAt,
            storyUpdatedAt: row.storyUpdatedAt,
        };
        for (const assetId of extractAssetIds(payload)) {
            if (!map.has(assetId)) {
                map.set(assetId, info);
            }
        }
    }
    return map;
}

export interface ListPublishedAssetsFilter {
    ids: number[];
    kinds?: string[];
    minDuration?: number;
    maxDuration?: number;
}

/** 按 id 集合 + kind/duration 过滤取资产行；ids 为空时直接返回空数组（避免 inArray 空集）。 */
export async function findPublishedAssets(db: DB, filter: ListPublishedAssetsFilter): Promise<MediaAssetRow[]> {
    if (filter.ids.length === 0) {
        return [];
    }
    const conditions = [inArray(mediaAssets.id, filter.ids)];
    if (filter.kinds && filter.kinds.length > 0) {
        conditions.push(inArray(mediaAssets.kind, filter.kinds));
    }
    if (filter.minDuration !== undefined) {
        conditions.push(gte(mediaAssets.duration, filter.minDuration));
    }
    if (filter.maxDuration !== undefined) {
        // duration 为 NULL 的资产不参与 maxDuration 过滤（未知时长不过滤掉）
        conditions.push(sql`(${mediaAssets.duration} IS NULL OR ${mediaAssets.duration} <= ${filter.maxDuration})`);
    }
    return (await db.query.mediaAssets.findMany({
        where: and(...conditions),
        orderBy: [desc(mediaAssets.updatedAt)],
    })) as MediaAssetRow[];
}

// ---------------------------------------------------------------------------
// 专题
// ---------------------------------------------------------------------------

export interface SeriesStoryRow {
    storyId: number;
    slug: string;
    title: string | null;
    status: string;
    position: number;
    publishedAt: Date | null;
    updatedAt: Date;
    coverAssetId: number | null;
}

export async function findSeriesBySlug(db: DB, slug: string) {
    return db.query.series.findFirst({
        where: eq(series.slug, slug),
    });
}

export async function listSeriesStories(db: DB, seriesId: number): Promise<SeriesStoryRow[]> {
    const rows = await db
        .select({
            storyId: stories.id,
            slug: stories.slug,
            title: stories.title,
            status: stories.status,
            position: storySeries.position,
            publishedAt: stories.publishedAt,
            updatedAt: stories.updatedAt,
            coverAssetId: stories.coverAssetId,
        })
        .from(storySeries)
        .innerJoin(stories, eq(storySeries.storyId, stories.id))
        .where(eq(storySeries.seriesId, seriesId))
        .orderBy(storySeries.position);
    return rows;
}

/** 批量取封面资产，避免 N+1。 */
export async function findAssetsByIds(db: DB, ids: number[]): Promise<Map<number, MediaAssetRow>> {
    if (ids.length === 0) {
        return new Map();
    }
    const rows = (await db.query.mediaAssets.findMany({
        where: inArray(mediaAssets.id, ids),
    })) as MediaAssetRow[];
    return new Map(rows.map((row) => [row.id, row]));
}

// ---------------------------------------------------------------------------
// 转录（供搜索扩展用；表自 0013 已存在）
// ---------------------------------------------------------------------------

export interface TranscriptRow {
    id: number;
    assetId: number;
    text: string;
    segmentsJson: string;
}

/**
 * 关键词命中 transcripts.text 或 segments_json。
 * LIKE 特殊字符（% _ \）做转义；SQLite LIKE 对 ASCII 大小写不敏感，
 * 中文无大小写问题。limit 防止超长结果集。
 */
export async function findTranscriptsByKeyword(db: DB, keyword: string, limit = 20): Promise<TranscriptRow[]> {
    const escaped = keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const rows = await db
        .select({
            id: transcripts.id,
            assetId: transcripts.assetId,
            text: transcripts.text,
            segmentsJson: transcripts.segmentsJson,
        })
        .from(transcripts)
        .where(
            sql`(${transcripts.text} LIKE ${pattern} ESCAPE '\\' OR ${transcripts.segmentsJson} LIKE ${pattern} ESCAPE '\\')`,
        )
        .limit(limit);
    return rows;
}

// ---------------------------------------------------------------------------
// 聚合事件
// ---------------------------------------------------------------------------

export const EVENT_TYPES = ["video_play", "audio_play", "story_read", "media_view"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: unknown): value is EventType {
    return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

export async function insertMediaEvent(db: DB, eventType: EventType, assetId: number | null, storyId: number | null) {
    await db.insert(mediaEvents).values({
        eventType,
        assetId,
        storyId,
    });
}

export interface DailyEventCount {
    day: string;
    eventType: string;
    count: number;
}

/** 按天聚合；cutoff 为 Date（drizzle timestamp 列比较用 Date）。 */
export async function countEventsDaily(db: DB, cutoff: Date, eventType?: EventType): Promise<DailyEventCount[]> {
    const dayExpr = sql<string>`date(${mediaEvents.createdAt}, 'unixepoch')`;
    const rows = await db
        .select({
            day: dayExpr,
            eventType: mediaEvents.eventType,
            count: count(),
        })
        .from(mediaEvents)
        .where(
            eventType
                ? and(gte(mediaEvents.createdAt, cutoff), eq(mediaEvents.eventType, eventType))
                : gte(mediaEvents.createdAt, cutoff),
        )
        .groupBy(dayExpr, mediaEvents.eventType)
        .orderBy(dayExpr);
    return rows.map((row) => ({ day: row.day, eventType: row.eventType, count: row.count }));
}
