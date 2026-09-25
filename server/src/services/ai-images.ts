/**
 * AI 配图服务：AI 写作的「配图」选项后端实现。
 *
 * 流程：文本模型先按选题产出作图 prompt / 搜索关键词（纯 JSON），再
 * - generate：Workers AI（FLUX）生成图片
 * - search：Pexels 搜图并下载原图
 * 图片一律存入 R2 并建 media_assets 行，返回 ComposeAsset 拼进写作素材，
 * 由正文里的 [[media:N]] 占位渲染，模型永远接触不到真实 URL。
 */
import type { AIComposeImageMode, AIWriterConfig } from "@rin/api";
import type { DB } from "../core/hono-types";
import { insertMediaAsset, updateMediaAssetById, deleteMediaAssetById, findMediaAssetById } from "../features/media/repository";
import { buildDirectUploadKey, R2_DIRECT_MAX_BYTES } from "../features/media/r2-direct";
import { generateAIText } from "../utils/ai";
import type { ComposeAsset } from "../utils/ai-compose";
import { deleteStorageObject, putStorageObjectAtKey } from "../utils/storage";

export const AI_IMAGE_MODEL_ID = "@cf/black-forest-labs/flux-1-schnell";
export const AI_IMAGE_MAX_COUNT = 3;
export const AI_IMAGE_MIN_COUNT = 1;

const PEXELS_API_BASE = "https://api.pexels.com/v1";

export interface AIImagePlanInput {
    mode: Exclude<AIComposeImageMode, "none">;
    count: number;
    topic: string;
}

export interface AIImagePrepareResult {
    assets: ComposeAsset[];
}

interface PlannedImage {
    /** generate 模式：英文作图 prompt；search 模式：英文搜索关键词 */
    prompt: string;
    /** 中文 alt 文案，同时用作素材 note */
    alt: string;
}

export function normalizeImageCount(value: unknown): number {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) {
        return 2;
    }
    return Math.min(AI_IMAGE_MAX_COUNT, Math.max(AI_IMAGE_MIN_COUNT, Math.floor(num)));
}

export function normalizeImageMode(value: unknown): AIComposeImageMode {
    return value === "generate" || value === "search" ? value : "none";
}

/**
 * 从模型返回里抠 JSON 数组：去 ```fence、去首尾杂文本，容错解析。
 * 纯函数，可单测。
 */
export function parsePlannedImages(raw: string | null, count: number): PlannedImage[] {
    if (!raw) {
        return [];
    }
    let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
        text = text.slice(start, end + 1);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed
        .filter(
            (item): item is { prompt: unknown; alt: unknown } =>
                !!item && typeof item === "object",
        )
        .map((item) => ({
            prompt: typeof item.prompt === "string" ? item.prompt.trim() : "",
            alt: typeof item.alt === "string" ? item.alt.trim() : "",
        }))
        .filter((item) => item.prompt.length > 0)
        .slice(0, count);
}

async function planImages(
    env: Env,
    writerConfig: AIWriterConfig,
    mode: Exclude<AIComposeImageMode, "none">,
    count: number,
    topic: string,
): Promise<PlannedImage[]> {
    const briefTask =
        mode === "generate"
            ? "为下面这篇中文博客文章的选题，写出作图 prompt（英文，一句话，写实摄影或扁平插画风格，明确主体、场景、氛围，避免文字）"
            : "为下面这篇中文博客文章的选题，写出英文图片搜索关键词（2-5 个词，Pexels 搜图用，偏写实摄影）";
    const messages = [
        {
            role: "system" as const,
            content:
                "你是博客配图策划。只输出 JSON 数组，不要输出其他任何文字。数组每个元素形如 {\"prompt\": \"英文作图/搜索词\", \"alt\": \"中文图片说明（20字以内）\"}。",
        },
        {
            role: "user" as const,
            content: `${briefTask}，共需要 ${count} 张，选题之间风格尽量统一。\n选题：${topic}`,
        },
    ];
    let raw: string | null = null;
    try {
        raw = await generateAIText(env, writerConfig, messages, {
            maxTokens: 800,
            temperature: 0.7,
        });
    } catch (error) {
        throw new Error(
            `配图规划失败：${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const planned = parsePlannedImages(raw, count);
    if (planned.length === 0) {
        throw new Error("配图规划失败：AI 没有返回可用的作图/搜索计划");
    }
    return planned;
}

/** Workers AI 图片模型的返回可能是 ArrayBuffer / Uint8Array / 带 arrayBuffer 的 Response。 */
async function toImageBytes(response: unknown): Promise<{ bytes: Uint8Array; mime: string }> {
    if (response instanceof Uint8Array) {
        return { bytes: response, mime: "image/png" };
    }
    if (response instanceof ArrayBuffer) {
        return { bytes: new Uint8Array(response), mime: "image/png" };
    }
    if (response && typeof (response as { arrayBuffer?: unknown }).arrayBuffer === "function") {
        const buffer = await (response as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
        return { bytes: new Uint8Array(buffer), mime: "image/png" };
    }
    throw new Error("图片生成返回了无法识别的格式");
}

async function generateOneImage(env: Env, prompt: string): Promise<{ bytes: Uint8Array; mime: string }> {
    if (!env.AI || typeof env.AI.run !== "function") {
        throw new Error("Workers AI 绑定未配置，无法生成图片");
    }
    const response = await env.AI.run(AI_IMAGE_MODEL_ID as never, { prompt } as never);
    const { bytes, mime } = await toImageBytes(response);
    if (bytes.byteLength === 0) {
        throw new Error("图片生成返回了空内容");
    }
    if (bytes.byteLength > R2_DIRECT_MAX_BYTES.image) {
        throw new Error("生成的图片超过 10MB 上限");
    }
    return { bytes, mime };
}

interface PexelsPhoto {
    id: number;
    width: number;
    height: number;
    url: string;
    photographer: string;
    photographer_url: string;
    src: { original?: string; large?: string; large2x?: string };
    alt?: string;
}

function pickPexelsPhotoUrl(photo: PexelsPhoto): string | null {
    return photo.src.large || photo.src.large2x || photo.src.original || null;
}

function mimeFromContentType(contentType: string | null): string | null {
    if (!contentType) {
        return null;
    }
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    return mime.startsWith("image/") ? mime : null;
}

function extensionFromMime(mime: string): string {
    switch (mime) {
        case "image/jpeg":
            return "jpg";
        case "image/png":
            return "png";
        case "image/webp":
            return "webp";
        case "image/gif":
            return "gif";
        default:
            return "jpg";
    }
}

async function searchOneImage(
    pexelsApiKey: string,
    query: string,
): Promise<{ bytes: Uint8Array; mime: string; credit: string }> {
    const searchUrl =
        `${PEXELS_API_BASE}/search?query=${encodeURIComponent(query)}` +
        `&per_page=3&orientation=landscape&size=large`;
    let searchResponse: Response;
    try {
        searchResponse = await fetch(searchUrl, {
            headers: { Authorization: pexelsApiKey },
        });
    } catch (error) {
        throw new Error(`Pexels 搜索请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (searchResponse.status === 401 || searchResponse.status === 403) {
        throw new Error("Pexels API Key 无效或无权限，请检查 AI 写作设置");
    }
    if (!searchResponse.ok) {
        throw new Error(`Pexels 搜索失败（HTTP ${searchResponse.status}）`);
    }
    const data = (await searchResponse.json()) as { photos?: PexelsPhoto[] };
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const photo = photos.find((item) => pickPexelsPhotoUrl(item));
    if (!photo) {
        throw new Error(`Pexels 没有找到「${query}」相关的图片`);
    }
    const imageUrl = pickPexelsPhotoUrl(photo)!;
    let imageResponse: Response;
    try {
        imageResponse = await fetch(imageUrl);
    } catch (error) {
        throw new Error(`图片下载失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!imageResponse.ok) {
        throw new Error(`图片下载失败（HTTP ${imageResponse.status}）`);
    }
    const mime = mimeFromContentType(imageResponse.headers.get("content-type")) ?? "image/jpeg";
    const bytes = new Uint8Array(await imageResponse.arrayBuffer());
    if (bytes.byteLength === 0) {
        throw new Error("下载到的图片是空的");
    }
    if (bytes.byteLength > R2_DIRECT_MAX_BYTES.image) {
        throw new Error("搜索到的图片超过 10MB 上限");
    }
    const credit = `Photo by ${photo.photographer} on Pexels`;
    return { bytes, mime, credit };
}

/**
 * 图片落盘：先建资产行（拿到 id），再 PUT 到 R2，最后回填 r2Key。
 * R2 写入失败时删除资产行，不留 uploading 孤儿。
 */
async function storeImageAsset(
    env: Env,
    db: DB,
    input: {
        bytes: Uint8Array;
        mime: string;
        alt: string;
        mode: Exclude<AIComposeImageMode, "none">;
        credit?: string;
        index: number;
    },
): Promise<ComposeAsset> {
    const now = new Date();
    const filename = `ai-${input.mode}-${input.index + 1}.${extensionFromMime(input.mime)}`;
    const inserted = await insertMediaAsset(db, {
        kind: "image",
        source: "r2",
        mime: input.mime,
        altText: input.alt,
        title: input.alt,
        streamStatus: "ready",
        uploadSessionJson: JSON.stringify({
            ai_image: true,
            mode: input.mode,
            credit: input.credit ?? null,
        }),
        createdAt: now,
        updatedAt: now,
    });
    const assetId = inserted?.insertedId;
    if (!assetId) {
        throw new Error("创建媒体资产失败");
    }
    const key = buildDirectUploadKey(assetId, filename);
    try {
        await putStorageObjectAtKey(env, key, input.bytes, input.mime);
    } catch (error) {
        await deleteMediaAssetById(db, assetId).catch(() => {});
        throw new Error(`图片存入 R2 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    await updateMediaAssetById(db, assetId, { r2Key: key });
    return {
        id: String(assetId),
        type: "image",
        provider: "r2",
        note: input.alt,
    };
}

/**
 * 配图主流程：规划 → 逐张生成/搜索 → 落盘。
 * 单张失败不影响其他张；全部失败才抛错（上层把任务标 failed）。
 */
export async function prepareAIComposeImages(
    env: Env,
    db: DB,
    writerConfig: AIWriterConfig,
    input: AIImagePlanInput,
): Promise<AIImagePrepareResult> {
    const count = normalizeImageCount(input.count);
    const mode = input.mode;

    if (mode === "search" && !writerConfig.pexels_api_key) {
        throw new Error("搜索图片需要先在 AI 写作设置里填写 Pexels API Key");
    }

    const planned = await planImages(env, writerConfig, mode, count, input.topic);
    const assets: ComposeAsset[] = [];
    const errors: string[] = [];

    for (let index = 0; index < planned.length; index++) {
        const brief = planned[index]!;
        try {
            const fetched =
                mode === "generate"
                    ? { ...(await generateOneImage(env, brief.prompt)), credit: undefined }
                    : await searchOneImage(writerConfig.pexels_api_key, brief.prompt);
            const asset = await storeImageAsset(env, db, {
                bytes: fetched.bytes,
                mime: fetched.mime,
                alt: brief.alt || `配图 ${index + 1}`,
                mode,
                credit: fetched.credit,
                index,
            });
            assets.push(asset);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[AI Compose] 第 ${index + 1} 张配图失败：`, message);
            errors.push(`第 ${index + 1} 张：${message}`);
        }
    }

    if (assets.length === 0) {
        throw new Error(`配图失败：${errors[0] ?? "未知错误"}`);
    }
    if (errors.length > 0) {
        console.warn(`[AI Compose] 配图部分成功（${assets.length}/${planned.length}）：${errors.join("；")}`);
    }
    return { assets };
}

/** R2 残留清理：配图失败但已有部分图片落盘时可调用（当前任务失败即整篇作废，暂不启用）。 */
export async function cleanupAIImageAssets(env: Env, db: DB, assets: ComposeAsset[]): Promise<void> {
    for (const asset of assets) {
        const id = Number(asset.id);
        if (!Number.isSafeInteger(id)) {
            continue;
        }
        try {
            const row = await findMediaAssetById(db, id);
            if (row?.r2Key) {
                await deleteStorageObject(env, row.r2Key).catch(() => {});
            }
            await deleteMediaAssetById(db, id).catch(() => {});
        } catch {
            // 清理尽力而为，不抛错。
        }
    }
}
