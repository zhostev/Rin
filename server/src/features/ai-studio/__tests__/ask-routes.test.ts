import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Variables } from "../../../core/hono-types";
import { aiSettings } from "../../../db/schema";
import { AskService } from "../ask-routes";

type TestApp = Hono<{ Bindings: Env; Variables: Variables }>;

const VEC = Array.from({ length: 768 }, (_, i) => (i % 10) / 10);

interface AskBuildOptions {
    admin?: boolean;
    settings?: Record<string, string>;
    usageCount?: number;
    /** slug 解析结果：数字=命中，null=未命中，undefined=不配置 */
    slugHit?: number | null;
    /** loadStoryContent 返回的 story 行（null=不存在） */
    story?: any;
    blocks?: any[];
    matches?: Array<{ score: number; metadata: Record<string, any> }>;
}

function buildApp(options: AskBuildOptions = {}) {
    const app: TestApp = new Hono<{ Bindings: Env; Variables: Variables }>();
    const settingsRows = Object.entries(
        options.settings ?? { ai_enabled: "1", daily_call_quota: "200" },
    ).map(([key, value]) => ({ key, value }));

    const db: any = {
        select: () => ({
            from: (table: any) => {
                if (table === aiSettings) return Promise.resolve(settingsRows);
                return { where: async () => [{ n: options.usageCount ?? 0 }] };
            },
        }),
        query: {
            stories: {
                findFirst: async (args: any) => {
                    // findStoryIdBySlug 只取 id 列；loadStoryContent 取整行
                    if (args?.columns) {
                        return typeof options.slugHit === "number"
                            ? { id: options.slugHit }
                            : null;
                    }
                    return options.story ?? null;
                },
                findMany: async () => [{ id: 9, slug: "other-story", title: "Other" }],
            },
            contentBlocks: {
                findMany: async () => options.blocks ?? [],
            },
        },
        insert: () => ({ values: async () => ({}) }),
    };

    const env: any = {
        AI: { run: async () => ({ data: [VEC] }) },
        VECTORIZE: { query: async () => ({ matches: options.matches ?? [] }) },
    };

    app.use("*", async (c, next) => {
        c.set("db", db);
        c.set("admin", options.admin ?? true);
        c.set("env", env);
        await next();
    });
    app.route("/", AskService());
    return app;
}

const storyRow = {
    id: 7,
    slug: "hello-story",
    title: "Hello",
    summary: "summary",
    status: "published",
    verifiedAt: null,
};

const blocks = [
    { id: 1, type: "rich_text", position: 0, payloadJson: JSON.stringify({ text: "第一段正文" }) },
];

function matchMeta(over: Record<string, any> = {}) {
    return {
        score: 0.9,
        metadata: {
            storySlug: "other-story",
            storyId: 9,
            title: "Other",
            blockId: 3,
            kind: "block",
            text: "相关内容",
            url: "",
            ...over,
        },
    };
}

describe("GET /recommend", () => {
    it("accepts slug and resolves it to a story", async () => {
        const app = buildApp({
            slugHit: 7,
            story: storyRow,
            blocks,
            matches: [matchMeta()],
        });
        // stories.findMany for the picked story rows
        const res = await app.request("/recommend?slug=hello-story");
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.items).toHaveLength(1);
        expect(body.items[0].storySlug).toBe("other-story");
    });

    it("accepts storyId as before", async () => {
        const app = buildApp({ story: storyRow, blocks, matches: [matchMeta()] });
        const res = await app.request("/recommend?storyId=7");
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.items).toHaveLength(1);
    });

    it("prefers slug when both are given", async () => {
        const app = buildApp({
            slugHit: 7,
            story: { ...storyRow, id: 7 },
            blocks,
            matches: [matchMeta()],
        });
        const res = await app.request("/recommend?storyId=999&slug=hello-story");
        expect(res.status).toBe(200);
    });

    it("returns 404 for an unknown slug", async () => {
        const app = buildApp({ slugHit: null });
        const res = await app.request("/recommend?slug=nope");
        expect(res.status).toBe(404);
        expect(((await res.json()) as any).error.code).toBe("not_found");
    });

    it("returns 404 when the resolved story does not exist", async () => {
        const app = buildApp({ story: null });
        const res = await app.request("/recommend?storyId=999");
        expect(res.status).toBe(404);
    });

    it("returns 400 when neither storyId nor slug is given", async () => {
        const app = buildApp();
        const res = await app.request("/recommend");
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).error.code).toBe("invalid_story_ref");
    });

    it("returns 400 for a non-integer storyId", async () => {
        const app = buildApp();
        const res = await app.request("/recommend?storyId=abc");
        expect(res.status).toBe(400);
    });

    it("is guarded by ai_enabled", async () => {
        const app = buildApp({ settings: { ai_enabled: "0", daily_call_quota: "200" } });
        const res = await app.request("/recommend?storyId=7");
        expect(res.status).toBe(503);
    });

    it("returns 429 when the daily quota is used up", async () => {
        const app = buildApp({
            settings: { ai_enabled: "1", daily_call_quota: "1" },
            usageCount: 1,
        });
        const res = await app.request("/recommend?storyId=7");
        expect(res.status).toBe(429);
    });
});
