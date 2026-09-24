/**
 * Stage 2 · 媒体栈 wire contract。
 *
 * 管理端媒体 API 返回的 asset 对象形状，前端会原样嵌入内容块 payload_json，
 * GET /api/story/:slug 原样返回。前后端共同遵守，改动时需同步前端。
 */
import type { MediaAssetRow } from "./repository";

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
 */
export function serializeMediaAsset(row: MediaAssetRow): MediaAsset {
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

    return asset;
}
