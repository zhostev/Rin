/**
 * Stage 2 · Cloudflare Images 客户端（直传 / 查询 / 删除）。
 *
 * Token 读取优先级：CF_MEDIA_API_TOKEN > CF_IMAGES_TOKEN。
 * 未配置时抛 MediaNotConfiguredError（路由层转 503 images_not_configured）。
 *
 * 变体 URL 直接采用 API 返回的完整 URL 存入 images_variants_json；
 * 变体名默认 ["thumb","medium","large"]，缺失时 finalize/序列化回退 public 变体。
 *
 * 文档：https://developers.cloudflare.com/images/upload-images/direct-uploads/
 */
import {
    cfRequest,
    requireAccountId,
    MediaNotConfiguredError,
    type CfClientOptions,
} from "./client";

export interface ImagesDirectUploadResult {
    id: string;
    uploadURL: string;
}

export interface ImagesImage {
    id: string;
    filename?: string;
    uploaded?: string;
    requireSignedURLs?: boolean;
    /** 完整变体 URL 数组，末段为变体名，如 .../<id>/public */
    variants?: string[];
    [key: string]: unknown;
}

export interface ImagesClientConfig {
    accountId: string;
    token: string;
    fetchImpl?: CfClientOptions["fetchImpl"];
}

export function resolveImagesConfig(env: Env): ImagesClientConfig {
    const accountId = requireAccountId(env, "images_not_configured");
    const token = env.CF_MEDIA_API_TOKEN?.trim() || env.CF_IMAGES_TOKEN?.trim() || "";
    if (!token) {
        throw new MediaNotConfiguredError(
            "images_not_configured",
            "Neither CF_MEDIA_API_TOKEN nor CF_IMAGES_TOKEN is set",
        );
    }
    return { accountId, token };
}

/**
 * 从变体完整 URL 提取变体名（取末段路径）。
 * 例：https://imagedelivery.net/<hash>/<id>/public → "public"
 */
export function variantNameFromUrl(url: string): string {
    const trimmed = url.split("?")[0].split("#")[0].replace(/\/+$/, "");
    const last = trimmed.split("/").pop() ?? "";
    return decodeURIComponent(last);
}

/** variants 数组 → Record<变体名, 完整URL>；重复名以后者为准。 */
export function buildVariantsRecord(variants: string[] | undefined | null): Record<string, string> {
    const record: Record<string, string> = {};
    for (const url of variants ?? []) {
        if (typeof url !== "string" || url.length === 0) {
            continue;
        }
        const name = variantNameFromUrl(url);
        if (name) {
            record[name] = url;
        }
    }
    return record;
}

export class CloudflareImagesClient {
    private readonly accountId: string;
    private readonly token: string;
    private readonly fetchImpl: CfClientOptions["fetchImpl"];

    constructor(config: ImagesClientConfig) {
        this.accountId = config.accountId;
        this.token = config.token;
        this.fetchImpl = config.fetchImpl;
    }

    static fromEnv(env: Env): CloudflareImagesClient {
        return new CloudflareImagesClient(resolveImagesConfig(env));
    }

    private request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
        return cfRequest<T>(
            {
                accountId: this.accountId,
                token: this.token,
                fetchImpl: this.fetchImpl,
                serviceName: "images",
            },
            method,
            path,
            body,
        );
    }

    /**
     * 创建直接上传会话。
     * POST /accounts/{id}/images/v2/direct_upload → { id, uploadURL }
     * 前端用 uploadURL 做 multipart 直传，图片不经过本站服务器。
     */
    async createDirectUpload(): Promise<ImagesDirectUploadResult> {
        const result = await this.request<ImagesDirectUploadResult>(
            "POST",
            `/accounts/${this.accountId}/images/v2/direct_upload`,
            {},
        );
        if (!result?.id || !result?.uploadURL) {
            throw new Error("images direct_upload returned malformed result (missing id/uploadURL)");
        }
        return { id: result.id, uploadURL: result.uploadURL };
    }

    /** GET /accounts/{id}/images/v1/{image_id}：查询图片（含 variants 数组） */
    async getImage(id: string): Promise<ImagesImage> {
        return this.request<ImagesImage>("GET", `/accounts/${this.accountId}/images/v1/${id}`);
    }

    /** DELETE /accounts/{id}/images/v1/{image_id}：删除远端图片 */
    async deleteImage(id: string): Promise<void> {
        await this.request<unknown>("DELETE", `/accounts/${this.accountId}/images/v1/${id}`);
    }
}
