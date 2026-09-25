/**
 * Covers processFeedAIComposeTask's real-database path.
 *
 * feed-ai-compose.test.ts (the sibling in this directory) only exercises the
 * pure decision helpers (decideComposeOutcome, normalizeComposeLength). This
 * file drives the consumer itself against a real SQLite database with a
 * stubbed HTTP provider, which is the only coverage of the publish/draft
 * write path, the media/tag binding, and the publish safety gate's early
 * returns (writer disabled, missing media asset, stale updatedAt).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createMockDB, createMockEnv, createTestUser, TestCacheImpl } from "../../../tests/fixtures";
import { applyMediaMigration } from "../../../tests/fixtures/media";
import { feedHashtags, feeds, hashtags, mediaAssets } from "../../db/schema";
import { clearFeedCache } from "../clear-feed-cache";
import { processFeedAIComposeTask, resolveVisionAssetRows } from "../feed-ai-compose";

const ARTICLE = [
  "---",
  "title: 本地优先软件的取舍",
  "summary: 一句话摘要",
  "tags: 软件, 架构",
  "---",
  "",
  "开头段落。".repeat(20),
  "",
  "[[media:1]]",
  "",
  "中间段落。".repeat(20),
].join("\n");

function serverConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    "ai_summary.enabled": false,
    "ai_summary.provider": "openai",
    "ai_summary.model": "gpt-4o-mini",
    "ai_summary.api_key": "sk-stub",
    "ai_summary.api_url": "https://stub.invalid/v1",
    "ai_writer.enabled": true,
    ...overrides,
  };
  return { get: async (key: string) => values[key] };
}

describe("compose consumer end-to-end against real SQLite", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("publishes a generated article with media and tags bound", async () => {
    const { db, sqlite } = createMockDB() as any;
    createTestUser(sqlite);

    // createMockDB 的 media_assets 仍是 Stage 1 旧表结构（见 tests/fixtures），
    // 按真实迁移重建，loadComposeAssets 才能按现行 schema 查到资产。
    sqlite.exec("DROP TABLE IF EXISTS media_assets");
    applyMediaMigration(sqlite);

    const [assetRow] = await db
      .insert(mediaAssets)
      .values({
        kind: "image",
        source: "r2",
        r2Key: "media/1/img-e2e.jpg",
        mime: "image/jpeg",
      })
      .returning({ id: mediaAssets.id });
    const assetId = assetRow.id;

    const now = new Date();
    const inserted = await db
      .insert(feeds)
      .values({
        title: "聊聊本地优先软件",
        content: "",
        summary: "",
        ai_summary: "",
        ai_summary_status: "idle",
        ai_summary_error: "",
        aiComposeStatus: "pending",
        aiComposeError: "",
        uid: 1,
        alias: null,
        listed: 1,
        draft: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: feeds.id, updatedAt: feeds.updatedAt });

    const feedId = inserted[0].id;
    const expectedUpdatedAtUnix = Math.floor(inserted[0].updatedAt.getTime() / 1000);

    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: ARTICLE } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await processFeedAIComposeTask(
      createMockEnv(),
      db,
      new TestCacheImpl() as any,
      serverConfig(),
      {
        feedId,
        expectedUpdatedAtUnix,
        topic: "聊聊本地优先软件",
        assets: [{ id: String(assetId), note: "架构示意图" }],
        length: "medium",
        listed: true,
        imageMode: "none",
        imageCount: 2,
      visionAssets: [],
      },
      clearFeedCache,
    );

    const row = await db.query.feeds.findFirst({ where: eq(feeds.id, feedId) });

    // Published, not left as a draft.
    expect(row.aiComposeStatus).toBe("completed");
    expect(row.aiComposeError).toBe("");
    expect(row.draft).toBe(0);
    expect(row.listed).toBe(1);

    // Front-matter parsed into real columns.
    expect(row.title).toBe("本地优先软件的取舍");
    expect(row.summary).toBe("一句话摘要");

    // Placeholder replaced with real markup; no residue left in a public article.
    expect(row.content).not.toContain("[[media:1]]");
    expect(row.content).toContain(`![架构示意图](/api/media/${assetId}/playback)`);

    // The prompt showed the model the token, never the real asset id.
    const userMessage = capturedBody.messages[1].content;
    expect(userMessage).toContain("[[media:1]]");
    // 提示词里只有占位符 token，没有渲染后的真实引用链接。
    expect(userMessage).not.toContain(`/api/media/${assetId}/playback`);

    // Tags bound through the real relation tables.
    const boundTags = await db
      .select({ name: hashtags.name })
      .from(feedHashtags)
      .innerJoin(hashtags, eq(feedHashtags.hashtagId, hashtags.id))
      .where(eq(feedHashtags.feedId, feedId));
    expect(boundTags.map((t: any) => t.name).sort()).toEqual(["架构", "软件"]);

    // 资产按现行 schema 可解析：loadComposeAssets 用它生成了上面的 playback 链接。
    // （旧 syncMediaForFeed 的「资产↔文章行级绑定」已随 Stage 1 媒体模型下线，
    // 现行模型只在渲染时引用资产 id。）
    const asset = await db.query.mediaAssets.findFirst({
      where: eq(mediaAssets.id, assetId),
    });
    expect(asset?.kind).toBe("image");
    expect(asset?.r2Key).toBe("media/1/img-e2e.jpg");
  });

  it("stops at draft when the model returns something unusable", async () => {
    const { db, sqlite } = createMockDB() as any;
    createTestUser(sqlite);

    const now = new Date();
    const inserted = await db
      .insert(feeds)
      .values({
        title: "选题",
        content: "",
        summary: "",
        ai_summary: "",
        ai_summary_status: "idle",
        ai_summary_error: "",
        aiComposeStatus: "pending",
        aiComposeError: "",
        uid: 1,
        alias: null,
        listed: 1,
        draft: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: feeds.id, updatedAt: feeds.updatedAt });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "太短" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await processFeedAIComposeTask(
      createMockEnv(),
      db,
      new TestCacheImpl() as any,
      serverConfig(),
      {
        feedId: inserted[0].id,
        expectedUpdatedAtUnix: Math.floor(inserted[0].updatedAt.getTime() / 1000),
        topic: "选题",
        assets: [],
        length: "short",
        listed: true,
        imageMode: "none",
        imageCount: 2,
      visionAssets: [],
      },
      clearFeedCache,
    );

    const row = await db.query.feeds.findFirst({ where: eq(feeds.id, inserted[0].id) });
    expect(row.aiComposeStatus).toBe("failed");
    expect(row.aiComposeError.length).toBeGreaterThan(0);
    expect(row.draft).toBe(1);
  });

  it("abandons without writing when the article was edited during generation", async () => {
    const { db, sqlite } = createMockDB() as any;
    createTestUser(sqlite);

    const now = new Date();
    const inserted = await db
      .insert(feeds)
      .values({
        title: "人工改过的标题",
        content: "人工写的正文",
        summary: "",
        ai_summary: "",
        ai_summary_status: "idle",
        ai_summary_error: "",
        aiComposeStatus: "pending",
        aiComposeError: "",
        uid: 1,
        alias: null,
        listed: 1,
        draft: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: feeds.id, updatedAt: feeds.updatedAt });

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await processFeedAIComposeTask(
      createMockEnv(),
      db,
      new TestCacheImpl() as any,
      serverConfig(),
      {
        feedId: inserted[0].id,
        // Deliberately stale: simulates an admin edit after the task was queued.
        expectedUpdatedAtUnix: Math.floor(inserted[0].updatedAt.getTime() / 1000) - 60,
        topic: "选题",
        assets: [],
        length: "short",
        listed: true,
        imageMode: "none",
        imageCount: 2,
      visionAssets: [],
      },
      clearFeedCache,
    );

    const row = await db.query.feeds.findFirst({ where: eq(feeds.id, inserted[0].id) });
    expect(called).toBe(false);
    expect(row.title).toBe("人工改过的标题");
    expect(row.content).toBe("人工写的正文");
    expect(row.draft).toBe(1);
    expect(row.aiComposeStatus).toBe("pending");
  });

  it("fails the row when the AI writer is disabled", async () => {
    const { db, sqlite } = createMockDB() as any;
    createTestUser(sqlite);

    const now = new Date();
    const inserted = await db
      .insert(feeds)
      .values({
        title: "选题",
        content: "",
        summary: "",
        ai_summary: "",
        ai_summary_status: "idle",
        ai_summary_error: "",
        aiComposeStatus: "pending",
        aiComposeError: "",
        uid: 1,
        alias: null,
        listed: 1,
        draft: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: feeds.id, updatedAt: feeds.updatedAt });

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await processFeedAIComposeTask(
      createMockEnv(),
      db,
      new TestCacheImpl() as any,
      serverConfig({ "ai_writer.enabled": false }),
      {
        feedId: inserted[0].id,
        expectedUpdatedAtUnix: Math.floor(inserted[0].updatedAt.getTime() / 1000),
        topic: "选题",
        assets: [],
        length: "short",
        listed: true,
        imageMode: "none",
        imageCount: 2,
      visionAssets: [],
      },
      clearFeedCache,
    );

    const row = await db.query.feeds.findFirst({ where: eq(feeds.id, inserted[0].id) });
    expect(called).toBe(false);
    expect(row.aiComposeStatus).toBe("failed");
    expect(row.aiComposeError).toBe("AI 写作功能未启用");
    expect(row.draft).toBe(1);
  });

  it("fails the row when a referenced media asset does not exist", async () => {
    const { db, sqlite } = createMockDB() as any;
    createTestUser(sqlite);

    const now = new Date();
    const inserted = await db
      .insert(feeds)
      .values({
        title: "选题",
        content: "",
        summary: "",
        ai_summary: "",
        ai_summary_status: "idle",
        ai_summary_error: "",
        aiComposeStatus: "pending",
        aiComposeError: "",
        uid: 1,
        alias: null,
        listed: 1,
        draft: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: feeds.id, updatedAt: feeds.updatedAt });

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await processFeedAIComposeTask(
      createMockEnv(),
      db,
      new TestCacheImpl() as any,
      serverConfig(),
      {
        feedId: inserted[0].id,
        expectedUpdatedAtUnix: Math.floor(inserted[0].updatedAt.getTime() / 1000),
        topic: "选题",
        assets: [{ id: "missing-asset", note: "" }],
        length: "short",
        listed: true,
        imageMode: "none",
        imageCount: 2,
      visionAssets: [],
      },
      clearFeedCache,
    );

    const row = await db.query.feeds.findFirst({ where: eq(feeds.id, inserted[0].id) });
    expect(called).toBe(false);
    expect(row.aiComposeStatus).toBe("failed");
    expect(row.aiComposeError).toContain("missing-asset");
    expect(row.draft).toBe(1);
  });
});

describe("resolveVisionAssetRows", () => {
  const stubDb = (rows: any[]) =>
    ({
      query: { mediaAssets: { findMany: async () => rows } },
    }) as any;

  const imageRow = (overrides: Record<string, unknown> = {}) => ({
    id: 11,
    kind: "image",
    source: "r2",
    r2Key: "media/11/shot.png",
    mime: "image/png",
    ...overrides,
  });

  it("accepts image assets and passes the note through", async () => {
    const result = await resolveVisionAssetRows(stubDb([imageRow()]), [
      { id: "11", note: "登录页截图" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.items[0].row.id).toBe(11);
      expect(result.items[0].note).toBe("登录页截图");
    }
  });

  it("rejects more than 5 screenshots", async () => {
    const result = await resolveVisionAssetRows(
      stubDb([]),
      Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1) })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("5");
  });

  it("rejects non-numeric ids", async () => {
    const result = await resolveVisionAssetRows(stubDb([]), [{ id: "abc" }]);
    expect(result.ok).toBe(false);
  });

  it("rejects missing assets", async () => {
    const result = await resolveVisionAssetRows(stubDb([]), [{ id: "99" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("99");
  });

  it("rejects non-image assets", async () => {
    const result = await resolveVisionAssetRows(stubDb([imageRow({ kind: "video" })]), [{ id: "11" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("必须是图片");
  });

  it("rejects assets without an R2 object", async () => {
    const result = await resolveVisionAssetRows(stubDb([imageRow({ r2Key: null })]), [{ id: "11" }]);
    expect(result.ok).toBe(false);
  });
});

describe("compose consumer with screenshots (截图生文）", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const VISION_ARTICLE = [
    "---",
    "title: 从截图看这次发布",
    "summary: 截图里是一次版本发布记录。",
    "tags: 发布, 截图",
    "---",
    "",
    "正文段落。".repeat(30),
    "",
    "[[media:1]]",
    "",
    "结尾段落。".repeat(30),
  ].join("\n");

  it("reads screenshots through the vision model and embeds them", async () => {
    const { db, sqlite } = createMockDB() as any;
    createTestUser(sqlite);
    sqlite.exec("DROP TABLE IF EXISTS media_assets");
    applyMediaMigration(sqlite);

    const [shotRow] = await db
      .insert(mediaAssets)
      .values({ kind: "image", source: "r2", r2Key: "media/7/shot.png", mime: "image/png" })
      .returning({ id: mediaAssets.id });
    const shotId = shotRow.id;

    const now = new Date();
    const [feedRow] = await db
      .insert(feeds)
      .values({
        title: "截图生文",
        content: "",
        summary: "",
        ai_summary: "",
        ai_summary_status: "idle",
        ai_summary_error: "",
        aiComposeStatus: "pending",
        aiComposeError: "",
        uid: 1,
        alias: null,
        listed: 1,
        draft: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: feeds.id, updatedAt: feeds.updatedAt });

    // 1x1 PNG 的最小字节：内容不重要，loadVisionImages 只做传输不断言解码。
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
    ]);

    let capturedVisionBody: any;
    globalThis.fetch = (async (url: any, init: any) => {
      const urlString = String(url);
      if (urlString.includes("/chat/completions")) {
        capturedVisionBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: VISION_ARTICLE } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // presigned R2 GET：返回截图字节。
      return new Response(pngBytes, { status: 200 });
    }) as typeof fetch;

    await processFeedAIComposeTask(
      createMockEnv(),
      db,
      new TestCacheImpl() as any,
      serverConfig(),
      {
        feedId: feedRow.id,
        expectedUpdatedAtUnix: Math.floor(feedRow.updatedAt.getTime() / 1000),
        topic: "",
        assets: [],
        visionAssets: [{ id: String(shotId), note: "发布记录截图" }],
        length: "medium",
        listed: true,
        imageMode: "none",
        imageCount: 2,
      },
      clearFeedCache,
    );

    const row = await db.query.feeds.findFirst({ where: eq(feeds.id, feedRow.id) });
    expect(row.aiComposeStatus).toBe("completed");
    expect(row.draft).toBe(0);
    expect(row.title).toBe("从截图看这次发布");
    // 截图进了素材清单并被渲染进正文。
    expect(row.content).not.toContain("[[media:1]]");
    expect(row.content).toContain(`![发布记录截图](/api/media/${shotId}/playback)`);

    // 视觉请求：图片块在前、文本在后；选题为空时给了默认写作指令。
    const userContent = capturedVisionBody.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent[0].type).toBe("image_url");
    expect(userContent[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(userContent[1].type).toBe("text");
    expect(userContent[1].text).toContain("截图");
  });
});
