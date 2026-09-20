import { afterEach, describe, expect, it } from "bun:test";
import {
    AnalyticsUnavailableError,
    analyticsSqlEndpoint,
    isAnalyticsQueryConfigured,
    queryAnalyticsEngine,
} from "../analytics-query";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function env(overrides: Record<string, unknown> = {}) {
    return {
        CLOUDFLARE_ACCOUNT_ID: "acct-123",
        CLOUDFLARE_API_TOKEN: "token-abc",
        ...overrides,
    } as unknown as Env;
}

describe("isAnalyticsQueryConfigured", () => {
    it("requires both account id and token", () => {
        expect(isAnalyticsQueryConfigured(env())).toBe(true);
        expect(isAnalyticsQueryConfigured(env({ CLOUDFLARE_API_TOKEN: "" }))).toBe(false);
        expect(isAnalyticsQueryConfigured(env({ CLOUDFLARE_ACCOUNT_ID: undefined }))).toBe(false);
        expect(isAnalyticsQueryConfigured(env({ CLOUDFLARE_ACCOUNT_ID: "   " }))).toBe(false);
    });
});

describe("analyticsSqlEndpoint", () => {
    it("builds the documented SQL API url", () => {
        expect(analyticsSqlEndpoint("acct-123")).toBe(
            "https://api.cloudflare.com/client/v4/accounts/acct-123/analytics_engine/sql",
        );
    });
});

describe("queryAnalyticsEngine", () => {
    it("throws an unconfigured error when the token is missing", async () => {
        const promise = queryAnalyticsEngine(env({ CLOUDFLARE_API_TOKEN: "" }), "SELECT 1");
        await expect(promise).rejects.toBeInstanceOf(AnalyticsUnavailableError);
        await promise.catch((error: AnalyticsUnavailableError) => {
            expect(error.reason).toBe("unconfigured");
        });
    });

    it("posts the sql with a bearer token and returns the data rows", async () => {
        let seenUrl = "";
        let seenInit: RequestInit | undefined;

        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            seenUrl = url;
            seenInit = init;
            return new Response(JSON.stringify({ data: [{ pv: 3 }], rows: 1 }), { status: 200 });
        }) as unknown as typeof fetch;

        const rows = await queryAnalyticsEngine<{ pv: number }>(env(), "SELECT 1");

        expect(rows).toEqual([{ pv: 3 }]);
        expect(seenUrl).toBe(analyticsSqlEndpoint("acct-123"));
        expect(seenInit?.method).toBe("POST");
        expect(seenInit?.body).toBe("SELECT 1");
        expect((seenInit?.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
    });

    it("throws a request_failed error on a non-200 response", async () => {
        globalThis.fetch = (async () =>
            new Response("Authentication error", { status: 403 })) as unknown as typeof fetch;

        const promise = queryAnalyticsEngine(env(), "SELECT 1");
        await expect(promise).rejects.toBeInstanceOf(AnalyticsUnavailableError);
        await promise.catch((error: AnalyticsUnavailableError) => {
            expect(error.reason).toBe("request_failed");
        });
    });

    it("throws a request_failed error when fetch itself rejects", async () => {
        globalThis.fetch = (async () => {
            throw new Error("network down");
        }) as unknown as typeof fetch;

        await expect(queryAnalyticsEngine(env(), "SELECT 1")).rejects.toBeInstanceOf(
            AnalyticsUnavailableError,
        );
    });

    it("returns an empty array when the response has no data field", async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ rows: 0 }), { status: 200 })) as unknown as typeof fetch;

        expect(await queryAnalyticsEngine(env(), "SELECT 1")).toEqual([]);
    });
});
