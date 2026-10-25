import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { registerStoryAIRoutes } from "../story-ai";

// Route-guard tests only: they stop before any model call, so no provider
// credentials or network are involved. Generation itself is covered by the
// pure prompt tests in story-ai.test.ts, mirroring feed-ai-revise.test.ts.

function buildApp(options: {
    admin: boolean;
    story?: unknown;
    writerEnabled?: boolean;
}) {
    const app = new Hono<any>();
    app.use("*", async (c, next) => {
        c.set("db", {
            query: {
                stories: { findFirst: async () => options.story ?? null },
            },
        });
        c.set("admin", options.admin);
        c.set("env", {});
        c.set("serverConfig", {
            get: async (key: string) =>
                key === "ai_writer.enabled" ? (options.writerEnabled ?? true) : undefined,
        });
        await next();
    });
    registerStoryAIRoutes(app as any);
    return app;
}

const story = { id: 2, slug: "shanhai-qixing", title: "山海骑行", summary: "", blocks: [] };

function post(app: Hono<any>, path: string, body: unknown) {
    return app.request(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
    });
}

describe("POST /admin/stories/:id/ai-compose", () => {
    it("rejects a non-admin", async () => {
        const res = await post(buildApp({ admin: false, story }), "/2/ai-compose", {
            topic: "山海骑行",
        });
        expect(res.status).toBe(403);
    });

    it("returns 404 for a missing story", async () => {
        const res = await post(buildApp({ admin: true, story: null }), "/9/ai-compose", {
            topic: "山海骑行",
        });
        expect(res.status).toBe(404);
    });

    it("requires a topic or source text, and a writer-enabled config", async () => {
        const empty = await post(buildApp({ admin: true, story }), "/2/ai-compose", {
            topic: "",
        });
        expect(empty.status).toBe(400);

        const disabled = await post(
            buildApp({ admin: true, story, writerEnabled: false }),
            "/2/ai-compose",
            { topic: "山海骑行" },
        );
        expect(disabled.status).toBe(400);
    });
});

describe("POST /admin/stories/:id/ai-revise", () => {
    it("rejects a non-admin and a missing story", async () => {
        const nonAdmin = await post(buildApp({ admin: false, story }), "/2/ai-revise", {
            mode: "polish",
            content: "原文",
        });
        expect(nonAdmin.status).toBe(403);

        const missing = await post(buildApp({ admin: true, story: null }), "/9/ai-revise", {
            mode: "polish",
            content: "原文",
        });
        expect(missing.status).toBe(404);
    });

    it("rejects unknown modes and custom mode without an instruction", async () => {
        const unknown = await post(buildApp({ admin: true, story }), "/2/ai-revise", {
            mode: "rewrite",
            content: "原文",
        });
        expect(unknown.status).toBe(400);

        const customEmpty = await post(buildApp({ admin: true, story }), "/2/ai-revise", {
            mode: "custom",
            content: "原文",
        });
        expect(customEmpty.status).toBe(400);
    });
});
