/**
 * 文章播客化 TTS（P0）：把文章正文用 Workers AI MeloTTS 合成语音，
 * 存 R2 并登记为 media_assets audio 行，feeds.tts_asset_id 指向它。
 *
 * 队列任务 feed.tts.generate 抄 feed.ai-summary.generate 模式：
 * idle → pending → processing → completed | failed，
 * expectedUpdatedAtUnix 防旧任务覆盖（复用 feed-ai-summary 的同名函数）。
 *
 * P0 约束：手动触发（后台按钮），provider 硬编码 MeloTTS 中文，
 * 不做 podcast.xml（P1）、不做发布自动生成（P2）、不做设置页。
 */
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import type { CacheImpl, DB } from "../core/hono-types";
import { feeds, mediaAssets } from "../db/schema";
import {
    createFeedTTSTask,
    createTaskQueue,
    type FeedTTSTaskPayload,
    type FeedTTSStatus,
} from "../queue";
import {
    matchesExpectedUpdatedAt,
    normalizeQueueUpdatedAt,
} from "./feed-ai-summary";
import { chunkSpeechText, markdownToSpeechText } from "../utils/tts-text";
import {
    concatMp3,
    estimateDurationSec,
    synthesizeSpeech,
    TTS_CHUNK_CHARS,
    TTS_MAX_CHARS,
} from "../utils/tts";
import {
    deleteStorageObject,
    getStoragePublicUrl,
    putStorageObjectAtKey,
} from "../utils/storage";
import { clearFeedCache } from "./clear-feed-cache";

type ConfigReader = {
    get(key: string): Promise<unknown>;
};

function buildTTSStatusUpdate(
    status: FeedTTSStatus,
    overrides?: Partial<{ ai_tts_status: FeedTTSStatus; ai_tts_error: string }>,
) {
    return {
        ai_tts_status: status,
        ai_tts_error: "",
        ...overrides,
    };
}

/** 纯函数：朗读音频在 R2 的对象 key（含文章更新时间戳，旧版本不覆盖）。 */
export function ttsR2Key(feedId: number, updatedAtUnix: number): string {
    return `tts/feed-${feedId}-${updatedAtUnix}.mp3`;
}

/**
 * 纯函数：校验 + 切分朗读任务。返回 ok:false 时调用方落 failed 并写 error。
 */
export function resolveTTSTaskPlan(
    content: string,
): { ok: true; text: string; chunks: string[] } | { ok: false; error: string } {
    const text = markdownToSpeechText(content);
    if (!text) {
        return { ok: false, error: "文章正文经清洗后为空，无法生成语音" };
    }
    if (text.length > TTS_MAX_CHARS) {
        return {
            ok: false,
            error: `朗读文本过长（${text.length} 字符，上限 ${TTS_MAX_CHARS}），请拆分文章后重试`,
        };
    }
    const chunks = chunkSpeechText(text, TTS_CHUNK_CHARS);
    if (chunks.length === 0) {
        return { ok: false, error: "文章正文经清洗后为空，无法生成语音" };
    }
    return { ok: true, text, chunks };
}

export async function enqueueFeedAITTS(
    env: Env,
    feedId: number,
    updatedAt: Date,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await createTaskQueue(env).send(
            createFeedTTSTask({
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

/**
 * 后台「生成朗读音频」入口：pending + 入队。草稿不生成；AI binding 缺失直接 failed。
 */
export async function syncFeedAITTSQueueState(
    db: DB,
    env: Env,
    feedId: number,
    options: { draft: boolean; updatedAt: Date },
): Promise<void> {
    const workerAIAvailable =
        Boolean(env.AI) && typeof (env.AI as { run?: unknown }).run === "function";

    if (options.draft) {
        await db
            .update(feeds)
            .set(buildTTSStatusUpdate("idle"))
            .where(eq(feeds.id, feedId));
        return;
    }

    if (!workerAIAvailable) {
        await db
            .update(feeds)
            .set(
                buildTTSStatusUpdate("failed", {
                    ai_tts_error: "Workers AI 未配置（AI binding 缺失），无法生成语音",
                }),
            )
            .where(eq(feeds.id, feedId));
        return;
    }

    await db
        .update(feeds)
        .set(buildTTSStatusUpdate("pending"))
        .where(eq(feeds.id, feedId));

    const enqueueResult = await enqueueFeedAITTS(env, feedId, options.updatedAt);
    if (!enqueueResult.ok) {
        await db
            .update(feeds)
            .set(
                buildTTSStatusUpdate("failed", {
                    ai_tts_error: enqueueResult.error,
                }),
            )
            .where(eq(feeds.id, feedId));
    }
}

/**
 * 删除某篇文章的旧朗读音频：feeds.tts_asset_id 置空 → 删 R2 对象 → 删资产行。
 * 重试幂等用；各步骤 best-effort，R2 删除失败不阻断。
 */
export async function deleteFeedTTSAsset(
    env: Env,
    db: DB,
    feedId: number,
    assetId: number | null | undefined,
): Promise<void> {
    if (!assetId) return;
    await db.update(feeds).set({ tts_asset_id: null }).where(eq(feeds.id, feedId));
    const asset = await db.query.mediaAssets.findFirst({
        where: eq(mediaAssets.id, assetId),
    });
    if (asset?.r2Key) {
        try {
            await deleteStorageObject(env, asset.r2Key);
        } catch {
            // R2 对象可能已被手动清理；继续删资产行
        }
    }
    await db.delete(mediaAssets).where(eq(mediaAssets.id, assetId));
}

export async function processFeedAITTSTask(
    env: Env,
    db: DB,
    cache: CacheImpl,
    _serverConfig: ConfigReader,
    payload: FeedTTSTaskPayload,
    clearFeedCache: (
        cache: CacheImpl,
        id: number,
        alias: string | null,
        newAlias: string | null,
    ) => Promise<void>,
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

    if (feed.draft === 1) {
        await db
            .update(feeds)
            .set(buildTTSStatusUpdate("idle"))
            .where(eq(feeds.id, feed.id));
        await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
        return;
    }

    await db
        .update(feeds)
        .set(buildTTSStatusUpdate("processing"))
        .where(eq(feeds.id, feed.id));

    const plan = resolveTTSTaskPlan(feed.content);
    if (!plan.ok) {
        await db
            .update(feeds)
            .set(buildTTSStatusUpdate("failed", { ai_tts_error: plan.error }))
            .where(eq(feeds.id, feed.id));
        await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
        return;
    }

    try {
        // 幂等：先清掉旧音频（R2 对象 + 资产行），再生成新的
        await deleteFeedTTSAsset(env, db, feed.id, feed.tts_asset_id);

        // 串行合成：长文分块多，避免并发打爆上游限流
        const parts: Uint8Array[] = [];
        for (const chunk of plan.chunks) {
            parts.push(await synthesizeSpeech(env, chunk));
        }
        const audio = concatMp3(parts);

        const key = ttsR2Key(feed.id, normalizeQueueUpdatedAt(feed.updatedAt));
        await putStorageObjectAtKey(env, key, audio, "audio/mpeg");

        const inserted = await db
            .insert(mediaAssets)
            .values({
                kind: "audio",
                source: "r2",
                r2Key: key,
                mime: "audio/mpeg",
                duration: estimateDurationSec(plan.text),
                title: feed.title ?? `feed-${feed.id}`,
            })
            .returning({ id: mediaAssets.id });
        const assetId = inserted[0]?.id;
        if (!assetId) {
            throw new Error("写入 media_assets 失败");
        }

        await db
            .update(feeds)
            .set({
                ai_tts_status: "completed",
                ai_tts_error: "",
                tts_asset_id: assetId,
            })
            .where(eq(feeds.id, feed.id));
    } catch (error) {
        // Workers AI 401（token 无权限）/ 限流 / R2 失败都落这里，原因写进 ai_tts_error
        await db
            .update(feeds)
            .set(
                buildTTSStatusUpdate("failed", {
                    ai_tts_error: error instanceof Error ? error.message : String(error),
                }),
            )
            .where(eq(feeds.id, feed.id));
    }

    await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
}

function parseFeedIdParam(c: { req: { param(name: string): string } }): number | null {
    const id = Number.parseInt(c.req.param("id"), 10);
    return Number.isFinite(id) ? id : null;
}

export function registerFeedTTSRoutes(app: Hono<{ Bindings: Env; Variables: Variables }>) {
    // POST /:id/tts —— 后台：生成朗读音频（入队），adminOnly
    // 必须在 app.post('/:id', ...) 之前注册（同 ai-revise 的注释）。
    app.post(
        "/:id/tts",
        adminOnly(async (c) => {
            const db = c.get("db");
            const env = c.get("env");
            const cache = c.get("cache");

            const id = parseFeedIdParam(c);
            if (id === null) {
                return c.text("Invalid id", 400);
            }

            const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
            if (!feed) {
                return c.text("Not found", 404);
            }

            await syncFeedAITTSQueueState(db, env, feed.id, {
                draft: feed.draft === 1,
                updatedAt: feed.updatedAt,
            });
            await clearFeedCache(cache, feed.id, feed.alias, feed.alias);

            const fresh = await db.query.feeds.findFirst({
                where: eq(feeds.id, feed.id),
                columns: { ai_tts_status: true, ai_tts_error: true },
            });
            return c.json({
                status: fresh?.ai_tts_status ?? "pending",
                error: fresh?.ai_tts_error ?? "",
            });
        }),
    );

    // DELETE /:id/tts —— 后台：删除朗读音频，adminOnly
    app.delete(
        "/:id/tts",
        adminOnly(async (c) => {
            const db = c.get("db");
            const env = c.get("env");
            const cache = c.get("cache");

            const id = parseFeedIdParam(c);
            if (id === null) {
                return c.text("Invalid id", 400);
            }

            const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
            if (!feed) {
                return c.text("Not found", 404);
            }

            await deleteFeedTTSAsset(env, db, feed.id, feed.tts_asset_id);
            await db
                .update(feeds)
                .set(buildTTSStatusUpdate("idle"))
                .where(eq(feeds.id, feed.id));
            await clearFeedCache(cache, feed.id, feed.alias, feed.alias);

            return c.json({ ok: true });
        }),
    );

    // GET /:id/tts —— 管理员看完整状态；访客仅在文章公开且已生成时拿到播放地址。
    // 与 app.get('/:id') 不冲突（两段路径 vs 一段路径）。
    app.get("/:id/tts", async (c) => {
        const db = c.get("db");
        const env = c.get("env");
        const admin = c.get("admin");

        const id = parseFeedIdParam(c);
        if (id === null) {
            return c.text("Invalid id", 400);
        }

        const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
        if (!feed) {
            return c.text("Not found", 404);
        }

        const asset = feed.tts_asset_id
            ? await db.query.mediaAssets.findFirst({
                  where: eq(mediaAssets.id, feed.tts_asset_id),
              })
            : null;

        if (!admin) {
            if (
                feed.draft === 1 ||
                feed.listed !== 1 ||
                feed.ai_tts_status !== "completed" ||
                !asset?.r2Key
            ) {
                return c.text("Not found", 404);
            }
            const origin =
                env.FRONTEND_URL?.replace(/\/+$/, "") || new URL(c.req.url).origin;
            return c.json({
                audioUrl: getStoragePublicUrl(env, asset.r2Key, origin),
                durationSec: asset.duration ?? null,
            });
        }

        const stale = asset
            ? feed.updatedAt.getTime() > asset.createdAt.getTime()
            : false;
        const origin =
            env.FRONTEND_URL?.replace(/\/+$/, "") || new URL(c.req.url).origin;
        return c.json({
            status: feed.ai_tts_status,
            assetId: feed.tts_asset_id,
            durationSec: asset?.duration ?? null,
            error: feed.ai_tts_error,
            stale,
            // 管理员也可直接试听
            audioUrl: asset?.r2Key ? getStoragePublicUrl(env, asset.r2Key, origin) : null,
        });
    });
}
