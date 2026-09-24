/**
 * Stage 2 · Cloudflare Stream webhook 处理。
 *
 * 官方文档：https://developers.cloudflare.com/stream/webhooks/
 * （注：实现时文档站不可达，按已知的文档约定实现，并在代码注释中标明；
 *  如 Cloudflare 后续变更签名方案，需同步更新 verifyStreamWebhookSignature）
 *
 * 验签约定（按文档）：
 *   - Dashboard（Stream > Webhooks）配置通知 URL 与 secret；
 *   - Stream 以 POST 发送 JSON，原始 body 用 secret 做 HMAC-SHA256，
 *     hex 编码后放在 `Webhook-Signature` 请求头中；
 *   - 接收方用同样算法计算并做常量时间比较。
 *   - STREAM_WEBHOOK_SECRET 未配置时拒绝请求并返回 500 级清晰错误，
 *     绝不静默通过。
 *
 * 状态机：uploading → processing → ready | error
 *   - Stream 原生状态映射：pendingupload→uploading；
 *     downloading/queued/inprogress→processing；ready→ready；error→error。
 *   - 幂等：重复回调（目标状态 == 当前状态）不产生副作用。
 *   - 防乱序：terminal（ready/error）之后不再接受回退；processing 不回退到 uploading。
 *   - 未知 uid：记录日志，返回 200（避免 Stream 无限重试）。
 */
import type { DB } from "../../core/hono-types";
import { computeStreamSync, type StreamSyncInput } from "./stream";
import { findMediaAssetByStreamUid, updateMediaAssetById } from "./repository";

/** 服务端未配置 webhook secret：路由层返回 500 + 清晰错误码 */
export class WebhookConfigError extends Error {
    readonly code = "stream_webhook_secret_not_configured" as const;
    constructor() {
        super("STREAM_WEBHOOK_SECRET is not set; refusing to verify Stream webhook");
        this.name = "WebhookConfigError";
    }
}

/** 常量时间字符串比较（Workers/bun 均无 subtle.timingSafeEqual，手写） */
function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function toHex(bytes: ArrayBuffer): string {
    return Array.from(new Uint8Array(bytes))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * 验签：HMAC-SHA256(rawBody, secret) 的 hex 是否等于 Webhook-Signature 头。
 * secret 为空时抛 WebhookConfigError（调用方转 500）。
 */
export async function verifyStreamWebhookSignature(
    rawBody: string,
    signatureHeader: string | null | undefined,
    secret: string | undefined | null,
): Promise<boolean> {
    if (!secret) {
        throw new WebhookConfigError();
    }
    if (!signatureHeader) {
        return false;
    }
    const expected = signatureHeader.trim().toLowerCase();

    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const actual = toHex(digest);

    return constantTimeEqual(actual, expected);
}

export interface StreamWebhookVideo extends StreamSyncInput {
    uid: string;
}

/**
 * 从 webhook payload 提取视频信息。
 * 文档格式为视频详情对象平铺（{uid, status:{state,...}, duration, ...}）；
 * 防御性兼容 {video: {...}} 包裹格式。
 */
export function extractWebhookVideo(payload: unknown): StreamWebhookVideo | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }
    const root = payload as Record<string, unknown>;
    const video = (root.video && typeof root.video === "object"
        ? root.video
        : root) as Record<string, unknown>;

    const uid = video.uid;
    if (typeof uid !== "string" || uid.length === 0) {
        return null;
    }

    const status = (video.status && typeof video.status === "object"
        ? video.status
        : {}) as Record<string, unknown>;
    const meta = (video.meta && typeof video.meta === "object"
        ? video.meta
        : {}) as Record<string, unknown>;

    const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

    return {
        uid,
        state: asString(status.state),
        errorReasonCode: asString(status.errorReasonCode),
        errorReasonText: asString(status.errorReasonText),
        duration: typeof video.duration === "number" ? video.duration : null,
        thumbnail: asString(video.thumbnail),
        readyToStream: typeof video.readyToStream === "boolean" ? video.readyToStream : null,
        pctComplete: asString(status.pctComplete),
        name: asString(meta.name),
    };
}

export type WebhookApplyResult =
    | { handled: true; deduped: boolean; assetId: number; from: string; to: string }
    | { handled: false; reason: "unknown_uid" | "unknown_state" | "stale" | "missing_uid" | "no_row" };

/**
 * 应用 webhook 状态流转：按 stream_uid 查行并更新
 * stream_status / stream_error / stream_meta_json / updated_at。
 * 状态机决策收敛在 computeStreamSync（与 GET /stream/:uid 共用）。
 */
export async function applyStreamWebhook(
    db: DB,
    payload: unknown,
): Promise<WebhookApplyResult> {
    const video = extractWebhookVideo(payload);
    if (!video) {
        return { handled: false, reason: "missing_uid" };
    }

    const row = await findMediaAssetByStreamUid(db, video.uid);
    if (!row) {
        // 未知 uid：调用方记日志并返回 200，避免 Stream 无限重试
        return { handled: false, reason: "unknown_uid" };
    }

    const decision = computeStreamSync(row.streamStatus, row.streamMetaJson, video);
    if (!decision.changed) {
        if (decision.reason === "deduped") {
            return {
                handled: true,
                deduped: true,
                assetId: row.id,
                from: row.streamStatus ?? "ready",
                to: decision.target ?? row.streamStatus ?? "ready",
            };
        }
        return { handled: false, reason: decision.reason };
    }

    await updateMediaAssetById(db, row.id, {
        ...decision.patch,
        updatedAt: new Date(),
    });

    return {
        handled: true,
        deduped: false,
        assetId: row.id,
        from: row.streamStatus ?? "ready",
        to: decision.target,
    };
}
