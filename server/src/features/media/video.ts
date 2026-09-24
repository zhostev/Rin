/**
 * R2 视频链路 · 视频/封面/字幕上传。
 *
 * 存储策略与音频一致（见 features/media/audio.ts）：
 *   1. R2 binding（env.R2_BUCKET 存在）：直接 put，key 规范
 *      media/original/{assetId}/{safeFilename}；播放 URL 用站内
 *      /api/blob/{key}（BlobService 已存在）。
 *   2. 无 binding：复用 utils/storage.ts 的 resolveStorageTarget（S3 路径）。
 *
 * 校验（路由层在建行之前执行，避免孤儿行）：
 *   - 视频：mime 以 video/ 开头，大小 ≤ VIDEO_MAX_BYTES（100MB）
 *   - 封面：mime 以 image/ 开头，大小 ≤ POSTER_MAX_BYTES（10MB）
 *   - 字幕：.vtt 文件（mime text/vtt 或 text/plain），大小 ≤ SUBTITLES_MAX_BYTES（1MB）
 */
import { getStoragePublicUrl, putStorageObjectAtKey, resolveStorageTarget } from "../../utils/storage";

/** R2 视频单文件上限：100MB（与前端 R2_MEDIA_MAX_BYTES 对齐）。 */
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
/** 封面图上限：10MB。 */
export const POSTER_MAX_BYTES = 10 * 1024 * 1024;
/** 字幕文件上限：1MB。 */
export const SUBTITLES_MAX_BYTES = 1024 * 1024;

/** 文件名清洗：去路径、去控制字符、非法字符转下划线，防目录穿越与怪异 key。 */
export function sanitizeVideoFilename(raw: string | undefined | null): string {
    const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
    const cleaned = base
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[^a-zA-Z0-9._~-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[._~-]+/, "")
        .slice(0, 120);
    return cleaned || "video";
}

/** R2 对象 key：media/original/{assetId}/{safeFilename}（与音频一致）。 */
export function buildVideoKey(assetId: number, safeFilename: string): string {
    return `media/original/${assetId}/${safeFilename}`;
}

function encodeBlobKey(key: string): string {
    return key
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

export type VideoUploadKind = "video" | "poster" | "subtitles";

export interface VideoUploadValidation {
    ok: boolean;
    /** 失败时的机器可读错误码（路由层直接用它组 400/413 响应） */
    code?: "video_file_required" | "video_invalid_mime" | "video_too_large";
    message?: string;
}

const KIND_LIMITS: Record<VideoUploadKind, { mimePrefix: string; maxBytes: number; requiredCode: VideoUploadValidation["code"]; invalidCode: VideoUploadValidation["code"] }> = {
    video: {
        mimePrefix: "video/",
        maxBytes: VIDEO_MAX_BYTES,
        requiredCode: "video_file_required",
        invalidCode: "video_invalid_mime",
    },
    poster: {
        mimePrefix: "image/",
        maxBytes: POSTER_MAX_BYTES,
        requiredCode: "video_file_required",
        invalidCode: "video_invalid_mime",
    },
    subtitles: {
        mimePrefix: "text/",
        maxBytes: SUBTITLES_MAX_BYTES,
        requiredCode: "video_file_required",
        invalidCode: "video_invalid_mime",
    },
};

/**
 * 校验上传文件（建行之前调用）。字幕额外要求文件名以 .vtt 结尾
 * （浏览器常把 .vtt 报成 text/plain，按扩展名放行）。
 */
export function validateUploadFile(
    file: unknown,
    kind: VideoUploadKind,
): VideoUploadValidation {
    const limits = KIND_LIMITS[kind];
    if (!(file instanceof File)) {
        return { ok: false, code: limits.requiredCode, message: `multipart field "file" is required` };
    }
    const mime = file.type || "";
    if (kind === "subtitles") {
        // 字幕只接受 WebVTT：mime 必须是 text/vtt，或文件名以 .vtt 结尾
        // （浏览器常把 .vtt 报成 text/plain，按扩展名放行；.srt 等一律拒绝）
        const isVtt = mime === "text/vtt" || /\.vtt$/i.test(file.name || "");
        if (!isVtt) {
            return { ok: false, code: limits.invalidCode, message: `invalid ${kind} mime type` };
        }
    } else if (!mime.startsWith(limits.mimePrefix)) {
        return { ok: false, code: limits.invalidCode, message: `invalid ${kind} mime type` };
    }
    if (file.size > limits.maxBytes) {
        return { ok: false, code: "video_too_large", message: `${kind} exceeds size limit` };
    }
    return { ok: true };
}

export interface VideoUploadResult {
    key: string;
    /** 可播放 URL：R2 binding 时为 /api/blob/{key}，S3 时为现有公开 URL 逻辑 */
    url: string;
    usedR2Binding: boolean;
}

/**
 * 上传视频/封面/字幕字节到底层存储。调用方负责先建 media_assets 行拿到
 * assetId；put 成功但后续 DB 更新失败时，调用方应删除已上传对象（回滚），
 * 避免 R2 孤儿对象。
 */
export async function uploadVideoObject(
    env: Env,
    assetId: number,
    file: Blob,
    filename: string | undefined,
    contentType?: string,
): Promise<VideoUploadResult> {
    const safeFilename = sanitizeVideoFilename(filename);
    const key = buildVideoKey(assetId, safeFilename);
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

/** 解析客户端探测到的 duration/width/height 表单字段；非法值忽略（不抛异常）。 */
export function parseProbedNumber(value: unknown): number | undefined {
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
    }
    return undefined;
}
