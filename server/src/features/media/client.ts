/**
 * Stage 2 · 媒体栈 Cloudflare API 公共基础。
 *
 * 凭据现实：当前 Cloudflare 凭据没有 Stream/Images 权限（API 返回 403）。
 * 所有调用走环境变量读取 token；缺失时抛 NotConfiguredError（路由层转 503），
 * 绝不崩溃。API 侧错误统一抛 CloudflareApiError（路由层转 502 + 错误码）。
 */

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** 服务端未配置凭据：路由层应返回 503 + stream_not_configured / images_not_configured */
export class MediaNotConfiguredError extends Error {
    readonly code: "stream_not_configured" | "images_not_configured";
    constructor(code: MediaNotConfiguredError["code"], message: string) {
        super(message);
        this.name = "MediaNotConfiguredError";
        this.code = code;
    }
}

/** Cloudflare API 返回的非 2xx / success=false：路由层应返回 502 + 清晰错误码 */
export class CloudflareApiError extends Error {
    readonly status: number;
    readonly apiCode: string | number | null;
    readonly apiMessages: string[];
    constructor(message: string, options: {
        status: number;
        apiCode?: string | number | null;
        apiMessages?: string[];
    }) {
        super(message);
        this.name = "CloudflareApiError";
        this.status = options.status;
        this.apiCode = options.apiCode ?? null;
        this.apiMessages = options.apiMessages ?? [];
    }
}

interface CfEnvelope<T> {
    success: boolean;
    errors: Array<{ code: number; message: string }>;
    messages: Array<{ code: number; message: string }>;
    result: T;
}

export interface CfClientOptions {
    accountId: string;
    token: string;
    /** 允许注入 fetch（测试用 mock；生产默认 global fetch） */
    fetchImpl?: typeof fetch;
    /** 日志前缀，如 "stream" / "images" */
    serviceName: string;
}

/** 解析 Cloudflare envelope；success=false 或 HTTP 非 2xx 时抛结构化异常。 */
export async function cfRequest<T>(
    options: CfClientOptions,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
): Promise<T> {
    const { accountId: _accountId, token, fetchImpl = fetch, serviceName } = options;
    void _accountId;
    const url = `${CLOUDFLARE_API_BASE}${path}`;

    // 空对象 body（如 direct_upload 无参调用）按无 body 发送：
    // Cloudflare 部分接口对 "{}" JSON 体返回 415。
    const isEmptyBody = body === undefined
        || (typeof body === "object" && body !== null && Object.keys(body).length === 0);
    const payload = isEmptyBody ? undefined : JSON.stringify(body);

    let response: Response;
    try {
        response = await fetchImpl(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: payload,
        });
    } catch (error) {
        // 网络层失败（DNS/超时/连接拒绝）：不抛裸异常
        throw new CloudflareApiError(
            `${serviceName} request failed: ${error instanceof Error ? error.message : String(error)}`,
            { status: 0, apiMessages: [String(error)] },
        );
    }

    let envelope: CfEnvelope<T> | null = null;
    try {
        envelope = (await response.json()) as CfEnvelope<T>;
    } catch {
        throw new CloudflareApiError(
            `${serviceName} returned non-JSON response (HTTP ${response.status})`,
            { status: response.status },
        );
    }

    if (!response.ok || !envelope.success) {
        const messages = (envelope.errors ?? []).map((e) => e.message).filter(Boolean);
        const apiCode = envelope.errors?.[0]?.code ?? null;
        const hint = response.status === 403
            ? " (token 缺少该服务权限或未开通，请检查 Cloudflare 账户侧配置)"
            : "";
        throw new CloudflareApiError(
            `${serviceName} API error (HTTP ${response.status})${hint}: ${messages.join("; ") || response.statusText}`,
            { status: response.status, apiCode, apiMessages: messages },
        );
    }

    return envelope.result;
}

/** 从 env 解析账户 ID；缺失时抛 MediaNotConfiguredError（路由层转 503）。 */
export function requireAccountId(
    env: Env,
    code: MediaNotConfiguredError["code"] = "stream_not_configured",
): string {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!accountId) {
        throw new MediaNotConfiguredError(code, "CLOUDFLARE_ACCOUNT_ID is not set");
    }
    return accountId;
}
