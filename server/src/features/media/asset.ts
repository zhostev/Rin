/**
 * Stage 2 · 媒体栈 wire contract。
 *
 * 管理端媒体 API 返回的 asset 对象形状，前端会原样嵌入内容块 payload_json，
 * GET /api/story/:slug 原样返回。前后端共同遵守，改动时需同步前端。
 */
import type { MediaAssetRow } from "./repository";
import { inArray } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import { mediaAssets } from "../../db/schema";

export interface MediaAsset {
    id: number;
    kind: "image" | "video" | "audio" | "gallery" | "attachment";
    source: "r2" | "stream" | "cloudflare_images" | "external";
    mime?: string;
    duration?: number;
    width?: number;
    height?: number;
    /** r2: /api/blob/<r2_key>；images: medium 变体 URL（缺失回退 public）；video: HLS manifest */
    url?: string;
    alt?: string;
    title?: string;
    /** R2 视频链路：封面图资产行 id；poster_url 为其派生播放地址 */
    poster_asset_id?: number;
    poster_url?: string;
    /** R2 视频链路：字幕资产行 id（text/vtt）；subtitles_url 为其派生地址 */
    subtitles_asset_id?: number;
    subtitles_url?: string;
    stream_uid?: string;
    stream_status?: "uploading" | "processing" | "ready" | "error";
    stream_error?: string;
    /** https://videodelivery.net/<uid>/thumbnails/thumbnail.jpg */
    thumbnail_url?: string;
    /** https://iframe.videodelivery.net/<uid> */
    embed_url?: string;
    images_id?: string;
    /** {thumb,medium,large,public...} 变体完整 URL */
    images_variants?: Record<string, string>;
}

export type { MediaAssetRow };

const STREAM_STATUSES = new Set(["uploading", "processing", "ready", "error"]);

function encodeBlobKey(key: string): string {
    return key
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

/** 从 images_variants_json 解析变体表；解析失败时返回空对象（不抛异常）。 */
export function parseImagesVariants(json: string | null | undefined): Record<string, string> {
    if (!json) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === "string" && value.length > 0) {
                    record[key] = value;
                }
            }
            return record;
        }
    } catch {
        // 脏数据容忍：返回空对象，前端回退 public 变体
    }
    return {};
}

/** Images 变体名默认取 ["thumb","medium","large"]，缺失时回退 public 变体。 */
export function pickImagesUrl(variants: Record<string, string>): string | undefined {
    return variants["medium"] ?? variants["large"] ?? variants["thumb"] ?? variants["public"];
}

/**
 * DB 行 → wire MediaAsset。
 * 纯函数：所有派生 URL（embed/thumbnail/manifest、/api/blob、变体回退）都在这里集中计算，
 * 路由与 webhook 只负责读写 DB，不重复拼 URL。
 *
 * linked：可选的关联资产行（封面/字幕），由调用方批量查出后传入；
 * 不传则只透出 *_asset_id，不派生 URL。递归序列化关联行时不再向下展开，
 * 避免循环引用。
 */
export function serializeMediaAsset(
    row: MediaAssetRow,
    linked?: { poster?: MediaAssetRow | null; subtitles?: MediaAssetRow | null },
): MediaAsset {
    const asset: MediaAsset = {
        id: row.id,
        kind: row.kind as MediaAsset["kind"],
        source: row.source as MediaAsset["source"],
    };

    if (row.mime) {
        asset.mime = row.mime;
    }
    if (row.duration !== null && row.duration !== undefined) {
        asset.duration = row.duration;
    }
    if (row.width !== null && row.width !== undefined) {
        asset.width = row.width;
    }
    if (row.height !== null && row.height !== undefined) {
        asset.height = row.height;
    }
    if (row.altText) {
        asset.alt = row.altText;
    }
    if (row.title) {
        asset.title = row.title;
    }

    if (row.source === "stream" && row.streamUid) {
        const uid = row.streamUid;
        asset.stream_uid = uid;
        asset.stream_status = (STREAM_STATUSES.has(row.streamStatus ?? "")
            ? row.streamStatus
            : "ready") as MediaAsset["stream_status"];
        if (row.streamError) {
            asset.stream_error = row.streamError;
        }
        asset.thumbnail_url = `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg`;
        asset.embed_url = `https://iframe.videodelivery.net/${uid}`;
        // HLS 直播流地址：供 <video> 直接播放；未转码完成时 Stream 返回 404，
        // 前端应以 stream_status === 'ready' 为准再使用。
        asset.url = `https://videodelivery.net/${uid}/manifest/video.m3u8`;
    }

    if ((row.source === "cloudflare_images" || row.kind === "image") && row.imagesId) {
        asset.images_id = row.imagesId;
        const variants = parseImagesVariants(row.imagesVariantsJson);
        asset.images_variants = variants;
        const url = pickImagesUrl(variants);
        if (url) {
            asset.url = url;
        }
    }

    if (row.source === "r2" && row.r2Key) {
        asset.url = `/api/blob/${encodeBlobKey(row.r2Key)}`;
    }

    if (row.posterAssetId) {
        asset.poster_asset_id = row.posterAssetId;
        const posterUrl = linked?.poster ? serializeMediaAsset(linked.poster).url : undefined;
        if (posterUrl) {
            asset.poster_url = posterUrl;
        }
    }
    if (row.subtitlesAssetId) {
        asset.subtitles_asset_id = row.subtitlesAssetId;
        const subtitlesUrl = linked?.subtitles ? serializeMediaAsset(linked.subtitles).url : undefined;
        if (subtitlesUrl) {
            asset.subtitles_url = subtitlesUrl;
        }
    }

    return asset;
}

/**
 * 批量查出若干资产行的封面/字幕关联行，返回 assetId -> {poster, subtitles}。
 * 调用方（列表路由）用一次查询代替 N+1。
 */
export async function loadLinkedAssetRows(
    db: DB,
    rows: MediaAssetRow[],
): Promise<Map<number, { poster?: MediaAssetRow; subtitles?: MediaAssetRow }>> {
    const ids = new Set<number>();
    for (const row of rows) {
        if (row.posterAssetId) ids.add(row.posterAssetId);
        if (row.subtitlesAssetId) ids.add(row.subtitlesAssetId);
    }
    const result = new Map<number, { poster?: MediaAssetRow; subtitles?: MediaAssetRow }>();
    if (ids.size === 0) {
        return result;
    }
    const linked = await db.query.mediaAssets.findMany({
        where: inArray(mediaAssets.id, [...ids]),
    });
    const byId = new Map<number, MediaAssetRow>();
    for (const row of linked) {
        byId.set(row.id, row);
    }
    for (const row of rows) {
        const entry: { poster?: MediaAssetRow; subtitles?: MediaAssetRow } = {};
        if (row.posterAssetId) {
            const poster = byId.get(row.posterAssetId);
            if (poster) entry.poster = poster;
        }
        if (row.subtitlesAssetId) {
            const subtitles = byId.get(row.subtitlesAssetId);
            if (subtitles) entry.subtitles = subtitles;
        }
        if (entry.poster || entry.subtitles) {
            result.set(row.id, entry);
        }
    }
    return result;
}
