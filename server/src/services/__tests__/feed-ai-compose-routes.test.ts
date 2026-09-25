import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { registerFeedAIComposeRoutes } from "../feed-ai-compose";

type Row = Record<string, unknown>;

function buildApp(options: {
  admin: boolean;
  uid?: number;
  assets?: Row[];
  writerEnabled?: boolean;
  inserted?: { id: number; updatedAt: Date };
  feed?: Row | null;
  onSend?: (task: unknown) => void;
  aiBinding?: boolean;
}) {
  const app = new Hono<any>();
  const inserted = options.inserted ?? { id: 42, updatedAt: new Date("2026-09-22T00:00:00.000Z") };

  const db = {
    query: {
      mediaAssets: { findMany: async () => options.assets ?? [] },
      feeds: { findFirst: async () => options.feed ?? null },
    },
    insert: () => ({
      values: () => ({ returning: async () => [inserted] }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("admin", options.admin);
    c.set("uid", options.uid ?? 1);
    c.set("env", {
      TASK_QUEUE: { send: async (task: unknown) => options.onSend?.(task) },
      ...(options.aiBinding ? { AI: { run: async () => new ArrayBuffer(8) } } : {}),
    });
    c.set("serverConfig", {
      get: async (key: string) =>
        key === "ai_writer.enabled" ? (options.writerEnabled ?? true) : undefined,
    });
    await next();
  });

  registerFeedAIComposeRoutes(app as any);
  return app;
}

const body = { topic: "聊聊本地优先软件", assets: [] };

describe("POST /ai-compose", () => {
  it("rejects a non-admin", async () => {
    const res = await buildApp({ admin: false }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(403);
  });

  it("rejects an empty topic", async () => {
    const res = await buildApp({ admin: true }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify({ topic: "", assets: [] }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown asset id", async () => {
    const res = await buildApp({ admin: true, assets: [] }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify({ topic: "选题", assets: [{ id: "nope", note: "" }] }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  it("refuses when the writer is disabled", async () => {
    const res = await buildApp({ admin: true, writerEnabled: false }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  it("queues the task and returns the placeholder id", async () => {
    const sent: unknown[] = [];
    const res = await buildApp({ admin: true, onSend: (task) => sent.push(task) }).request(
      "/ai-compose",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );

    expect(res.status).toBe(202);
    expect(await res.json() as any).toEqual({ id: 42, status: "pending" });
    expect(sent.length).toBe(1);
  });

  it("normalizes an unrecognized length rather than failing", async () => {
    const sent: any[] = [];
    const res = await buildApp({ admin: true, onSend: (task) => sent.push(task) }).request(
      "/ai-compose",
      {
        method: "POST",
        body: JSON.stringify({ ...body, length: "enormous" }),
        headers: { "Content-Type": "application/json" },
      },
    );

    expect(res.status).toBe(202);
    expect(sent[0].payload.length).toBe("medium");
  });

  it("marks the placeholder failed and returns 500 when enqueueing fails", async () => {
    const res = await buildApp({
      admin: true,
      onSend: () => {
        throw new Error("queue unavailable");
      },
    }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(500);
  });

  it("rejects image search when no Pexels API key is configured", async () => {
    const res = await buildApp({ admin: true }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify({ ...body, imageMode: "search", imageCount: 2 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  it("rejects image generation when the Workers AI binding is missing", async () => {
    const res = await buildApp({ admin: true }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify({ ...body, imageMode: "generate", imageCount: 2 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  it("passes image mode and count through to the queued task", async () => {
    const sent: any[] = [];
    const res = await buildApp({ admin: true, aiBinding: true, onSend: (task) => sent.push(task) }).request(
      "/ai-compose",
      {
        method: "POST",
        body: JSON.stringify({ ...body, imageMode: "generate", imageCount: 9 }),
        headers: { "Content-Type": "application/json" },
      },
    );

    expect(res.status).toBe(202);
    expect(sent[0].payload.imageMode).toBe("generate");
    expect(sent[0].payload.imageCount).toBe(3);
  });

  it("defaults the image mode to none", async () => {
    const sent: any[] = [];
    const res = await buildApp({ admin: true, onSend: (task) => sent.push(task) }).request(
      "/ai-compose",
      {
        method: "POST",
        body: JSON.stringify({ ...body, imageMode: "dall-e" }),
        headers: { "Content-Type": "application/json" },
      },
    );

    expect(res.status).toBe(202);
    expect(sent[0].payload.imageMode).toBe("none");
  });
});

describe("GET /:id/ai-compose-status", () => {
  it("rejects a non-admin", async () => {
    const res = await buildApp({ admin: false }).request("/42/ai-compose-status");
    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing feed", async () => {
    const res = await buildApp({ admin: true, feed: null }).request("/42/ai-compose-status");
    expect(res.status).toBe(404);
  });

  it("returns the stored status and error", async () => {
    const app = buildApp({
      admin: true,
      feed: { aiComposeStatus: "failed", aiComposeError: "AI 返回了空响应" },
    });

    const res = await app.request("/42/ai-compose-status");

    expect(res.status).toBe(200);
    expect(await res.json() as any).toEqual({ status: "failed", error: "AI 返回了空响应" });
  });
});
