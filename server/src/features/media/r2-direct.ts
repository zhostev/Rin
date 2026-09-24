/**
 * R2 presigned 直传（图片 / 视频 / 音频）。
 *
 * 背景：旧链路是浏览器 → Worker → R2 中转，Worker 请求体上限 100MB，
 * 大视频会报 413。直传链路：
 *
 *   1. POST /admin/media/r2/direct-upload（JSON：kind/filename/mimeType/size/…）
 *      → 校验 → 建 media_assets 行（stream_status=uploading）→ 签发一次性
 *      PUT URL → 201 { asset, uploadURL, key }
 *   2. 浏览器用 uploadFileRaw 直接 PUT 文件到 R2（不经过 Worker，无 100MB 限制）
 *   3. POST /admin/media/r2/:id/complete → HEAD 确认对象存在 → 置 ready
 *
 * 签名用 S3 兼容凭证（S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY），endpoint /
 * bucket 复用现有 S3 路径配置（S3_ENDPOINT / S3_BUCKET / S3_FORCE_PATH_STYLE /
 * S3_REGION）。未配置时抛 R2DirectNotConfiguredError，路由层转 503，前端
 * 回退旧的中转上传。
 *
 * 单文件上限（R2 单 PUT 上限 5GB）：
 *   - image: 10MB（与编辑器旧限一致）
 *   - video: 5GB
 *   - audio: 1GB
 */
import { AwsClient } from "aws4fetch";
import { buildS3ObjectUrl } from "../../utils/s3";

export type R2DirectKind = "image" | "video" | "audio";

export const R2_DIRECT_KINDS: readonly R2DirectKind[] = ["image", "video", "audio"] as const;

export function isR2DirectKind(value: unknown): value is R2DirectKind {
    return typeof value === "string" && (R2_DIRECT_KINDS as readonly string[]).includes(value);
}

/** 直传单文件上限（字节）。 */
export const R2_DIRECT_MAX_BYTES: Record<R2DirectKind, number> = {
    image: 10 * 1024 * 1024,
    video: 5 * 1024 * 1024 * 1024,
    audio: 1024 * 1024 * 1024,
};

/** 各 kind 允许的 mime 前缀。 */
const KIND_MIME_PREFIX: Record<R2DirectKind, string> = {
    image: "image/",
    video: "video/",
    audio: "audio/",
};

export interface R2DirectValidation {
    ok: boolean;
    /** 机器可读错误码（路由层直接用它组 400/413 响应）。 */
    code?: "direct_file_required" | "direct_invalid_mime" | "direct_too_large" | "direct_invalid_size";
    message?: string;
}

/** 校验直传建单请求：kind 合法、mime 前缀匹配、size 为正整数且不超限。 */
export function validateDirectUploadRequest(input: {
    kind: unknown;
    mimeType?: unknown;
    size?: unknown;
}): R2DirectValidation {
    const { kind, mimeType, size } = input;
    if (!isR2DirectKind(kind)) {
        return { ok: false, code: "direct_file_required", message: "kind must be one of image/video/audio" };
    }
    const mime = typeof mimeType === "string" ? mimeType : "";
    if (!mime.startsWith(KIND_MIME_PREFIX[kind])) {
        return { ok: false, code: "direct_invalid_mime", message: `${kind} requires ${KIND_MIME_PREFIX[kind]}* mime` };
    }
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
        return { ok: false, code: "direct_invalid_size", message: "size must be a positive number" };
    }
    if (size > R2_DIRECT_MAX_BYTES[kind]) {
        return { ok: false, code: "direct_too_large", message: `${kind} exceeds size limit` };
    }
    return { ok: true };
}

/** 文件名清洗：去路径、去控制字符、非法字符转下划线，防目录穿越与怪异 key。 */
export function sanitizeDirectFilename(raw: string | undefined | null): string {
    const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
    const cleaned = base
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[^a-zA-Z0-9._~-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[._~-]+/, "")
        .slice(0, 120);
    return cleaned || "file";
}

/** R2 对象 key：media/original/{assetId}/{safeFilename}（与音视频旧链路一致）。 */
export function buildDirectUploadKey(assetId: number, filename: string | undefined | null): string {
    return `media/original/${assetId}/${sanitizeDirectFilename(filename)}`;
}

export class R2DirectNotConfiguredError extends Error {
    readonly code = "r2_direct_upload_not_configured";
    constructor(message: string) {
        super(message);
        this.name = "R2DirectNotConfiguredError";
    }
}

export interface R2DirectConfig {
    accessKeyId: string;
    secretAccessKey: string;
}

/** 直传依赖 S3 兼容凭证 + endpoint/bucket；缺失时抛 R2DirectNotConfiguredError。 */
export function resolveR2DirectConfig(env: Env): R2DirectConfig {
    const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() || "";
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() || "";
    const missing: string[] = [];
    if (!env.S3_ENDPOINT) missing.push("S3_ENDPOINT");
    if (!env.S3_BUCKET) missing.push("S3_BUCKET");
    if (!accessKeyId) missing.push("S3_ACCESS_KEY_ID");
    if (!secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
    if (missing.length > 0) {
        throw new R2DirectNotConfiguredError(
            `R2 direct upload is not configured (missing: ${missing.join(", ")})`,
        );
    }
    return { accessKeyId, secretAccessKey };
}

/**
 * 签发一次性 PUT URL（query-string SigV4）。
 * 只签 host（不签 Content-Type），浏览器 PUT 时可自由带 Content-Type。
 * expiresInSec 默认 2 小时：大文件慢速上传也能在有效期内发起请求。
 */
export async function presignR2PutUrl(
    env: Env,
    key: string,
    expiresInSec = 7200,
): Promise<string> {
    const { accessKeyId, secretAccessKey } = resolveR2DirectConfig(env);
    const client = new AwsClient({
        accessKeyId,
        secretAccessKey,
        service: "s3",
    });
    const base = buildS3ObjectUrl(env, key);
    const url = `${base}${base.includes("?") ? "&" : "?"}X-Amz-Expires=${Math.floor(expiresInSec)}`;
    const signed = await client.sign(url, {
        method: "PUT",
        aws: { signQuery: true },
    });
    return signed.url;
}
