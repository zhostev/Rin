/**
 * MiniMax H3 视频生成：relay 客户端 + 参数校验（AI Studio aistudio.video）。
 *
 * 链路：Worker → minimax-relay（ddns.hoo.ink，自建 Python 服务，见仓库
 * minimax-relay/）→ MiniMax V2 API。API key 只保存在中转机环境变量里，
 * 不进 Worker、不进 D1。relay 侧异步轮询 MiniMax，Worker 侧 processor 只
 * 负责提交，cron sweep（minimax-sweep.ts）负责轮询收尾。
 *
 * 本文件只放纯函数与无副作用的 fetch 封装，便于单测。
 */
import {
    MINIMAX_VIDEO_DURATION_DEFAULT,
    MINIMAX_VIDEO_DURATION_MAX,
    MINIMAX_VIDEO_DURATION_MIN,
    MINIMAX_VIDEO_MODEL,
    MINIMAX_VIDEO_PROMPT_MAX,
    MINIMAX_VIDEO_RATIO_DEFAULT,
    MINIMAX_VIDEO_RATIOS,
    MINIMAX_VIDEO_RESOLUTION_DEFAULT,
    MINIMAX_VIDEO_RESOLUTIONS,
    type MinimaxVideoResolution,
} from "./models";

/** 去掉字符串中的全部空白与不可见格式字符（同 feed-wechat-draft.ts 的实现，
 *  URL 与 Bearer 里永远不会合法出现这类字符；iOS 复制粘贴常带入）。 */
export function stripRelayInvisibleChars(value: string): string {
    return value.replace(/[\s\u200B-\u200D\u2060\u00AD]/g, "");
}

/** 规范化 MINIMAX_RELAY_URL：清不可见字符、去末尾斜杠；空视为未配置。 */
export function normalizeMinimaxRelayUrl(url: string | undefined): string | undefined {
    const normalized = url ? stripRelayInvisibleChars(url).replace(/\/+$/, "") : "";
    return normalized || undefined;
}

export interface MinimaxRelayConfig {
    url: string;
    secret: string;
}

/**
 * 解析 relay 配置。返回 error 时调用方应 failJob / 400 打回，
 * 不要把"未配置"当成可重试的异常吞掉。
 */
export function resolveMinimaxRelay(
    env: Env,
): { ok: true; config: MinimaxRelayConfig } | { ok: false; error: string } {
    const url = normalizeMinimaxRelayUrl(env.MINIMAX_RELAY_URL);
    const secret = env.MINIMAX_RELAY_SECRET
        ? stripRelayInvisibleChars(env.MINIMAX_RELAY_SECRET) || undefined
        : undefined;
    if (!url || !secret) {
        return {
            ok: false,
            error: "MiniMax 中转服务未配置（MINIMAX_RELAY_URL / MINIMAX_RELAY_SECRET）",
        };
    }
    try {
        new URL(url);
    } catch {
        return { ok: false, error: "MINIMAX_RELAY_URL 不是合法的 URL" };
    }
    return { ok: true, config: { url, secret } };
}

export interface MinimaxVideoSpec {
    /** 文本 prompt（1..7000 字符） */
    prompt: string;
    /** 时长秒（整数 4..15） */
    duration: number;
    /** 分辨率档位 */
    resolution: MinimaxVideoResolution;
    /** 宽高比（t2v 必填；i2v 固定 adaptive） */
    ratio: string;
    /** 图生视频首帧：媒体库图片 asset id（可选） */
    firstFrameAssetId?: number;
}

export interface VideoParamsInput {
    text?: unknown;
    assetId?: unknown;
    params?: Record<string, unknown>;
}

function isRatio(value: unknown): value is string {
    return typeof value === "string" && (MINIMAX_VIDEO_RATIOS as readonly string[]).includes(value);
}

function isResolution(value: unknown): value is MinimaxVideoResolution {
    return (
        typeof value === "string" &&
        (MINIMAX_VIDEO_RESOLUTIONS as readonly string[]).includes(value)
    );
}

/**
 * 校验 video 任务的输入与参数。纯函数，可单测。
 * prompt 来自 input.text；input.assetId（图片）可选，作为图生视频首帧。
 */
export function validateVideoParams(
    input: VideoParamsInput,
): { ok: true; spec: MinimaxVideoSpec } | { ok: false; error: string } {
    const prompt = typeof input.text === "string" ? input.text.trim() : "";
    if (!prompt) {
        return { ok: false, error: "video 需要 input.text（视频描述 prompt，非空）" };
    }
    if (prompt.length > MINIMAX_VIDEO_PROMPT_MAX) {
        return {
            ok: false,
            error: `prompt 过长（${prompt.length}/${MINIMAX_VIDEO_PROMPT_MAX} 字符）`,
        };
    }

    const params = input.params ?? {};
    const rawDuration = params["duration"];
    const duration =
        rawDuration === undefined ? MINIMAX_VIDEO_DURATION_DEFAULT : Number(rawDuration);
    if (
        !Number.isInteger(duration) ||
        duration < MINIMAX_VIDEO_DURATION_MIN ||
        duration > MINIMAX_VIDEO_DURATION_MAX
    ) {
        return {
            ok: false,
            error: `duration 必须是 ${MINIMAX_VIDEO_DURATION_MIN}–${MINIMAX_VIDEO_DURATION_MAX} 的整数秒`,
        };
    }

    const rawResolution = params["resolution"];
    const resolution: MinimaxVideoResolution =
        rawResolution === undefined ? MINIMAX_VIDEO_RESOLUTION_DEFAULT : (rawResolution as MinimaxVideoResolution);
    if (!isResolution(resolution)) {
        return {
            ok: false,
            error: `resolution 必须是 ${MINIMAX_VIDEO_RESOLUTIONS.join("/")} 之一`,
        };
    }

    const hasFirstFrame = Number.isInteger(input.assetId);
    let ratio: string;
    if (hasFirstFrame) {
        // 图生视频：宽高比由首帧图片决定，MiniMax 侧恒为 adaptive
        ratio = "adaptive";
    } else {
        const rawRatio = params["ratio"];
        ratio = rawRatio === undefined ? MINIMAX_VIDEO_RATIO_DEFAULT : String(rawRatio);
        if (!isRatio(ratio)) {
            return {
                ok: false,
                error: `ratio 必须是 ${MINIMAX_VIDEO_RATIOS.join("/")} 之一（文生视频）`,
            };
        }
    }

    const spec: MinimaxVideoSpec = { prompt, duration, resolution, ratio };
    if (hasFirstFrame) {
        spec.firstFrameAssetId = input.assetId as number;
    }
    return { ok: true, spec };
}

/** relay POST /video 的请求体（与 minimax-relay/server.py 的约定保持一致）。
 *
 * @param clientJobId 可选幂等键（Rin 传 `aistudio-<jobId>`），queue 重投时
 * relay 直接返回已有任务，避免向 MiniMax 重复提交扣费。
 */
export function buildRelaySubmitBody(
    spec: MinimaxVideoSpec,
    firstFrameUrl?: string,
    clientJobId?: string,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: MINIMAX_VIDEO_MODEL,
        prompt: spec.prompt,
        duration: spec.duration,
        resolution: spec.resolution,
        ratio: spec.ratio,
    };
    if (spec.firstFrameAssetId !== undefined && firstFrameUrl) {
        body["first_frame_url"] = firstFrameUrl;
    }
    if (clientJobId) {
        body["client_job_id"] = clientJobId;
    }
    return body;
}

export function relayFileUrl(relayUrl: string, relayJobId: string): string {
    return `${relayUrl}/video/${relayJobId}/file`;
}

export type RelayJobStatus = "queued" | "running" | "succeeded" | "failed" | "unknown";

/** 解析 relay GET /video/{id} 的 status 字段（未知值归一为 unknown）。 */
export function parseRelayJobStatus(value: unknown): RelayJobStatus {
    return value === "queued" ||
        value === "running" ||
        value === "succeeded" ||
        value === "failed"
        ? value
        : "unknown";
}

export interface RelaySubmitResult {
    ok: boolean;
    relayJobId?: string;
    error?: string;
}

/** 向 relay 提交视频生成任务（同步返回 relay job id，长任务由 relay 异步执行）。 */
export async function submitRelayVideoJob(
    config: MinimaxRelayConfig,
    body: Record<string, unknown>,
): Promise<RelaySubmitResult> {
    let resp: Response;
    try {
        resp = await fetch(`${config.url}/video`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.secret}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        return {
            ok: false,
            error: `中转服务连接失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    let raw: unknown = null;
    try {
        raw = await resp.json();
    } catch {
        // ignore: fall through
    }
    const respBody = (raw ?? {}) as {
        ok?: boolean;
        job_id?: string;
        error?: string;
        detail?: string;
    };
    const submitted = respBody.ok === true;
    const jobId = typeof respBody.job_id === "string" ? respBody.job_id : "";
    if (!resp.ok || !submitted || !jobId) {
        const detail = typeof respBody.detail === "string" && respBody.detail ? `（${respBody.detail}）` : "";
        const reason = typeof respBody.error === "string" && respBody.error ? respBody.error : `HTTP ${resp.status}`;
        return { ok: false, error: `提交失败：${reason}${detail}` };
    }
    return { ok: true, relayJobId: jobId };
}

export interface RelayJobQuery {
    status: RelayJobStatus;
    error?: string;
    bytes?: number;
    prompt?: string;
    duration?: number;
    resolution?: string;
    ratio?: string;
}

/** 查询 relay 侧任务状态（供 cron sweep 轮询）。 */
export async function queryRelayVideoJob(
    config: MinimaxRelayConfig,
    relayJobId: string,
): Promise<{ ok: true; job: RelayJobQuery } | { ok: false; error: string }> {
    let resp: Response;
    try {
        resp = await fetch(`${config.url}/video/${relayJobId}`, {
            headers: { Authorization: `Bearer ${config.secret}` },
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        return {
            ok: false,
            error: `中转服务连接失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (resp.status === 404) {
        return { ok: false, error: "中转侧任务不存在（可能已被清理）" };
    }
    let data: Record<string, unknown> | null = null;
    try {
        data = (await resp.json()) as Record<string, unknown>;
    } catch {
        // ignore
    }
    const okFlag = data !== null && data["ok"] === true;
    if (!resp.ok || !okFlag) {
        const err =
            data !== null && typeof data["error"] === "string" ? data["error"] : `HTTP ${resp.status}`;
        return { ok: false, error: `查询任务状态失败：${err}` };
    }
    const body: Record<string, unknown> = data ?? {};
    const status = parseRelayJobStatus(body["status"]);
    const job: RelayJobQuery = { status };
    if (typeof body["error"] === "string") job.error = body["error"];
    if (typeof body["bytes"] === "number") job.bytes = body["bytes"];
    if (typeof body["prompt"] === "string") job.prompt = body["prompt"];
    if (typeof body["duration"] === "number") job.duration = body["duration"];
    if (typeof body["resolution"] === "string") job.resolution = body["resolution"];
    if (typeof body["ratio"] === "string") job.ratio = body["ratio"];
    return { ok: true, job };
}
