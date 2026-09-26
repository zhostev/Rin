/**
 * Stage 2 · 媒体栈路由。
 *
 * AdminMediaService（挂载到 /admin/media → 对外 /api/admin/media）：
 *   全部路由走 adminOnly 守卫（未授权默认 401），模式沿用 AdminStoryService。
 * StreamWebhookService（挂载到 /webhooks → 对外 /api/webhooks/stream）：
 *   公开路由，靠 STREAM_WEBHOOK_SECRET 做 HMAC 验签。
 *
 * 错误码约定：
 *   503 stream_not_configured / images_not_configured / storage_not_configured
 *       —— 服务端未配置凭据/存储（当前 Cloudflare 凭据无 Stream/Images 权限，
 *          账户侧开通前这些接口会返回 503，不崩溃）
 *   502 <op>_failed —— 上游 Cloudflare API 调用失败（附 upstreamStatus）
 *   500 stream_webhook_secret_not_configured —— webhook secret 未配置（拒绝验签，不静默通过）
 *   401 webhook_signature_missing / webhook_signature_invalid
 *
 * R2 视频链路（用户决策：视频走 R2，Stream 暂不开通）：
 *   POST /video —— multipart 上传视频（video/*，≤100MB），R2 binding 优先否则 S3
 *   POST /video/:id/poster —— 上传封面图并关联（image/*，≤10MB；重复上传替换旧封面）
 *   POST /video/:id/subtitles —— 上传字幕并关联（.vtt，≤1MB；重复上传替换旧字幕）
 *   DELETE /video/:id/poster ｜ DELETE /video/:id/subtitles —— 解除关联并删除对应资产
 *   DELETE /:id 删除视频时级联删除其封面/字幕资产行与 R2 对象。
 */
import { Hono } from "hono";
import type { AppContext, DB, Variables } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import { loadLinkedAssetRows, serializeMediaAsset } from "../features/media/asset";
import { uploadAudioObject } from "../features/media/audio";
import {
    CloudflareApiError,
    MediaNotConfiguredError,
} from "../features/media/client";
import {
    buildVariantsRecord,
    CloudflareImagesClient,
} from "../features/media/images";
import {
    deleteMediaAssetById,
    findMediaAssetById,
    findMediaAssetByImagesId,
    findMediaAssetByStreamUid,
    insertMediaAsset,
    isMediaKind,
    listMediaAssets,
    updateMediaAssetById,
    type MediaAssetRow,
    type MediaKind,
} from "../features/media/repository";
import {
    parseProbedNumber,
    uploadVideoObject,
    validateUploadFile,
    VIDEO_MAX_BYTES,
    type VideoUploadKind,
} from "../features/media/video";
import {
    CloudflareStreamClient,
    computeStreamSync,
} from "../features/media/stream";
import {
    buildDirectUploadKey,
    presignR2PutUrl,
    R2DirectNotConfiguredError,
    resolveR2DirectConfig,
    validateDirectUploadRequest,
    type R2DirectKind,
} from "../features/media/r2-direct";
import {
    downloadImageBytes,
    filenameFromUrl,
    isInstagramPostUrl,
    parseRemoteImageUrl,
    RemoteImageDownloadError,
    resolveInstagramImageUrl,
} from "../features/media/from-url";
import { headStorageObject, putStorageObjectAtKey } from "../utils/storage";
import { createS3Client, deleteObject } from "../utils/s3";
import {
    applyStreamWebhook,
    verifyStreamWebhookSignature,
    WebhookConfigError,
} from "../features/media/webhook";

type HonoApp = Hono<{
    Bindings: Env;
    Variables: Variables;
}>;

function parsePositiveInteger(value: string | undefined, fallback: number, maximum?: number) {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return maximum ? Math.min(parsed, maximum) : parsed;
}

function parseMediaId(value: string): number | null {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
}

/** 503：服务端未配置凭据（token 全部走环境变量读取，缺失绝不崩溃） */
function notConfigured(c: AppContext, error: unknown): Response {
    if (error instanceof MediaNotConfiguredError) {
        return c.json({ error: { code: error.code, message: error.message } }, 503);
    }
    console.error("[media] unexpected error while resolving config", error);
    return c.json({ error: { code: "media_internal_error", message: "Internal error" } }, 500);
}

/** 502：上游 Cloudflare API 失败 → 清晰错误码 + 日志，不抛裸异常 */
function upstreamError(c: AppContext, error: unknown, code: string): Response {
    if (error instanceof CloudflareApiError) {
        console.error(`[media] ${code}: upstream HTTP ${error.status}: ${error.message}`);
        return c.json({
            error: {
                code,
                message: error.message,
                ...(error.status ? { upstreamStatus: error.status } : {}),
            },
        }, 502);
    }
    console.error(`[media] ${code}: unexpected error`, error);
    return c.json({ error: { code, message: "Internal error" } }, 500);
}

interface DirectUploadBody {
    filename?: unknown;
    maxDurationSeconds?: unknown;
    meta?: unknown;
}

function parseDirectUploadBody(value: unknown): { filename: string; maxDurationSeconds?: number; meta: Record<string, string> } | { error: string } {
    if (!value || typeof value !== "object") {
        return { error: "Invalid JSON body" };
    }
    const body = value as DirectUploadBody;
    const filename = typeof body.filename === "string" ? body.filename : "";

    let maxDurationSeconds: number | undefined;
    if (body.maxDurationSeconds !== undefined) {
        if (!Number.isInteger(body.maxDurationSeconds) || (body.maxDurationSeconds as number) <= 0) {
            return { error: "maxDurationSeconds must be a positive integer" };
        }
        maxDurationSeconds = body.maxDurationSeconds as number;
    }

    const meta: Record<string, string> = {};
    if (body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)) {
        for (const [key, val] of Object.entries(body.meta as Record<string, unknown>)) {
            if (typeof val === "string") {
                meta[key] = val;
            }
        }
    }

    return { filename, maxDurationSeconds, meta };
}

/** R2/S3 存储可用性检查：不可用时返回 503 响应，可用时返回 null。 */
function requireStorage(c: AppContext, what: string): Response | null {
    const env = c.get('env');
    if (env.R2_BUCKET) {
        return null;
    }
    const missing = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET']
        .filter((key) => !(env as unknown as Record<string, unknown>)[key]);
    if (missing.length > 0) {
        return c.json({
            error: {
                code: 'storage_not_configured',
                message: `${what} storage is not configured (missing: ${missing.join(', ')})`,
            },
        }, 503);
    }
    return null;
}

/** 删远端对象（R2，失败只记日志不阻断）+ 删 D1 行：级联删除与上传回滚共用。 */
async function deleteAssetWithObject(db: DB, env: Env, row: MediaAssetRow): Promise<void> {
    if (row.source === 'r2' && row.r2Key && env.R2_BUCKET) {
        try {
            await env.R2_BUCKET.delete(row.r2Key);
        } catch (error) {
            console.error(`[media] failed to delete r2 object ${row.r2Key}:`, error);
        }
    }
    await deleteMediaAssetById(db, row.id);
}

/** 校验结果 → 400/413 JSON 错误响应（code 直接透传 validateUploadFile 的 code）。 */
function invalidUploadFile(c: AppContext, validation: { code?: string; message?: string }): Response {
    const status = validation.code === 'video_too_large' ? 413 : 400;
    return c.json({ error: { code: validation.code ?? 'video_invalid_mime', message: validation.message ?? 'Invalid file' } }, status);
}

/**
 * 管理端媒体服务（挂载到 /admin/media → 对外 /api/admin/media）。
 */
export function AdminMediaService(): HonoApp {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // POST /admin/media/stream/direct-upload —— 创建 Stream 直接上传会话 + 建 media_assets 行
    app.post('/stream/direct-upload', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');

        let raw: unknown;
        try {
            raw = await c.req.json();
        } catch {
            return c.text('Invalid JSON body', 400);
        }
        const parsed = parseDirectUploadBody(raw);
        if ("error" in parsed) {
            return c.text(parsed.error, 400);
        }

        let client: CloudflareStreamClient;
        try {
            client = CloudflareStreamClient.fromEnv(env);
        } catch (error) {
            return notConfigured(c, error);
        }

        let upload: { uid: string; uploadURL: string };
        try {
            upload = await client.createDirectUpload({
                maxDurationSeconds: parsed.maxDurationSeconds,
                meta: parsed.meta,
            });
        } catch (error) {
            return upstreamError(c, error, 'stream_direct_upload_failed');
        }

        const now = new Date();
        const inserted = await insertMediaAsset(db, {
            kind: 'video',
            source: 'stream',
            title: parsed.filename,
            streamUid: upload.uid,
            streamStatus: 'uploading',
            uploadSessionJson: JSON.stringify({
                uploadURL: upload.uploadURL,
                createdAt: now.toISOString(),
                maxDurationSeconds: parsed.maxDurationSeconds ?? null,
                meta: parsed.meta,
            }),
            createdAt: now,
            updatedAt: now,
        });
        if (!inserted) {
            return c.text('Failed to insert media asset', 500);
        }

        const row = await findMediaAssetById(db, inserted.insertedId);
        if (!row) {
            return c.text('Failed to load media asset', 500);
        }
        // uploadURL 必须返回给浏览器做直传（一次性 URL）；asset 供编辑器嵌入 payload。
        return c.json({ asset: serializeMediaAsset(row), uploadURL: upload.uploadURL }, 201);
    }));

    // GET /admin/media/stream/:uid —— 调 Stream getVideo 同步 D1 状态后返回 asset
    app.get('/stream/:uid', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');
        const uid = c.req.param('uid');
        if (!uid) {
            return c.text('Not found', 404);
        }

        const row = await findMediaAssetByStreamUid(db, uid);
        if (!row) {
            return c.text('Not found', 404);
        }

        let client: CloudflareStreamClient;
        try {
            client = CloudflareStreamClient.fromEnv(env);
        } catch (error) {
            return notConfigured(c, error);
        }

        let video: {
            status?: { state?: string; pctComplete?: string; errorReasonCode?: string; errorReasonText?: string };
            duration?: number;
            thumbnail?: string;
            readyToStream?: boolean;
        };
        try {
            video = await client.getVideo(uid);
        } catch (error) {
            return upstreamError(c, error, 'stream_get_video_failed');
        }

        const decision = computeStreamSync(row.streamStatus, row.streamMetaJson, {
            state: video.status?.state ?? null,
            errorReasonCode: video.status?.errorReasonCode ?? null,
            errorReasonText: video.status?.errorReasonText ?? null,
            duration: typeof video.duration === "number" ? video.duration : null,
            thumbnail: typeof video.thumbnail === "string" ? video.thumbnail : null,
            readyToStream: typeof video.readyToStream === "boolean" ? video.readyToStream : null,
            pctComplete: typeof video.status?.pctComplete === "string" ? video.status.pctComplete : null,
        });
        if (decision.changed) {
            await updateMediaAssetById(db, row.id, {
                ...decision.patch,
                updatedAt: new Date(),
            });
        }

        const updated = await findMediaAssetById(db, row.id);
        return c.json(serializeMediaAsset(updated ?? row));
    }));

    // POST /admin/media/images/direct-upload —— 创建 Images 直接上传会话 + 建行
    app.post('/images/direct-upload', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');

        let client: CloudflareImagesClient;
        try {
            client = CloudflareImagesClient.fromEnv(env);
        } catch (error) {
            return notConfigured(c, error);
        }

        let upload: { id: string; uploadURL: string };
        try {
            upload = await client.createDirectUpload();
        } catch (error) {
            return upstreamError(c, error, 'images_direct_upload_failed');
        }

        const now = new Date();
        const inserted = await insertMediaAsset(db, {
            kind: 'image',
            source: 'cloudflare_images',
            imagesId: upload.id,
            uploadSessionJson: JSON.stringify({
                uploadURL: upload.uploadURL,
                createdAt: now.toISOString(),
            }),
            createdAt: now,
            updatedAt: now,
        });
        if (!inserted) {
            return c.text('Failed to insert media asset', 500);
        }

        const row = await findMediaAssetById(db, inserted.insertedId);
        if (!row) {
            return c.text('Failed to load media asset', 500);
        }
        return c.json({ asset: serializeMediaAsset(row), uploadURL: upload.uploadURL }, 201);
    }));

    // POST /admin/media/images/:id/finalize —— 直传完成后拉取 variants 并更新行
    app.post('/images/:id/finalize', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');
        const id = c.req.param('id');
        if (!id) {
            return c.text('Not found', 404);
        }

        const row = await findMediaAssetByImagesId(db, id);
        if (!row) {
            return c.text('Not found', 404);
        }

        let client: CloudflareImagesClient;
        try {
            client = CloudflareImagesClient.fromEnv(env);
        } catch (error) {
            return notConfigured(c, error);
        }

        let image: { variants?: string[] };
        try {
            image = await client.getImage(id);
        } catch (error) {
            return upstreamError(c, error, 'images_get_failed');
        }

        // 变体 URL 直接采用 API 返回的完整 URL；变体名默认 thumb/medium/large，
        // 缺失时序列化层回退 public 变体（见 serializeMediaAsset）。
        const variants = buildVariantsRecord(image.variants);
        await updateMediaAssetById(db, row.id, {
            imagesVariantsJson: JSON.stringify(variants),
            updatedAt: new Date(),
        });

        const updated = await findMediaAssetById(db, row.id);
        return c.json(serializeMediaAsset(updated ?? row));
    }));

    // GET /admin/media/r2/health —— R2 直传凭证诊断（服务端真实 PUT + DELETE 探测）
    //   用与直传完全相同的签名逻辑签发 presigned PUT URL，服务端直接 PUT 一个探测小文件
    //   （服务端不受 CORS 影响，能看到 R2 返回的真实 HTTP 状态），随后删除探测文件。
    //   200 = 密钥有效且可写；403 = 密钥无效/权限不足；其他 4xx/5xx = 按 r2Code 排查。
    //   永远不返回密钥与签名内容。
    app.get('/r2/health', adminOnly(async (c) => {
        const env = c.get('env');
        try {
            resolveR2DirectConfig(env);
        } catch (error) {
            if (error instanceof R2DirectNotConfiguredError) {
                return c.json({ ok: false, code: error.code, message: error.message }, 503);
            }
            throw error;
        }
        const key = `media/original/__healthcheck__/ping-${Date.now()}.txt`;
        let uploadURL: string;
        try {
            uploadURL = await presignR2PutUrl(env, key, 600);
        } catch (error) {
            return c.json({ ok: false, code: 'sign_failed', message: String(error) }, 500);
        }
        let urlHost = '';
        try {
            urlHost = new URL(uploadURL).host;
        } catch {
            urlHost = '';
        }

        let putStatus = 0;
        let r2Code = '';
        try {
            const putRes = await fetch(uploadURL, {
                method: 'PUT',
                headers: { 'Content-Type': 'text/plain' },
                body: 'healthcheck',
            });
            putStatus = putRes.status;
            const text = await putRes.text();
            const m = /<Code>([^<]*)<\/Code>/.exec(text);
            if (m) r2Code = m[1];
        } catch (error) {
            return c.json({ ok: false, code: 'put_threw', urlHost, key, message: String(error) }, 200);
        }

        let deleted: boolean | null = null;
        if (putStatus >= 200 && putStatus < 300) {
            try {
                await deleteObject(createS3Client(env), env, key);
                deleted = true;
            } catch {
                deleted = false;
            }
        }

        return c.json({
            ok: putStatus >= 200 && putStatus < 300,
            putStatus,
            r2Code,
            deleted,
            urlHost,
            key,
        });
    }));

    // POST /admin/media/r2/direct-upload —— R2 presigned 直传建单（图片/视频/音频）
    //   JSON body: { kind*, filename?, mimeType*, size*, title?, duration?, width?, height? }
    //   201 -> { asset, uploadURL, key }；浏览器随后直接 PUT 文件到 uploadURL，
    //   再调 POST /r2/:id/complete 收尾。413 = 超过直传上限，503 = 未配置 S3 凭证。
    app.post('/r2/direct-upload', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');

        let body: Record<string, unknown>;
        try {
            body = await c.req.json() as Record<string, unknown>;
        } catch {
            return c.json({ error: { code: 'invalid_json', message: 'Request body must be JSON' } }, 400);
        }

        const kind = body['kind'];
        const validation = validateDirectUploadRequest({
            kind,
            mimeType: body['mimeType'],
            size: body['size'],
        });
        if (!validation.ok) {
            const status = validation.code === 'direct_too_large' ? 413 : 400;
            return c.json({ error: { code: validation.code, message: validation.message } }, status);
        }
        const directKind = kind as R2DirectKind;

        // 先校验 S3 凭证配置，避免建出孤儿行（503 时前端回退旧中转链路）
        try {
            resolveR2DirectConfig(env);
        } catch (error) {
            if (error instanceof R2DirectNotConfiguredError) {
                return c.json({ error: { code: error.code, message: error.message } }, 503);
            }
            throw error;
        }

        const now = new Date();
        const filename = typeof body['filename'] === 'string' ? body['filename'] : '';
        const mimeType = typeof body['mimeType'] === 'string' ? body['mimeType'] : '';
        const title = typeof body['title'] === 'string' ? body['title'].slice(0, 200) : '';
        const duration = parseProbedNumber(body['duration']);
        const width = parseProbedNumber(body['width']);
        const height = parseProbedNumber(body['height']);

        const inserted = await insertMediaAsset(db, {
            kind: directKind,
            source: 'r2',
            mime: mimeType,
            title,
            duration: duration ?? undefined,
            width: width ?? undefined,
            height: height ?? undefined,
            streamStatus: 'uploading',
            uploadSessionJson: JSON.stringify({ directUpload: true, createdAt: now.toISOString() }),
            createdAt: now,
            updatedAt: now,
        });
        if (!inserted) {
            return c.text('Failed to insert media asset', 500);
        }
        const assetId = inserted.insertedId;
        const key = buildDirectUploadKey(assetId, filename);

        let uploadURL: string;
        try {
            uploadURL = await presignR2PutUrl(env, key);
        } catch (error) {
            await deleteMediaAssetById(db, assetId);
            if (error instanceof R2DirectNotConfiguredError) {
                return c.json({ error: { code: error.code, message: error.message } }, 503);
            }
            return upstreamError(c, error, 'r2_direct_upload_sign_failed');
        }

        await updateMediaAssetById(db, assetId, {
            r2Key: key,
            uploadSessionJson: JSON.stringify({
                directUpload: true,
                key,
                createdAt: now.toISOString(),
            }),
            updatedAt: new Date(),
        });

        const row = await findMediaAssetById(db, assetId);
        if (!row) {
            return c.text('Failed to load media asset', 500);
        }
        return c.json({ asset: serializeMediaAsset(row), uploadURL, key }, 201);
    }));

    // POST /admin/media/r2/:id/complete —— 直传收尾：HEAD 确认 R2 对象存在后置 ready
    //   404 = 资产不存在，410 = 文件尚未上传（可重试），200 -> MediaAsset
    app.post('/r2/:id/complete', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');
        const id = parseMediaId(c.req.param('id') ?? '');
        if (id === null) {
            return c.text('Not found', 404);
        }

        const row = await findMediaAssetById(db, id);
        if (!row) {
            return c.text('Not found', 404);
        }
        if (!row.r2Key) {
            return c.json({
                error: { code: 'no_direct_upload_session', message: 'Asset has no direct upload session' },
            }, 400);
        }

        let head: Response | null;
        try {
            head = await headStorageObject(env, row.r2Key);
        } catch (error) {
            return upstreamError(c, error, 'r2_direct_upload_verify_failed');
        }
        if (!head) {
            return c.json({
                error: { code: 'upload_incomplete', message: 'Object not found in storage yet' },
            }, 410);
        }

        await updateMediaAssetById(db, id, {
            streamStatus: 'ready',
            updatedAt: new Date(),
        });

        const updated = await findMediaAssetById(db, id);
        return c.json(serializeMediaAsset(updated ?? row));
    }));

    // POST /admin/media/from-url —— 从 URL 下载图片并存入媒体库（服务端直抓 → R2）
    //   JSON body: { url*, title?, alt? }
    //   201 -> MediaAsset（asset.url 为站内 /api/blob/<key>）
    //   400 invalid_url/url_not_allowed；413 image_too_large；415 not_an_image/empty_image；
    //   422 instagram_resolve_failed（Instagram 帖子页解析失败）；
    //   502 download_failed/image_download_store_failed；503 storage_not_configured
    //   Instagram 帖子/快拍链接（/p/、/reel/）会自动解析 og:image 首图下载。
    app.post('/from-url', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');

        let body: Record<string, unknown>;
        try {
            body = await c.req.json() as Record<string, unknown>;
        } catch {
            return c.json({ error: { code: 'invalid_json', message: 'Request body must be JSON' } }, 400);
        }

        const parsed = parseRemoteImageUrl(body['url']);
        if ('error' in parsed) {
            const message = parsed.error === 'invalid_url'
                ? 'Invalid image URL (expected http(s) URL)'
                : 'URL host is not allowed';
            return c.json({ error: { code: parsed.error, message } }, 400);
        }

        const storageError = requireStorage(c, 'Image download');
        if (storageError) {
            return storageError;
        }

        const title = typeof body['title'] === 'string' ? body['title'].slice(0, 200) : '';
        const alt = typeof body['alt'] === 'string' ? body['alt'].slice(0, 500) : '';

        let downloaded: { bytes: Uint8Array; mime: string };
        // Instagram 帖子页先解析出 og:image 直链再下载（轮播帖取首图）
        let targetUrl = parsed.url;
        if (isInstagramPostUrl(targetUrl)) {
            try {
                const resolved = await resolveInstagramImageUrl(targetUrl);
                const revalidated = parseRemoteImageUrl(resolved);
                if ("error" in revalidated) {
                    return c.json({
                        error: { code: "instagram_resolve_failed", message: "解析出的图片地址无效" },
                    }, 422);
                }
                targetUrl = revalidated.url;
            } catch (error) {
                if (error instanceof RemoteImageDownloadError) {
                    return c.json({
                        error: {
                            code: error.code,
                            message: error.message,
                            ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
                        },
                    }, 422);
                }
                return upstreamError(c, error, "instagram_resolve_failed");
            }
        }
        try {
            downloaded = await downloadImageBytes(targetUrl.toString());
        } catch (error) {
            if (error instanceof RemoteImageDownloadError) {
                const status = error.code === 'image_too_large'
                    ? 413
                    : error.code === 'not_an_image' || error.code === 'empty_image'
                        ? 415
                        : 502;
                return c.json({
                    error: {
                        code: error.code,
                        message: error.message,
                        ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
                    },
                }, status);
            }
            return upstreamError(c, error, 'image_download_failed');
        }

        const now = new Date();
        const inserted = await insertMediaAsset(db, {
            kind: 'image',
            source: 'r2',
            mime: downloaded.mime,
            title,
            altText: alt || title,
            streamStatus: 'ready',
            uploadSessionJson: JSON.stringify({
                fromUrl: parsed.url.toString(),
                downloadedAt: now.toISOString(),
            }),
            createdAt: now,
            updatedAt: now,
        });
        if (!inserted) {
            return c.text('Failed to insert media asset', 500);
        }
        const assetId = inserted.insertedId;

        const key = buildDirectUploadKey(assetId, filenameFromUrl(targetUrl, downloaded.mime));
        try {
            await putStorageObjectAtKey(env, key, downloaded.bytes, downloaded.mime);
        } catch (error) {
            // R2 写入失败：删孤儿行，不留残留（R2 属于上游依赖，返回 502）
            await deleteMediaAssetById(db, assetId);
            console.error('[media] image_download_store_failed:', error);
            return c.json({
                error: {
                    code: 'image_download_store_failed',
                    message: 'Failed to write the downloaded image to storage',
                },
            }, 502);
        }
        await updateMediaAssetById(db, assetId, {
            r2Key: key,
            updatedAt: new Date(),
        });

        const row = await findMediaAssetById(db, assetId);
        if (!row) {
            return c.text('Failed to load media asset', 500);
        }
        return c.json(serializeMediaAsset(row), 201);
    }));

    // POST /admin/media/audio —— multipart 上传音频（R2 binding 优先，否则 S3）
    app.post('/audio', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');

        let form: Record<string, string | File>;
        try {
            form = await c.req.parseBody() as Record<string, string | File>;
        } catch {
            return c.text('Invalid multipart body', 400);
        }

        const file = form['file'];
        if (!(file instanceof File)) {
            return c.json({ error: { code: 'audio_file_required', message: 'multipart field "file" is required' } }, 400);
        }
        const title = typeof form['title'] === 'string' ? form['title'] : '';

        // 无 R2 binding 时走 S3：先校验配置，避免建出孤儿行
        if (!env.R2_BUCKET) {
            const missing = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET']
                .filter((key) => !(env as unknown as Record<string, unknown>)[key]);
            if (missing.length > 0) {
                return c.json({
                    error: {
                        code: 'storage_not_configured',
                        message: `Audio upload storage is not configured (missing: ${missing.join(', ')})`,
                    },
                }, 503);
            }
        }

        const now = new Date();
        const inserted = await insertMediaAsset(db, {
            kind: 'audio',
            source: 'r2',
            mime: file.type || '',
            title,
            createdAt: now,
            updatedAt: now,
        });
        if (!inserted) {
            return c.text('Failed to insert media asset', 500);
        }
        const assetId = inserted.insertedId;

        try {
            const result = await uploadAudioObject(env, assetId, file, file.name, file.type || undefined);
            await updateMediaAssetById(db, assetId, {
                r2Key: result.key,
                updatedAt: new Date(),
            });
        } catch (error) {
            // 上传失败：清理孤儿行
            await deleteMediaAssetById(db, assetId);
            return upstreamError(c, error, 'audio_upload_failed');
        }

        const row = await findMediaAssetById(db, assetId);
        if (!row) {
            return c.text('Failed to load media asset', 500);
        }
        return c.json(serializeMediaAsset(row), 201);
    }));

    // POST /admin/media/video —— multipart 上传视频到 R2
    //   fields: file*（video/*，≤100MB）、title?、duration?、width?、height?
    //   （duration/width/height 由客户端 probeMediaFile 探测后上报，非法值忽略）
    //   201 -> MediaAsset（asset.url 为站内 /api/blob/<key>）
    app.post('/video', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');

        let form: Record<string, string | File>;
        try {
            form = await c.req.parseBody() as Record<string, string | File>;
        } catch {
            return c.text('Invalid multipart body', 400);
        }

        const validation = validateUploadFile(form['file'], 'video');
        if (!validation.ok) {
            return invalidUploadFile(c, validation);
        }
        const file = form['file'] as File;
        const title = typeof form['title'] === 'string' ? form['title'] : '';

        const storageError = requireStorage(c, 'Video upload');
        if (storageError) {
            return storageError;
        }

        const now = new Date();
        const inserted = await insertMediaAsset(db, {
            kind: 'video',
            source: 'r2',
            mime: file.type || '',
            title,
            duration: parseProbedNumber(form['duration']),
            width: (() => { const n = parseProbedNumber(form['width']); return n === undefined ? undefined : Math.round(n); })(),
            height: (() => { const n = parseProbedNumber(form['height']); return n === undefined ? undefined : Math.round(n); })(),
            createdAt: now,
            updatedAt: now,
        });
        if (!inserted) {
            return c.text('Failed to insert media asset', 500);
        }
        const assetId = inserted.insertedId;

        let uploadedKey: string | undefined;
        try {
            const result = await uploadVideoObject(env, assetId, file, file.name, file.type || undefined);
            uploadedKey = result.key;
            await updateMediaAssetById(db, assetId, {
                r2Key: result.key,
                updatedAt: new Date(),
            });
        } catch (error) {
            // 回滚：R2 对象已上传则删除，避免 R2 孤儿对象；再删 D1 孤儿行
            if (uploadedKey && env.R2_BUCKET) {
                try {
                    await env.R2_BUCKET.delete(uploadedKey);
                } catch (deleteError) {
                    console.error(`[media] failed to roll back r2 object ${uploadedKey}:`, deleteError);
                }
            }
            await deleteMediaAssetById(db, assetId);
            return upstreamError(c, error, 'video_upload_failed');
        }

        const row = await findMediaAssetById(db, assetId);
        if (!row) {
            return c.text('Failed to load media asset', 500);
        }
        return c.json(serializeMediaAsset(row), 201);
    }));

    // POST /admin/media/video/:id/poster —— 上传封面图并关联到视频
    //   fields: file*（image/*，≤10MB）。重复上传替换旧封面（旧资产行 + R2 对象一并删除）。
    //   200 -> MediaAsset（带 poster_asset_id / poster_url）
    app.post('/video/:id/poster', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');
        const id = parseMediaId(c.req.param('id'));
        if (id === null) {
            return c.text('Not found', 404);
        }

        const video = await findMediaAssetById(db, id);
        if (!video || video.kind !== 'video') {
            return c.text('Not found', 404);
        }

        let form: Record<string, string | File>;
        try {
            form = await c.req.parseBody() as Record<string, string | File>;
        } catch {
            return c.text('Invalid multipart body', 400);
        }

        const validation = validateUploadFile(form['file'], 'poster');
        if (!validation.ok) {
            return invalidUploadFile(c, validation);
        }
        const file = form['file'] as File;

        const storageError = requireStorage(c, 'Poster upload');
        if (storageError) {
            return storageError;
        }

        const now = new Date();
        const inserted = await insertMediaAsset(db, {
            kind: 'image',
            source: 'r2',
            mime: file.type || '',
            title: typeof form['title'] === 'string' ? form['title'] : file.name,
            createdAt: now,
            updatedAt: now,
        });
        if (!inserted) {
            return c.text('Failed to insert media asset', 500);
        }
        const posterId = inserted.insertedId;

        let uploadedKey: string | undefined;
        try {
            const result = await uploadVideoObject(env, posterId, file, file.name, file.type || undefined);
            uploadedKey = result.key;
            await updateMediaAssetById(db, posterId, { r2Key: result.key, updatedAt: new Date() });
        } catch (error) {
            if (uploadedKey && env.R2_BUCKET) {
                try {
                    await env.R2_BUCKET.delete(uploadedKey);
                } catch (deleteError) {
                    console.error(`[media] failed to roll back r2 object ${uploadedKey}:`, deleteError);
                }
            }
            await deleteMediaAssetById(db, posterId);
            return upstreamError(c, error, 'poster_upload_failed');
        }

        // 替换旧封面：先挂新引用，再删旧资产（旧资产删除失败不阻断）
        const oldPosterId = video.posterAssetId;
        await updateMediaAssetById(db, video.id, { posterAssetId: posterId, updatedAt: new Date() });
        if (oldPosterId && oldPosterId !== posterId) {
            const oldRow = await findMediaAssetById(db, oldPosterId);
            if (oldRow) {
                await deleteAssetWithObject(db, env, oldRow);
            }
        }

        const updated = await findMediaAssetById(db, video.id);
        const poster = await findMediaAssetById(db, posterId);
        if (!updated || !poster) {
            return c.text('Failed to load media asset', 500);
        }
        // 同时带上已有的字幕关联，避免挂字幕后再换封面时字幕 URL 丢失
        const linked = await loadLinkedAssetRows(db, [updated]);
        return c.json(serializeMediaAsset(updated, linked.get(updated.id)));
    }));

    // POST /admin/media/video/:id/subtitles —— 上传字幕并关联到视频
    //   fields: file*（.vtt，≤1MB）。重复上传替换旧字幕。
    //   200 -> MediaAsset（带 subtitles_asset_id / subtitles_url）
    app.post('/video/:id/subtitles', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');
        const id = parseMediaId(c.req.param('id'));
        if (id === null) {
            return c.text('Not found', 404);
        }

        const video = await findMediaAssetById(db, id);
        if (!video || video.kind !== 'video') {
            return c.text('Not found', 404);
        }

        let form: Record<string, string | File>;
        try {
            form = await c.req.parseBody() as Record<string, string | File>;
        } catch {
            return c.text('Invalid multipart body', 400);
        }

        const validation = validateUploadFile(form['file'], 'subtitles');
        if (!validation.ok) {
            return invalidUploadFile(c, validation);
        }
        const file = form['file'] as File;

        const storageError = requireStorage(c, 'Subtitles upload');
        if (storageError) {
            return storageError;
        }

        const now = new Date();
        const inserted = await insertMediaAsset(db, {
            kind: 'attachment',
            source: 'r2',
            mime: 'text/vtt',
            title: typeof form['title'] === 'string' ? form['title'] : file.name,
            createdAt: now,
            updatedAt: now,
        });
        if (!inserted) {
            return c.text('Failed to insert media asset', 500);
        }
        const subtitlesId = inserted.insertedId;

        let uploadedKey: string | undefined;
        try {
            const result = await uploadVideoObject(env, subtitlesId, file, file.name, 'text/vtt');
            uploadedKey = result.key;
            await updateMediaAssetById(db, subtitlesId, { r2Key: result.key, updatedAt: new Date() });
        } catch (error) {
            if (uploadedKey && env.R2_BUCKET) {
                try {
                    await env.R2_BUCKET.delete(uploadedKey);
                } catch (deleteError) {
                    console.error(`[media] failed to roll back r2 object ${uploadedKey}:`, deleteError);
                }
            }
            await deleteMediaAssetById(db, subtitlesId);
            return upstreamError(c, error, 'subtitles_upload_failed');
        }

        const oldSubtitlesId = video.subtitlesAssetId;
        await updateMediaAssetById(db, video.id, { subtitlesAssetId: subtitlesId, updatedAt: new Date() });
        if (oldSubtitlesId && oldSubtitlesId !== subtitlesId) {
            const oldRow = await findMediaAssetById(db, oldSubtitlesId);
            if (oldRow) {
                await deleteAssetWithObject(db, env, oldRow);
            }
        }

        const updated = await findMediaAssetById(db, video.id);
        const subtitles = await findMediaAssetById(db, subtitlesId);
        if (!updated || !subtitles) {
            return c.text('Failed to load media asset', 500);
        }
        // 同时带上已有的封面关联，避免挂封面后再加字幕时封面 URL 丢失
        const linked = await loadLinkedAssetRows(db, [updated]);
        return c.json(serializeMediaAsset(updated, linked.get(updated.id)));
    }));

    // DELETE /admin/media/video/:id/poster —— 解除封面关联并删除封面资产（行 + R2 对象）
    app.delete('/video/:id/poster', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');
        const id = parseMediaId(c.req.param('id'));
        if (id === null) {
            return c.text('Not found', 404);
        }

        const video = await findMediaAssetById(db, id);
        if (!video || video.kind !== 'video') {
            return c.text('Not found', 404);
        }
        if (!video.posterAssetId) {
            return c.text('Not found', 404);
        }

        const poster = await findMediaAssetById(db, video.posterAssetId);
        await updateMediaAssetById(db, video.id, { posterAssetId: null, updatedAt: new Date() });
        if (poster) {
            await deleteAssetWithObject(db, env, poster);
        }
        return c.text('Deleted');
    }));

    // DELETE /admin/media/video/:id/subtitles —— 解除字幕关联并删除字幕资产（行 + R2 对象）
    app.delete('/video/:id/subtitles', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');
        const id = parseMediaId(c.req.param('id'));
        if (id === null) {
            return c.text('Not found', 404);
        }

        const video = await findMediaAssetById(db, id);
        if (!video || video.kind !== 'video') {
            return c.text('Not found', 404);
        }
        if (!video.subtitlesAssetId) {
            return c.text('Not found', 404);
        }

        const subtitles = await findMediaAssetById(db, video.subtitlesAssetId);
        await updateMediaAssetById(db, video.id, { subtitlesAssetId: null, updatedAt: new Date() });
        if (subtitles) {
            await deleteAssetWithObject(db, env, subtitles);
        }
        return c.text('Deleted');
    }));

    // GET /admin/media —— 媒体列表（?kind=video|audio|image，供媒体选择器用）
    app.get('/', adminOnly(async (c) => {
        const db = c.get('db');
        const kindParam = c.req.query('kind');
        let kind: MediaKind | undefined;
        if (kindParam !== undefined) {
            if (!isMediaKind(kindParam)) {
                return c.text('Invalid kind (expected image|video|audio|gallery|attachment)', 400);
            }
            kind = kindParam;
        }

        const page = parsePositiveInteger(c.req.query('page'), 1) - 1;
        const limit = parsePositiveInteger(c.req.query('limit'), 20, 100);

        const result = await listMediaAssets(db, {
            kind,
            limit,
            offset: page * limit,
        });

        const linked = await loadLinkedAssetRows(db, result.rows);

        return c.json({
            size: result.size,
            data: result.rows.map((row) => serializeMediaAsset(row, linked.get(row.id))),
            hasNext: result.hasNext,
        });
    }));

    // DELETE /admin/media/:id —— 删远端（失败只记日志不阻断）再删 D1 行
    //   视频资产：先级联删除其封面/字幕资产（行 + R2 对象），再删自身。
    app.delete('/:id', adminOnly(async (c) => {
        const db = c.get('db');
        const env = c.get('env');
        const id = parseMediaId(c.req.param('id'));
        if (id === null) {
            return c.text('Not found', 404);
        }

        const row = await findMediaAssetById(db, id);
        if (!row) {
            return c.text('Not found', 404);
        }

        if (row.source === 'stream' && row.streamUid) {
            try {
                await CloudflareStreamClient.fromEnv(env).deleteVideo(row.streamUid);
            } catch (error) {
                console.error(`[media] failed to delete stream video ${row.streamUid}:`, error);
            }
        } else if (row.source === 'cloudflare_images' && row.imagesId) {
            try {
                await CloudflareImagesClient.fromEnv(env).deleteImage(row.imagesId);
            } catch (error) {
                console.error(`[media] failed to delete images image ${row.imagesId}:`, error);
            }
        } else if (row.source === 'r2' && row.r2Key && env.R2_BUCKET) {
            try {
                await env.R2_BUCKET.delete(row.r2Key);
            } catch (error) {
                console.error(`[media] failed to delete r2 object ${row.r2Key}:`, error);
            }
        }

        // 视频资产：级联删除其封面/字幕资产（行 + R2 对象）；单个失败只记日志不阻断
        if (row.kind === 'video') {
            for (const linkedId of [row.posterAssetId, row.subtitlesAssetId]) {
                if (!linkedId) continue;
                try {
                    const linkedRow = await findMediaAssetById(db, linkedId);
                    if (linkedRow) {
                        await deleteAssetWithObject(db, env, linkedRow);
                    }
                } catch (error) {
                    console.error(`[media] failed to cascade-delete linked asset ${linkedId}:`, error);
                }
            }
        }

        await deleteMediaAssetById(db, id);
        return c.text('Deleted');
    }));

    return app;
}

/**
 * Stream webhook 服务（挂载到 /webhooks → 对外 /api/webhooks/stream）。
 * 公开路由：靠 STREAM_WEBHOOK_SECRET 做 HMAC-SHA256 验签。
 */
export function StreamWebhookService(): HonoApp {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    app.post('/stream', async (c) => {
        const db = c.get('db');
        const env = c.get('env');

        // secret 未配置：拒绝并报 500 级清晰错误，不静默通过
        const secret = env.STREAM_WEBHOOK_SECRET;
        if (!secret) {
            console.error('[media] rejecting stream webhook: STREAM_WEBHOOK_SECRET is not set');
            return c.json({
                error: {
                    code: new WebhookConfigError().code,
                    message: 'Stream webhook secret is not configured',
                },
            }, 500);
        }

        const signature = c.req.header('webhook-signature');
        if (!signature) {
            return c.json({ error: { code: 'webhook_signature_missing', message: 'Missing Webhook-Signature header' } }, 401);
        }

        // 验签需要原始 body（不能先 JSON.parse 再 stringify，空白/键序会改变 digest）
        const rawBody = await c.req.text();
        let valid: boolean;
        try {
            valid = await verifyStreamWebhookSignature(rawBody, signature, secret);
        } catch (error) {
            if (error instanceof WebhookConfigError) {
                return c.json({ error: { code: error.code, message: error.message } }, 500);
            }
            console.error('[media] webhook signature verification error', error);
            return c.json({ error: { code: 'webhook_verify_error', message: 'Internal error' } }, 500);
        }
        if (!valid) {
            return c.json({ error: { code: 'webhook_signature_invalid', message: 'Invalid webhook signature' } }, 401);
        }

        let payload: unknown;
        try {
            payload = JSON.parse(rawBody);
        } catch {
            return c.json({ error: { code: 'webhook_invalid_payload', message: 'Invalid JSON payload' } }, 400);
        }

        const result = await applyStreamWebhook(db, payload);
        if (!result.handled) {
            if (result.reason === 'unknown_uid') {
                console.warn('[media] stream webhook for unknown uid; acked to avoid retries');
            } else {
                console.warn(`[media] stream webhook ignored: ${result.reason}`);
            }
            return c.json({ ok: true, ignored: result.reason });
        }

        return c.json({
            ok: true,
            assetId: result.assetId,
            from: result.from,
            to: result.to,
            deduped: result.deduped,
        });
    });

    return app;
}
