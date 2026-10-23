/**
 * 英文翻译（feed.translation-en.generate）：把中文博客的标题/摘要/正文译成英文，
 * 存 feeds 的 title_en / summary_en / content_en，站点切到英文时前端展示英文版。
 *
 * 队列模式抄 feed-ai-summary.ts：idle → pending → processing → completed | failed，
 * expectedUpdatedAtUnix 防旧任务覆盖新版本；原文变更时由 feed.ts 的 create/update
 * 清空 *_en 并重新入队。存量文章没有翻译时，详情页切英文会调
 * POST /feed/:id/translate-en 按需入队（公开，但仅在缺译文且未在途时才真正入队）。
 */
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { CacheImpl, DB, Variables } from "../core/hono-types";
import { feeds } from "../db/schema";
import {
    createFeedTranslationTask,
    createTaskQueue,
    type FeedTranslationStatus,
} from "../queue";
import { generateFeedTranslationResult } from "../utils/ai-translation";
import { getAIConfig } from "../utils/db-config";
import { matchesExpectedUpdatedAt, normalizeQueueUpdatedAt } from "./feed-ai-summary";

type ConfigReader = {
    get(key: string): Promise<unknown>;
};

function buildStatusUpdate(
    status: FeedTranslationStatus,
    overrides?: Partial<{
        titleEn: string;
        summaryEn: string;
        contentEn: string;
        translationEnStatus: FeedTranslationStatus;
        translationEnError: string;
    }>,
) {
    return {
        translationEnStatus: status,
        translationEnError: "",
        ...overrides,
    };
}

export async function enqueueFeedTranslation(
    env: Env,
    feedId: number,
    updatedAt: Date,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await createTaskQueue(env).send(
            createFeedTranslationTask({
                feedId,
                expectedUpdatedAtUnix: normalizeQueueUpdatedAt(updatedAt),
            }),
        );
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function syncFeedTranslationQueueState(
    db: DB,
    serverConfig: ConfigReader,
    env: Env,
    feedId: number,
    options: {
        draft: boolean;
        updatedAt: Date;
        resetTranslation?: boolean;
    },
) {
    const aiConfig = await getAIConfig(serverConfig);
    const shouldQueue = aiConfig.enabled && !options.draft;
    const reset = options.resetTranslation
        ? { titleEn: "", summaryEn: "", contentEn: "" }
        : undefined;

    if (!shouldQueue) {
        await db
            .update(feeds)
            .set(buildStatusUpdate("idle", reset))
            .where(eq(feeds.id, feedId));
        return;
    }

    await db
        .update(feeds)
        .set(buildStatusUpdate("pending", reset))
        .where(eq(feeds.id, feedId));

    const enqueueResult = await enqueueFeedTranslation(env, feedId, options.updatedAt);
    if (!enqueueResult.ok) {
        await db
            .update(feeds)
            .set(buildStatusUpdate("failed", { translationEnError: enqueueResult.error }))
            .where(eq(feeds.id, feedId));
    }
}

export async function processFeedTranslationTask(
    env: Env,
    db: DB,
    cache: CacheImpl,
    serverConfig: ConfigReader,
    payload: {
        feedId: number;
        expectedUpdatedAtUnix: number;
    },
    clearFeedCache: (cache: CacheImpl, id: number, alias: string | null, newAlias: string | null) => Promise<void>,
) {
    const feed = await db.query.feeds.findFirst({
        where: eq(feeds.id, payload.feedId),
    });

    if (!feed) {
        return;
    }

    if (!matchesExpectedUpdatedAt(feed.updatedAt, payload)) {
        return;
    }

    const aiConfig = await getAIConfig(serverConfig);
    if (!aiConfig.enabled || feed.draft === 1) {
        await db
            .update(feeds)
            .set(buildStatusUpdate("idle"))
            .where(eq(feeds.id, feed.id));
        await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
        return;
    }

    await db
        .update(feeds)
        .set(buildStatusUpdate("processing"))
        .where(eq(feeds.id, feed.id));

    const result = await generateFeedTranslationResult(env, serverConfig, feed);
    if (result.contentEn !== null && result.titleEn !== null) {
        await db
            .update(feeds)
            .set(
                buildStatusUpdate("completed", {
                    titleEn: result.titleEn,
                    summaryEn: result.summaryEn ?? "",
                    contentEn: result.contentEn,
                }),
            )
            .where(eq(feeds.id, feed.id));
    } else if (result.skipped) {
        await db
            .update(feeds)
            .set(buildStatusUpdate("idle"))
            .where(eq(feeds.id, feed.id));
    } else {
        await db
            .update(feeds)
            .set(
                buildStatusUpdate("failed", {
                    translationEnError: result.error ?? "Unknown AI translation error",
                }),
            )
            .where(eq(feeds.id, feed.id));
    }

    await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
}

export function registerFeedTranslationRoutes(app: Hono<{ Bindings: Env; Variables: Variables }>) {
    // 按需翻译入口：详情页切到英文、且译文缺失/失败时调用。
    // 公开可达（访客切语言也要能看英文），但只有「未完成且不在途」才入队，
    // 重复调用是幂等的；草稿只有管理员/作者能触发。
    app.post("/:id/translate-en", async (c) => {
        const db = c.get("db");
        const serverConfig = c.get("serverConfig");
        const env = c.get("env");
        const admin = c.get("admin");
        const uid = c.get("uid");
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id)) {
            return c.text("Invalid id", 400);
        }

        const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
        if (!feed) {
            return c.text("Not found", 404);
        }
        if (feed.draft && feed.uid !== uid && !admin) {
            return c.text("Permission denied", 403);
        }
        if (feed.translationEnStatus === "completed" && feed.contentEn) {
            return c.json({ status: feed.translationEnStatus });
        }
        if (feed.translationEnStatus === "pending" || feed.translationEnStatus === "processing") {
            return c.json({ status: feed.translationEnStatus });
        }

        await syncFeedTranslationQueueState(db, serverConfig, env, feed.id, {
            draft: feed.draft === 1,
            updatedAt: feed.updatedAt,
        });

        const refreshed = await db.query.feeds.findFirst({
            where: eq(feeds.id, id),
            columns: { translationEnStatus: true },
        });
        return c.json({ status: refreshed?.translationEnStatus ?? "idle" });
    });

    // 状态轮询：不走 GET /feed/:id 的缓存（理由同 ai-compose-status），
    // 完成时一并返回译文，详情页拿到即可直接渲染，不必再拉整篇。
    app.get("/:id/translation-en", async (c) => {
        const db = c.get("db");
        const admin = c.get("admin");
        const uid = c.get("uid");
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id)) {
            return c.text("Invalid id", 400);
        }

        const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
        if (!feed) {
            return c.text("Not found", 404);
        }
        if (feed.draft && feed.uid !== uid && !admin) {
            return c.text("Permission denied", 403);
        }

        return c.json({
            status: feed.translationEnStatus,
            titleEn: feed.titleEn,
            summaryEn: feed.summaryEn,
            contentEn: feed.contentEn,
            ...(admin ? { error: feed.translationEnError } : {}),
        });
    });
}
