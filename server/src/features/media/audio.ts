/**
 * Stage 2 · 音频上传。
 *
 * 存储策略（按优先级）：
 *   1. R2 binding（env.R2_BUCKET 存在）：直接 put，key 规范
 *      media/original/{assetId}/{safeFilename}；播放 URL 用站内
 *      /api/blob/{key}（BlobService 已存在）。
 *   2. 无 binding：复用 utils/storage.ts 的 resolveStorageTarget（S3 路径），
 *      播放 URL 用现有 getStoragePublicUrl 逻辑。
 *
 * S3 未配置时 resolveStorageTarget 会抛 Error，调用方（路由层）应捕获并
 * 转为 503 storage_not_configured。
 */
import { getStoragePublicUrl, putStorageObjectAtKey, resolveStorageTarget } from "../../utils/storage";

/** 文件名清洗：去路径、去控制字符、非法字符转下划线，防目录穿越与怪异 key。 */
export function sanitizeFilename(raw: string | undefined | null): string {
    const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
    const cleaned = base
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[^a-zA-Z0-9._~-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[._~-]+/, "")
        .slice(0, 120);
    return cleaned || "audio";
}

/** R2 对象 key：media/original/{assetId}/{safeFilename} */
export function buildAudioKey(assetId: number, safeFilename: string): string {
    return `media/original/${assetId}/${safeFilename}`;
}

function encodeBlobKey(key: string): string {
    return key
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

export interface AudioUploadResult {
    key: string;
    /** 可播放 URL：R2 binding 时为 /api/blob/{key}，S3 时为现有公开 URL 逻辑 */
    url: string;
    usedR2Binding: boolean;
}

/**
 * 上传音频字节到底层存储。调用方负责先建 media_assets 行拿到 assetId、
 * 失败时自行清理 DB 行（避免孤儿行）。
 */
export async function uploadAudioObject(
    env: Env,
    assetId: number,
    file: Blob,
    filename: string | undefined,
    contentType?: string,
): Promise<AudioUploadResult> {
    const safeFilename = sanitizeFilename(filename);
    const key = buildAudioKey(assetId, safeFilename);
    const type = contentType || file.type || undefined;

    if (env.R2_BUCKET) {
        await env.R2_BUCKET.put(key, file, {
            httpMetadata: type ? { contentType: type } : undefined,
        });
        return {
            key,
            url: `/api/blob/${encodeBlobKey(key)}`,
            usedR2Binding: true,
        };
    }

    // S3 路径：先用 resolveStorageTarget 校验配置（缺失时抛清晰 Error，调用方转 503）
    resolveStorageTarget(env);
    const { key: storedKey } = await putStorageObjectAtKey(env, key, file, type);
    return {
        key: storedKey,
        url: getStoragePublicUrl(env, storedKey),
        usedR2Binding: false,
    };
}
