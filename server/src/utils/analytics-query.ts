export const ANALYTICS_DATASET = "rin_analytics";

/**
 * Analytics Engine 不可用（未配置 / 请求失败）时抛出。
 * 调用方一律降级为 available:false，不得转成 HTTP 500。
 */
export class AnalyticsUnavailableError extends Error {
    readonly reason: "unconfigured" | "request_failed";

    constructor(reason: "unconfigured" | "request_failed", message: string) {
        super(message);
        this.name = "AnalyticsUnavailableError";
        this.reason = reason;
    }
}

export function isAnalyticsQueryConfigured(env: Env): boolean {
    return Boolean((env.CLOUDFLARE_ACCOUNT_ID || "").trim() && (env.CLOUDFLARE_API_TOKEN || "").trim());
}

export function analyticsSqlEndpoint(accountId: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
}

/**
 * AE 没有读取绑定，查询只能走 HTTP SQL API。
 * token 需要 `Account | Account Analytics | Read` 权限。
 */
export async function queryAnalyticsEngine<T>(env: Env, sql: string): Promise<T[]> {
    if (!isAnalyticsQueryConfigured(env)) {
        throw new AnalyticsUnavailableError(
            "unconfigured",
            "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required to query Analytics Engine",
        );
    }

    const accountId = (env.CLOUDFLARE_ACCOUNT_ID || "").trim();
    let response: Response;

    try {
        response = await fetch(analyticsSqlEndpoint(accountId), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${(env.CLOUDFLARE_API_TOKEN || "").trim()}`,
                "Content-Type": "text/plain",
            },
            body: sql,
        });
    } catch (error) {
        throw new AnalyticsUnavailableError("request_failed", `Analytics Engine request failed: ${error}`);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AnalyticsUnavailableError(
            "request_failed",
            `Analytics Engine returned ${response.status}: ${body.slice(0, 200)}`,
        );
    }

    const payload = (await response.json()) as { data?: T[] };
    return payload.data ?? [];
}
