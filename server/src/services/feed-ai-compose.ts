import { feedAIComposeSchema } from "@rin/api";
import type { ComposeLength, CreateAIComposeRequest } from "@rin/api";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import type { CacheImpl, DB, Variables } from "../core/hono-types";
import { adminOnly, withJsonBody } from "../core/route-boundaries";
import { feeds, mediaAssets } from "../db/schema";
import { presignR2GetUrl } from "../features/media/r2-direct";
import {
    createFeedAIComposeTask,
    createTaskQueue,
    type FeedAIComposeStatus,
    type FeedAIComposeTaskPayload,
} from "../queue";
import {
    generateAIText,
    generateAITextWithVision,
    stripReasoningTags,
    type AIChatMessage,
    type AITextResult,
    type AIVisionContentPart,
} from "../utils/ai";
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
import { normalizeImageCount, normalizeImageMode, prepareAIComposeImages } from "./ai-images";
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

/**
 * 截断续写：模型返回 finish_reason === "length" 说明输出撞到了 token 上限。
 * 把已生成的部分作为 assistant 历史发回去，让模型从中断处继续写，
 * 而不是直接发布半成品（如 feed/25 断在半句话上）。
 */
const MAX_CONTINUATIONS = 2;

const CONTINUE_PROMPT =
    "你上一次的输出被截断了。请从中断处继续写完：不要重复 front-matter，不要重复已经写过的内容，直接续写正文。";

export interface ComposeGeneration {
    /** 拼接后的完整原始输出；全空时为 null。 */
    raw: string | null;
    /** true = 续写次数用完仍被截断：调用方应按失败处理，绝不发布半成品。 */
    truncated: boolean;
    error?: string;
}

/** 续写块不应再带 front-matter；模型不听话时防御性去掉。 */
export function stripLeadingFrontMatter(chunk: string): string {
    const text = chunk.replace(/^\s+/, "");
    if (!text.startsWith("---")) return chunk;
    const lines = text.split("\n");
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closing <= 0) return chunk;
    return lines.slice(closing + 1).join("\n");
}

/**
 * 带截断续写的文章生成。generate 由调用方注入以便测试；
 * vision 模式与纯文本模式共用同一套续写循环。
 * 续写时不再重复发送图片（data URL 又大又没必要），只保留文本历史。
 */
export async function generateArticleWithContinuation(
    baseMessages: AIChatMessage[],
    generate: (messages: AIChatMessage[]) => Promise<AITextResult>,
    maxContinuations = MAX_CONTINUATIONS,
): Promise<ComposeGeneration> {
    const textOnlyBase: AIChatMessage[] = baseMessages.map((message) => {
        if (typeof message.content === "string") return message;
        const textParts = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text);
        const imageCount = message.content.filter((part) => part.type === "image_url").length;
        const note =
            imageCount > 0 ? `\n[注：此处原有 ${imageCount} 张参考图片，内容已在上文中描述]` : "";
        return { ...message, content: [...textParts, note].join("\n") };
    });

    const chunks: string[] = [];
    // 首次请求原样发送（含图片）；只有续写时才剥离图片省 token。
    let messages = baseMessages;
    let truncated = false;

    for (let attempt = 0; attempt <= maxContinuations; attempt++) {
        let result: AITextResult;
        try {
            result = await generate(messages);
        } catch (error) {
            const partial = chunks.join("");
            return {
                raw: partial ? partial : null,
                truncated: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }

        const piece = attempt === 0 ? (result.text ?? "") : stripLeadingFrontMatter(result.text ?? "");
        chunks.push(piece);

        if (result.finishReason === "length" && result.text?.trim()) {
            truncated = true;
            console.log(`[AI Compose] Output truncated (finish_reason=length), continuing (${attempt + 1}/${maxContinuations})`);
            messages = [
                ...textOnlyBase,
                { role: "assistant", content: chunks.join("") },
                { role: "user", content: CONTINUE_PROMPT },
            ];
            continue;
        }
        truncated = false;
        break;
    }

    const raw = chunks.join("");
    return { raw: raw ? raw : null, truncated };
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

/** 截图生文：单次最多读图数（控制 token 成本与请求体积）。 */
export const VISION_IMAGE_MAX_COUNT = 5;
/** 截图生文：单张截图上限 6MB，超限直接报错（避免视觉请求过大）。 */
export const VISION_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

export type VisionImageInput = {
    dataUrl: string;
    asset: ComposeAsset;
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * 截图生文：校验截图资产（必须存在、是图片、有 R2 对象）。
 * 路由层用它做前置校验（400），任务执行时用 loadVisionImages 下载。
 */
export async function resolveVisionAssetRows(
    db: DB,
    requested: Array<{ id: string; note?: string }>,
): Promise<
    | { ok: true; items: Array<{ row: typeof mediaAssets.$inferSelect; note: string }> }
    | { ok: false; error: string }
> {
    const items = requested.filter((item) => item.id.trim().length > 0);
    if (items.length === 0) {
        return { ok: true, items: [] };
    }
    if (items.length > VISION_IMAGE_MAX_COUNT) {
        return { ok: false, error: `截图最多上传 ${VISION_IMAGE_MAX_COUNT} 张` };
    }
    const numericIds = items
        .map((item) => Number(item.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (numericIds.length !== items.length) {
        return { ok: false, error: "截图资产 id 非法" };
    }
    const rows = await db.query.mediaAssets.findMany({
        where: inArray(mediaAssets.id, numericIds),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    const resolved: Array<{ row: typeof mediaAssets.$inferSelect; note: string }> = [];
    for (const item of items) {
        const row = byId.get(Number(item.id));
        if (!row) {
            return { ok: false, error: `截图不存在：${item.id}` };
        }
        if (row.kind !== "image") {
            return { ok: false, error: `截图必须是图片：${item.id}` };
        }
        if (!row.r2Key) {
            return { ok: false, error: `截图没有文件对象：${item.id}` };
        }
        resolved.push({ row, note: item.note?.trim() || "" });
    }
    return { ok: true, items: resolved };
}

/**
 * 截图生文：把截图下载为视觉模型可读的 data URL。
 * 返回的 asset 同时进素材清单，模型可用 [[media:N]] 把截图插进正文。
 */
export async function loadVisionImages(
    env: Env,
    db: DB,
    requested: Array<{ id: string; note?: string }>,
): Promise<{ ok: true; images: VisionImageInput[] } | { ok: false; error: string }> {
    const resolved = await resolveVisionAssetRows(db, requested);
    if (!resolved.ok) {
        return resolved;
    }

    const images: VisionImageInput[] = [];
    for (const { row, note } of resolved.items) {
        let bytes: ArrayBuffer;
        try {
            const url = await presignR2GetUrl(env, row.r2Key!);
            const response = await fetch(url);
            if (!response.ok) {
                return { ok: false, error: `截图下载失败：${row.id}（${response.status}）` };
            }
            bytes = await response.arrayBuffer();
        } catch {
            return { ok: false, error: `截图下载失败：${row.id}` };
        }
        if (bytes.byteLength > VISION_IMAGE_MAX_BYTES) {
            return { ok: false, error: `截图过大（单张上限 6MB）：${row.id}` };
        }
        const mime = row.mime && row.mime.startsWith("image/") ? row.mime : "image/png";
        images.push({
            dataUrl: `data:${mime};base64,${arrayBufferToBase64(bytes)}`,
            asset: {
                id: String(row.id),
                type: "image",
                provider: (row.source === "stream" ? "stream" : "r2") as ComposeAsset["provider"],
                note: note || "截图/输入图片",
            },
        });
    }
    return { ok: true, images };
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

    // AI 配图：先把图片真正生成/搜到并落盘，再让正文通过 [[media:N]] 引用。
    // 模型永远接触不到 URL，从根上杜绝编造图片链接。
    const imageMode = normalizeImageMode(payload.imageMode);
    let aiImageAssets: ComposeAsset[] = [];
    if (imageMode !== "none") {
        try {
            const prepared = await prepareAIComposeImages(env, db, writerConfig, {
                mode: imageMode,
                count: normalizeImageCount(payload.imageCount),
                topic: payload.topic,
            });
            aiImageAssets = prepared.assets;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[AI Compose] 配图失败：", message);
            await db
                .update(feeds)
                .set(buildStatusUpdate("failed", { aiComposeError: message }))
                .where(eq(feeds.id, feed.id));
            return;
        }
    }
    const allAssets = [...assetResult.assets, ...aiImageAssets];

    // 截图生文：下载截图喂给视觉模型读图；截图同时排在素材清单最前面，
    // 模型可用 [[media:N]] 把它们插进正文。
    let visionParts: AIVisionContentPart[] = [];
    if (payload.visionAssets.length > 0) {
        const vision = await loadVisionImages(env, db, payload.visionAssets);
        if (!vision.ok) {
            await db
                .update(feeds)
                .set(buildStatusUpdate("failed", { aiComposeError: vision.error }))
                .where(eq(feeds.id, feed.id));
            return;
        }
        visionParts = vision.images.map((image) => ({
            type: "image_url" as const,
            image_url: { url: image.dataUrl },
        }));
        allAssets.unshift(...vision.images.map((image) => image.asset));
    }

    const systemPrompt = writerConfig.system_prompt.trim() || DEFAULT_COMPOSE_SYSTEM_PROMPT;
    // 截图生文可以不填选题：只看图写作。
    const topic = payload.topic.trim() || "请根据以上截图/图片的内容写一篇文章";
    const userText = buildComposeUserMessage({
        topic,
        assets: allAssets,
        length,
        style: payload.style,
    });

    let generation: ComposeGeneration;
    try {
        const genOptions = {
            // Never let a configured ceiling truncate the length that was asked for.
            maxTokens: Math.max(writerConfig.max_tokens, composeMaxTokensFloor(length)),
            temperature: writerConfig.temperature,
        };
        const withVision = visionParts.length > 0;
        const baseMessages: AIChatMessage[] = withVision
            ? [
                  { role: "system", content: systemPrompt },
                  {
                      role: "user",
                      content: [...visionParts, { type: "text" as const, text: userText }],
                  },
              ]
            : [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: userText },
              ];
        // finish_reason=length 时自动续写；续写用完仍截断则按失败处理，不发布半成品。
        generation = await generateArticleWithContinuation(baseMessages, (messages) =>
            withVision
                ? generateAITextWithVision(env, writerConfig, messages, genOptions)
                : generateAIText(env, writerConfig, messages, genOptions),
        );
    } catch (error) {
        console.error("[AI Compose] Generation failed:", error);
        generation = {
            raw: null,
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    if (generation.truncated) {
        const error = "AI 输出被截断且续写后仍未完成，未发布；请重试";
        await db
            .update(feeds)
            .set(buildStatusUpdate("failed", { aiComposeError: error }))
            .where(eq(feeds.id, feed.id));
        await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
        return;
    }

    const outcome = decideComposeOutcome({ raw: generation.raw, error: generation.error });

    if (outcome.kind === "failed") {
        await db
            .update(feeds)
            .set(buildStatusUpdate("failed", { aiComposeError: outcome.error }))
            .where(eq(feeds.id, feed.id));
        await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
        return;
    }

    const content = renderMediaPlaceholders(outcome.article.content, allAssets);
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

                // 截图生文：选题可空（只看图写作），但选题和截图不能同时为空。
                const topic = (body.topic ?? "").trim();
                const visionAssets = (body.visionAssets ?? [])
                    .map((item) => ({ id: String(item.id ?? "").trim(), note: item.note ?? "" }))
                    .filter((item) => item.id.length > 0);
                if (!topic && visionAssets.length === 0) {
                    return c.text("请填写选题，或上传截图使用截图生文", 400);
                }
                const visionCheck = await resolveVisionAssetRows(db, visionAssets);
                if (!visionCheck.ok) {
                    return c.text(visionCheck.error, 400);
                }

                // AI 配图的前置校验：缺 key / 缺绑定直接 400，不建占位文章。
                const imageMode = normalizeImageMode(body.imageMode);
                const imageCount = normalizeImageCount(body.imageCount);
                if (imageMode === "search" && !writerConfig.pexels_api_key) {
                    return c.text("搜索图片需要先在 AI 写作设置里填写 Pexels API Key", 400);
                }
                if (imageMode === "generate" && (!env.AI || typeof env.AI.run !== "function")) {
                    return c.text("AI 生成图片需要 Workers AI 绑定", 400);
                }

                const now = new Date();
                const listed = body.listed ?? true;

                const rows = await db
                    .insert(feeds)
                    .values({
                        title: topic || "截图生文",
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
                    topic,
                    assets: body.assets,
                    visionAssets,
                    length: normalizeComposeLength(body.length),
                    style: body.style,
                    listed,
                    imageMode,
                    imageCount,
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
