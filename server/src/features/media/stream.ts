/**
 * Stage 2 · Cloudflare Stream 客户端（直传 / 查询 / 删除）。
 *
 * Token 读取优先级：CF_MEDIA_API_TOKEN > CF_STREAM_TOKEN。
 * 未配置时抛 MediaNotConfiguredError（路由层转 503 stream_not_configured）。
 * API 错误抛 CloudflareApiError（路由层转 502 + 错误码，不抛裸异常）。
 *
 * 文档：https://developers.cloudflare.com/stream/uploading-videos/direct-uploads/
 */
import {
    cfRequest,
    requireAccountId,
    MediaNotConfiguredError,
    type CfClientOptions,
} from "./client";

export interface StreamDirectUploadOptions {
    maxDurationSeconds?: number;
    /** 直传 URL 有效期（秒），传给 API 的 expiry 字段 */
    expirySeconds?: number;
    meta?: Record<string, string>;
}

export interface StreamDirectUploadResult {
    uid: string;
    uploadURL: string;
}

export interface StreamVideoStatus {
    state: string;
    pctComplete?: string;
    errorReasonCode?: string;
    errorReasonText?: string;
}

export interface StreamVideo {
    uid: string;
    status?: StreamVideoStatus;
    readyToStream?: boolean;
    duration?: number;
    thumbnail?: string;
    preview?: string;
    meta?: Record<string, string>;
    created?: string;
    modified?: string;
    [key: string]: unknown;
}

/** Stream 状态 → media_assets.stream_status（webhook 与 GET 同步共用） */
export function mapStreamState(state: string | undefined | null): "uploading" | "processing" | "ready" | "error" | null {
    switch ((state ?? "").toLowerCase()) {
        case "pendingupload":
            return "uploading";
        case "downloading":
        case "queued":
        case "inprogress":
            return "processing";
        case "ready":
            return "ready";
        case "error":
            return "error";
        default:
            return null;
    }
}

export type StreamDbStatus = "uploading" | "processing" | "ready" | "error";

/** webhook payload / getVideo 结果统一为该形状后做状态同步 */
export interface StreamSyncInput {
    state: string | null;
    errorReasonCode: string | null;
    errorReasonText: string | null;
    duration: number | null;
    thumbnail: string | null;
    readyToStream: boolean | null;
    pctComplete: string | null;
    name?: string | null;
}

const STATE_ORDER: Record<StreamDbStatus, number> = {
    uploading: 0,
    processing: 1,
    ready: 2,
    error: 2,
};

export type StreamSyncDecision =
    | { changed: false; reason: "deduped" | "stale" | "unknown_state"; target: StreamDbStatus | null }
    | {
        changed: true;
        target: StreamDbStatus;
        patch: {
            streamStatus: StreamDbStatus;
            streamError: string;
            streamMetaJson: string;
            duration?: number;
        };
    };

function parseMetaJson(json: string | null | undefined): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(json ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // 脏数据容忍：从空对象开始合并
    }
    return {};
}

/**
 * 计算 Stream 状态同步决策（webhook 与 GET /stream/:uid 共用）：
 *   - 未知 state → unknown_state（调用方记日志，返回 200/忽略）
 *   - 目标 == 当前 → deduped（幂等，无副作用）
 *   - 目标落后于当前（如 ready 后又收到 processing）→ stale（防乱序，不回退）
 *   - 否则 → changed，附带 DB patch（stream_status/stream_error/stream_meta_json/duration）
 */
export function computeStreamSync(
    currentStatus: string | null | undefined,
    currentMetaJson: string | null | undefined,
    input: StreamSyncInput,
): StreamSyncDecision {
    const target = mapStreamState(input.state);
    if (!target) {
        return { changed: false, reason: "unknown_state", target: null };
    }

    const current: StreamDbStatus = (["uploading", "processing", "ready", "error"] as const).includes(
        (currentStatus ?? "") as StreamDbStatus,
    )
        ? (currentStatus as StreamDbStatus)
        : "ready";

    if (current === target) {
        return { changed: false, reason: "deduped", target };
    }
    if (STATE_ORDER[target] < STATE_ORDER[current]) {
        return { changed: false, reason: "stale", target };
    }

    const meta = parseMetaJson(currentMetaJson);
    if (input.duration !== null) meta.duration = input.duration;
    if (input.thumbnail !== null) meta.thumbnail = input.thumbnail;
    if (input.readyToStream !== null) meta.readyToStream = input.readyToStream;
    if (input.pctComplete !== null) meta.pctComplete = input.pctComplete;
    if (input.name !== null && input.name !== undefined) meta.name = input.name;
    meta.lastSyncAt = new Date().toISOString();

    const patch: {
        streamStatus: StreamDbStatus;
        streamError: string;
        streamMetaJson: string;
        duration?: number;
    } = {
        streamStatus: target,
        streamError: target === "error"
            ? (input.errorReasonText || input.errorReasonCode || "stream reported error")
            : "",
        streamMetaJson: JSON.stringify(meta),
    };
    if (input.duration !== null) {
        patch.duration = Math.round(input.duration);
    }

    return { changed: true, target, patch };
}

export interface StreamClientConfig {
    accountId: string;
    token: string;
    fetchImpl?: CfClientOptions["fetchImpl"];
}

export function resolveStreamConfig(env: Env): StreamClientConfig {
    const accountId = requireAccountId(env, "stream_not_configured");
    const token = env.CF_MEDIA_API_TOKEN?.trim() || env.CF_STREAM_TOKEN?.trim() || "";
    if (!token) {
        throw new MediaNotConfiguredError(
            "stream_not_configured",
            "Neither CF_MEDIA_API_TOKEN nor CF_STREAM_TOKEN is set",
        );
    }
    return { accountId, token };
}

export class CloudflareStreamClient {
    private readonly accountId: string;
    private readonly token: string;
    private readonly fetchImpl: CfClientOptions["fetchImpl"];

    constructor(config: StreamClientConfig) {
        this.accountId = config.accountId;
        this.token = config.token;
        this.fetchImpl = config.fetchImpl;
    }

    static fromEnv(env: Env): CloudflareStreamClient {
        return new CloudflareStreamClient(resolveStreamConfig(env));
    }

    private request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
        return cfRequest<T>(
            {
                accountId: this.accountId,
                token: this.token,
                fetchImpl: this.fetchImpl,
                serviceName: "stream",
            },
            method,
            path,
            body,
        );
    }

    /**
     * 创建直接上传会话。
     * POST /accounts/{id}/stream/direct_upload → { uid, uploadURL }
     * 前端用 uploadURL 做 tus/单次 PUT 直传，视频不经过本站服务器。
     */
    async createDirectUpload(options: StreamDirectUploadOptions = {}): Promise<StreamDirectUploadResult> {
        const body: Record<string, unknown> = {};
        if (options.maxDurationSeconds !== undefined) {
            body.maxDurationSeconds = options.maxDurationSeconds;
        }
        if (options.expirySeconds !== undefined) {
            body.expiry = new Date(Date.now() + options.expirySeconds * 1000).toISOString();
        }
        if (options.meta && Object.keys(options.meta).length > 0) {
            body.meta = options.meta;
        }
        const result = await this.request<StreamDirectUploadResult>(
            "POST",
            `/accounts/${this.accountId}/stream/direct_upload`,
            body,
        );
        if (!result?.uid || !result?.uploadURL) {
            throw new Error("stream direct_upload returned malformed result (missing uid/uploadURL)");
        }
        return { uid: result.uid, uploadURL: result.uploadURL };
    }

    /** GET /accounts/{id}/stream/{uid}：查询视频（含转码状态） */
    async getVideo(uid: string): Promise<StreamVideo> {
        return this.request<StreamVideo>("GET", `/accounts/${this.accountId}/stream/${uid}`);
    }

    /** DELETE /accounts/{id}/stream/{uid}：删除远端视频 */
    async deleteVideo(uid: string): Promise<void> {
        await this.request<unknown>("DELETE", `/accounts/${this.accountId}/stream/${uid}`);
    }
}
