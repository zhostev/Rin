import { feedAIComposeSchema } from "@rin/api";
import type { ComposeLength, CreateAIComposeRequest } from "@rin/api";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import type { CacheImpl, DB, Variables } from "../core/hono-types";
import { adminOnly, withJsonBody } from "../core/route-boundaries";
import { feeds, mediaAssets } from "../db/schema";
import {
    createFeedAIComposeTask,
    createTaskQueue,
    type FeedAIComposeStatus,
    type FeedAIComposeTaskPayload,
} from "../queue";
import { generateAIText, stripReasoningTags } from "../utils/ai";
import {
    buildComposeUserMessage,
    checkComposeGate,
    composeMaxTokensFloor,
    DEFAULT_COMPOSE_SYSTEM_PROMPT,
    parseComposedArticle,
    renderMediaPlaceholders,
    type ComposeAsset,
    type ComposedArticle,
} from "../utils/ai-compose";
import { getAIWriterConfig } from "../utils/db-config";
import { syncFeedAISummaryQueueState } from "./feed-ai-summary";
import { bindTagToPost } from "./tag";

type ConfigReader = {
    get(key: string): Promise<unknown>;
};

export type ComposeOutcome =
    | { kind: "failed"; error: string }
    | { kind: "published"; article: ComposedArticle };

const COMPOSE_LENGTHS: ComposeLength[] = ["short", "medium", "long"];

export function normalizeComposeLength(value: unknown): ComposeLength {
    return COMPOSE_LENGTHS.includes(value as ComposeLength) ? (value as ComposeLength) : "medium";
}

function buildStatusUpdate(
    status: FeedAIComposeStatus,
    overrides?: Partial<{ aiComposeError: string }>,
) {
    return {
        aiComposeStatus: status,
        aiComposeError: "",
        ...overrides,
    };
}

/**
 * The whole decision of "publish or stop at draft", isolated from IO so it can
 * be tested without a database or a provider.
 */
export function decideComposeOutcome(input: { raw: string | null; error?: string }): ComposeOutcome {
    if (input.error) {
        return { kind: "failed", error: input.error };
    }

    if (!input.raw || !input.raw.trim()) {
        return { kind: "failed", error: "AI 返回了空响应" };
    }

    const cleaned = stripReasoningTags(input.raw);
    if (!cleaned.trim()) {
        return { kind: "failed", error: "AI 响应中只有推理内容，没有正文" };
    }

    const article = parseComposedArticle(cleaned);
    const gate = checkComposeGate(article);
    if (!gate.ok) {
        return { kind: "failed", error: gate.reason };
    }

    return { kind: "published", article };
}

export async function enqueueFeedAICompose(
    env: Env,
    payload: FeedAIComposeTaskPayload,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await createTaskQueue(env).send(createFeedAIComposeTask(payload));
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Looks assets up so the renderer knows each one's type and provider. */
export async function loadComposeAssets(
    db: DB,
    requested: Array<{ id: string; note: string }>,
): Promise<{ ok: true; assets: ComposeAsset[] } | { ok: false; missing: string[] }> {
    if (requested.length === 0) {
        return { ok: true, assets: [] };
    }

    // API 侧资产 id 是字符串，media_assets 主键是整数：能解析的才查，
    // 解析不了的直接算缺失（与旧行为一致：找不到 → missing）。
    const numericIds = requested
        .map((asset) => Number(asset.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (numericIds.length === 0) {
        // inArray 不接受空数组；全部 id 都解析不了时直接判缺失。
        return { ok: false, missing: requested.map((asset) => asset.id) };
    }
    const rows = await db.query.mediaAssets.findMany({
        where: inArray(mediaAssets.id, numericIds),
    });
    const byId = new Map(rows.map((row) => [String(row.id), row]));

    const missing = requested.filter((asset) => !byId.has(asset.id)).map((asset) => asset.id);
    if (missing.length > 0) {
        return { ok: false, missing };
    }

    return {
        ok: true,
        // Preserve the order the admin chose: it is the order the model is shown.
        assets: requested.map((asset) => {
            const row = byId.get(asset.id)!;
            return {
                id: String(row.id),
                // Stage 2 的 kind 比旧 type 多 gallery/attachment 等取值，
                // 渲染只认 image/video/audio：非常见值按 image 处理。
                type: (["image", "video", "audio"] as const).includes(row.kind as "image")
                    ? (row.kind as ComposeAsset["type"])
                    : "image",
                // 只有 stream 需要打 provider 标记，其余一律走本站直链。
                provider: (row.source === "stream" ? "stream" : "r2") as ComposeAsset["provider"],
                note: asset.note,
            };
        }),
    };
}

export async function processFeedAIComposeTask(
    env: Env,
    db: DB,
    cache: CacheImpl,
    serverConfig: ConfigReader,
    payload: FeedAIComposeTaskPayload,
    clearFeedCache: (
        cache: CacheImpl,
        id: number,
        alias: string | null,
        newAlias: string | null,
    ) => Promise<void>,
) {
    const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, payload.feedId) });

    if (!feed) {
        return;
    }

    // A manual edit during generation means the admin took over; do not overwrite.
    if (Math.floor(feed.updatedAt.getTime() / 1000) !== payload.expectedUpdatedAtUnix) {
        return;
    }

    const writerConfig = await getAIWriterConfig(serverConfig);
    if (!writerConfig.enabled) {
        await db
            .update(feeds)
            .set(buildStatusUpdate("failed", { aiComposeError: "AI 写作功能未启用" }))
            .where(eq(feeds.id, feed.id));
        return;
    }

    await db.update(feeds).set(buildStatusUpdate("processing")).where(eq(feeds.id, feed.id));

    const assetResult = await loadComposeAssets(db, payload.assets);
    if (!assetResult.ok) {
        await db
            .update(feeds)
            .set(
                buildStatusUpdate("failed", {
                    aiComposeError: `素材不存在：${assetResult.missing.join(", ")}`,
                }),
            )
            .where(eq(feeds.id, feed.id));
        return;
    }

    const length = normalizeComposeLength(payload.length);
    const messages = [
        {
            role: "system" as const,
            content: writerConfig.system_prompt.trim() || DEFAULT_COMPOSE_SYSTEM_PROMPT,
        },
        {
            role: "user" as const,
            content: buildComposeUserMessage({
                topic: payload.topic,
                assets: assetResult.assets,
                length,
                style: payload.style,
            }),
        },
    ];

    let raw: string | null = null;
    let requestError: string | undefined;

    try {
        raw = await generateAIText(env, writerConfig, messages, {
            // Never let a configured ceiling truncate the length that was asked for.
            maxTokens: Math.max(writerConfig.max_tokens, composeMaxTokensFloor(length)),
            temperature: writerConfig.temperature,
        });
    } catch (error) {
        console.error("[AI Compose] Generation failed:", error);
        requestError = error instanceof Error ? error.message : String(error);
    }

    const outcome = decideComposeOutcome({ raw, error: requestError });

    if (outcome.kind === "failed") {
        await db
            .update(feeds)
            .set(buildStatusUpdate("failed", { aiComposeError: outcome.error }))
            .where(eq(feeds.id, feed.id));
        await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
        return;
    }

    const content = renderMediaPlaceholders(outcome.article.content, assetResult.assets);
    const publishedAt = new Date();

    await db
        .update(feeds)
        .set({
            title: outcome.article.title,
            summary: outcome.article.summary,
            content,
            draft: 0,
            listed: payload.listed ? 1 : 0,
            updatedAt: publishedAt,
            ...buildStatusUpdate("completed"),
        })
        .where(eq(feeds.id, feed.id));

    await bindTagToPost(db, feed.id, outcome.article.tags);
    // Stage 2 媒体栈不再做「文章 ↔ 资产」行级绑定（旧 syncMediaForFeed 已随
    // Stage 1 媒体模型下线），渲染时直接用资产 id 生成 playback 链接。
    await syncFeedAISummaryQueueState(db, serverConfig, env, feed.id, {
        draft: false,
        updatedAt: publishedAt,
        resetSummary: true,
    });
    await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
}

export function registerFeedAIComposeRoutes(app: Hono<{ Bindings: Env; Variables: Variables }>) {
    app.post(
        "/ai-compose",
        adminOnly(
            withJsonBody<CreateAIComposeRequest>(feedAIComposeSchema, async (c, body) => {
                const db = c.get("db");
                const env = c.get("env");
                const uid = c.get("uid");
                const serverConfig = c.get("serverConfig");

                if (!uid) {
                    return c.text("User ID is required", 400);
                }

                const writerConfig = await getAIWriterConfig(serverConfig);
                if (!writerConfig.enabled) {
                    return c.text("AI writer is not enabled", 400);
                }

                const assetResult = await loadComposeAssets(db, body.assets);
                if (!assetResult.ok) {
                    return c.text(`Unknown media asset: ${assetResult.missing.join(", ")}`, 400);
                }

                const now = new Date();
                const listed = body.listed ?? true;

                const rows = await db
                    .insert(feeds)
                    .values({
                        title: body.topic,
                        content: "",
                        summary: "",
                        ai_summary: "",
                        ai_summary_status: "idle",
                        ai_summary_error: "",
                        aiComposeStatus: "pending",
                        aiComposeError: "",
                        uid,
                        alias: null,
                        listed: listed ? 1 : 0,
                        draft: 1,
                        createdAt: now,
                        updatedAt: now,
                    })
                    .returning({ id: feeds.id, updatedAt: feeds.updatedAt });

                const placeholder = rows[0];
                if (!placeholder) {
                    return c.text("Failed to create the placeholder article", 500);
                }

                const enqueued = await enqueueFeedAICompose(env, {
                    feedId: placeholder.id,
                    expectedUpdatedAtUnix: Math.floor(placeholder.updatedAt.getTime() / 1000),
                    topic: body.topic,
                    assets: body.assets,
                    length: normalizeComposeLength(body.length),
                    style: body.style,
                    listed,
                });

                if (!enqueued.ok) {
                    await db
                        .update(feeds)
                        .set(buildStatusUpdate("failed", { aiComposeError: enqueued.error }))
                        .where(eq(feeds.id, placeholder.id));
                    return c.text(enqueued.error, 500);
                }

                return c.json({ id: placeholder.id, status: "pending" as const }, 202);
            }),
            { message: "Permission denied", status: 403 },
        ),
    );

    // Deliberately not folded into GET /feed/:id: that route is cached, so a
    // poller would keep reading a stale snapshot, and it returns the whole row
    // to every visitor.
    app.get(
        "/:id/ai-compose-status",
        adminOnly(
            async (c) => {
                const db = c.get("db");
                const id = Number.parseInt(c.req.param("id"), 10);

                if (!Number.isFinite(id)) {
                    return c.text("Invalid id", 400);
                }

                const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
                if (!feed) {
                    return c.text("Not found", 404);
                }

                return c.json({
                    status: feed.aiComposeStatus,
                    error: feed.aiComposeError,
                });
            },
            { message: "Permission denied", status: 403 },
        ),
    );
}
