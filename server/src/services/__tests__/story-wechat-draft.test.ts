import { describe, expect, it, afterEach } from "bun:test";
import { Hono } from "hono";
import { extractStoryMarkdown, registerStoryWechatDraftRoutes } from "../story-wechat-draft";
import {
    pushWechatDraftRelay,
    resolveWechatRelayConfig,
} from "../feed-wechat-draft";

describe("extractStoryMarkdown", () => {
    it("keeps rich_text markdown verbatim and joins blocks", () => {
        const markdown = extractStoryMarkdown([
            { type: "rich_text", payloadJson: JSON.stringify({ markdown: "# 标题\n\n正文" }) },
            { type: "rich_text", payloadJson: JSON.stringify({ markdown: "第二段" }) },
        ]);
        expect(markdown).toBe("# 标题\n\n正文\n\n第二段");
    });

    it("turns gallery items with asset ids into playback image links", () => {
        const markdown = extractStoryMarkdown([
            {
                type: "gallery",
                payloadJson: JSON.stringify({
                    items: [
                        { id: 150, url: "", alt: "首图" },
                        { id: 0, url: "https://example.com/x.jpg", alt: "外链" },
                    ],
                }),
            },
        ]);
        expect(markdown).toContain("![首图](/api/media/150/playback)");
        expect(markdown).toContain("![外链](https://example.com/x.jpg)");
    });

    it("ignores unparseable payloads and non-text blocks", () => {
        const markdown = extractStoryMarkdown([
            { type: "rich_text", payloadJson: "not-json" },
            { type: "divider", payloadJson: JSON.stringify({}) },
        ]);
        expect(markdown).toBe("");
    });
});

describe("resolveWechatRelayConfig", () => {
    it("rejects missing config and invalid urls, accepts a trimmed url", () => {
        expect(resolveWechatRelayConfig({} as Env).ok).toBe(false);
        const invalid = resolveWechatRelayConfig({
            WECHAT_RELAY_URL: "not a url",
            WECHAT_RELAY_SECRET: "secret",
        } as Env);
        expect(invalid.ok).toBe(false);
        const ok = resolveWechatRelayConfig({
            WECHAT_RELAY_URL: "https://relay.example.com/",
            WECHAT_RELAY_SECRET: "secret",
        } as Env);
        expect(ok).toEqual({
            ok: true,
            relayUrl: "https://relay.example.com",
            relaySecret: "secret",
        });
    });
});

describe("pushWechatDraftRelay (mocked fetch, never the real relay)", () => {
    const input = {
        relayUrl: "https://relay.example.com",
        relaySecret: "secret",
        title: "山海骑行",
        digest: "摘要",
        contentMarkdown: "正文",
        siteBaseUrl: "https://s7ea.com",
        articleUrl: "https://s7ea.com/story/shanhai-qixing",
    };

    it("returns the draft media id on success and posts the story url", async () => {
        const seen: { url: string; body: string }[] = [];
        const result = await pushWechatDraftRelay(input, (async (url: string, init: any) => {
            seen.push({ url, body: String(init.body) });
            return new Response(JSON.stringify({ ok: true, draft_media_id: "mid-1" }), {
                status: 200,
            });
        }) as any);
        expect(result).toEqual({ ok: true, draft_media_id: "mid-1" });
        expect(seen[0].url).toBe("https://relay.example.com/push-draft");
        expect(seen[0].body).toContain("/story/shanhai-qixing");
    });

    it("surfaces relay errors and connection failures as messages", async () => {
        const relayError = await pushWechatDraftRelay(input, (async () =>
            new Response(JSON.stringify({ ok: false, error: "no appid" }), {
                status: 400,
            })) as any);
        expect(relayError).toEqual({ ok: false, message: "推送失败：no appid" });

        const connError = await pushWechatDraftRelay(input, (async () => {
            throw new Error("boom");
        }) as any);
        expect(connError).toEqual({ ok: false, message: "中转服务连接失败：boom" });
    });
});

describe("POST /admin/stories/:id/wechat-draft (route, mocked fetch)", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function buildApp(options: {
        admin: boolean;
        story?: unknown;
        relay?: { url?: string; secret?: string };
    }) {
        const app = new Hono<any>();
        app.use("*", async (c, next) => {
            c.set("db", {
                query: {
                    stories: { findFirst: async () => options.story ?? null },
                },
            });
            c.set("admin", options.admin);
            c.set("env", {
                WECHAT_RELAY_URL: options.relay?.url ?? "https://relay.example.com",
                WECHAT_RELAY_SECRET: options.relay?.secret ?? "secret",
            });
            await next();
        });
        registerStoryWechatDraftRoutes(app as any);
        return app;
    }

    const story = {
        id: 2,
        slug: "shanhai-qixing",
        title: "山海骑行",
        summary: "摘要",
        blocks: [{ type: "rich_text", payloadJson: JSON.stringify({ markdown: "正文" }) }],
    };

    it("rejects a non-admin (same default guard as the feed wechat route)", async () => {
        const res = await buildApp({ admin: false, story }).request("/2/wechat-draft", {
            method: "POST",
        });
        expect(res.status).toBe(401);
    });

    it("returns 404 for a missing story and 400 when unconfigured", async () => {
        const missing = await buildApp({ admin: true, story: null }).request("/9/wechat-draft", {
            method: "POST",
        });
        expect(missing.status).toBe(404);

        const unconfigured = await buildApp({
            admin: true,
            story,
            relay: { url: "", secret: "" },
        }).request("/2/wechat-draft", { method: "POST" });
        expect(unconfigured.status).toBe(400);
    });

    it("returns the draft media id on relay success", async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ ok: true, draft_media_id: "mid-9" }), {
                status: 200,
            })) as any;
        const res = await buildApp({ admin: true, story }).request("/2/wechat-draft", {
            method: "POST",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { draft_media_id: string };
        expect(body).toEqual({ draft_media_id: "mid-9" });
    });
});
