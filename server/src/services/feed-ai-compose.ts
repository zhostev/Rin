import type { ComposeLength } from "@rin/api";
import { eq, inArray } from "drizzle-orm";
import type { CacheImpl, DB } from "../core/hono-types";
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
import { syncMediaForFeed } from "./media";
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
    overrides?: Partial<{ ai_compose_error: string }>,
) {
    return {
        ai_compose_status: status,
        ai_compose_error: "",
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

    const rows = await db.query.mediaAssets.findMany({
        where: inArray(mediaAssets.id, requested.map((asset) => asset.id)),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

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
                id: row.id,
                type: row.type as ComposeAsset["type"],
                provider: row.provider as ComposeAsset["provider"],
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
            .set(buildStatusUpdate("failed", { ai_compose_error: "AI 写作功能未启用" }))
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
                    ai_compose_error: `素材不存在：${assetResult.missing.join(", ")}`,
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
            .set(buildStatusUpdate("failed", { ai_compose_error: outcome.error }))
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
    await syncMediaForFeed(db, feed.id, feed.uid, content);
    await syncFeedAISummaryQueueState(db, serverConfig, env, feed.id, {
        draft: false,
        updatedAt: publishedAt,
        resetSummary: true,
    });
    await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
}
