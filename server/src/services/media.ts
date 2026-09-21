import { and, count, desc, eq, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import type { MediaAsset as MediaAssetContract, MediaType } from "@rin/api";
import type { AppContext, DB, Variables } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import { profileAsync } from "../core/server-timing";
import { feeds, mediaAssets } from "../db/schema";
import { deleteStorageObject, getStorageObject, putStorageObject } from "../utils/storage";

const MAX_MEDIA_SIZE = 100 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MIME_TYPES: Record<MediaType, Set<string>> = {
    audio: new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm"]),
    video: new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]),
    // SVG is intentionally excluded: it is served inline and can carry scripts.
    image: new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]),
};

/** Per-type upload ceiling for the R2/S3 path (Stream videos use MAX_STREAM_VIDEO_SIZE). */
function maxSizeForType(type: MediaType) {
    return type === "image" ? MAX_IMAGE_SIZE : MAX_MEDIA_SIZE;
}


export const MAX_STREAM_VIDEO_SIZE = 1024 * 1024 * 1024;
/** createDirectUpload (Workers binding) does not support files over 200MB; use TUS. */
export const STREAM_DIRECT_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

function encodeTusMetadataValue(value: string): string {
    return btoa(unescape(encodeURIComponent(value)));
}

/** Build Cloudflare Stream Upload-Metadata header (tus). Values are base64. */
export function buildStreamTusMetadata(options: {
    fileName?: string;
    maxDurationSeconds: number;
    creator?: string;
    requireSignedURLs?: boolean;
    allowedOrigins?: string[];
}): string {
    const parts: string[] = [
        `maxdurationseconds ${encodeTusMetadataValue(String(options.maxDurationSeconds))}`,
    ];
    if (options.fileName) {
        parts.push(`name ${encodeTusMetadataValue(options.fileName)}`);
    }
    if (options.creator) {
        parts.push(`creator ${encodeTusMetadataValue(options.creator)}`);
    }
    if (options.requireSignedURLs) {
        parts.push("requiresignedurls");
    }
    if (options.allowedOrigins?.length) {
        parts.push(`allowedorigins ${encodeTusMetadataValue(options.allowedOrigins.join(","))}`);
    }
    return parts.join(",");
}

export type StreamTusProvisionResult = {
    uploadUrl: string;
    streamUid: string;
};

/**
 * Provision a one-time TUS upload URL via Stream REST (`direct_user=true`).
 * Required for videos over 200MB (Workers createDirectUpload limit).
 */
export async function provisionStreamTusUpload(options: {
    accountId: string;
    apiToken: string;
    uploadLength: number;
    metadata: string;
}): Promise<StreamTusProvisionResult> {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/stream?direct_user=true`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${options.apiToken}`,
            "Tus-Resumable": "1.0.0",
            "Upload-Length": String(options.uploadLength),
            "Upload-Metadata": options.metadata,
        },
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `Stream TUS provision failed (${response.status}): ${body.slice(0, 300) || response.statusText}`,
        );
    }
    const uploadUrl = response.headers.get("Location");
    const streamUid =
        response.headers.get("stream-media-id") ||
        response.headers.get("Stream-Media-Id") ||
        "";
    if (!uploadUrl || !streamUid) {
        throw new Error("Stream TUS provision did not return Location / stream-media-id");
    }
    return { uploadUrl, streamUid };
}

function mediaTypeForMime(mimeType: string): MediaType | null {
    if (MIME_TYPES.audio.has(mimeType)) return "audio";
    if (MIME_TYPES.video.has(mimeType)) return "video";
    if (MIME_TYPES.image.has(mimeType)) return "image";
    return null;
}

function extensionForMime(mimeType: string) {
    const extension = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase() || "bin";
    if (extension === "mpeg") return "mp3";
    if (extension === "quicktime") return "mov";
    if (extension === "jpeg") return "jpg";
    return extension;
}

function playbackUrl(id: string) {
    return `/api/media/${encodeURIComponent(id)}/playback`;
}

function toContract(asset: typeof mediaAssets.$inferSelect, feed?: { id: number; title: string | null } | null): MediaAssetContract {
    return {
        id: asset.id,
        provider: asset.provider as MediaAssetContract["provider"],
        type: asset.type as MediaType,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
        status: asset.status as MediaAssetContract["status"],
        playbackUrl: playbackUrl(asset.id),
        createdAt: asset.createdAt.toISOString(),
        feedId: asset.feedId,
        feedTitle: feed?.title ?? null,
        streamUid: asset.streamUid,
    };
}

function extractMediaIds(content: string) {
    const ids = new Set<string>();
    // <audio>/<video> markup inserted by the editor toolbar.
    const attributePattern = /data-rin-media-id=["']([a-zA-Z0-9-]+)["']/g;
    for (const match of content.matchAll(attributePattern)) {
        if (match[1]) ids.add(match[1]);
    }
    // Playback links pasted by hand, e.g. images copied from the media library.
    const urlPattern = /\/api\/media\/([a-zA-Z0-9-]+)\/playback/g;
    for (const match of content.matchAll(urlPattern)) {
        if (match[1]) ids.add(match[1]);
    }
    return [...ids];
}

function streamPlaybackUrl(env: Env, streamUid: string) {
    const host = (env.STREAM_PUBLIC_HOST || "https://iframe.videodelivery.net").replace(/\/$/, "");
    return host ? `${host}/${encodeURIComponent(streamUid)}/iframe` : null;
}

function streamAllowedOrigin(frontendUrl?: string) {
    if (!frontendUrl) return undefined;
    try {
        return [new URL(frontendUrl).host];
    } catch {
        return undefined;
    }
}

function hexToBytes(value: string) {
    if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

async function verifyStreamWebhookSignature(signatureHeader: string | null, body: string, secret: string, now = Math.floor(Date.now() / 1000)) {
    if (!signatureHeader) return false;
    const values = Object.fromEntries(signatureHeader.split(",").map((part) => {
        const separator = part.indexOf("=");
        return separator === -1 ? [part.trim(), ""] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }));
    const timestamp = Number(values.time);
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300 || !values.sig1) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
    const expected = hexToBytes(values.sig1);
    if (!expected || expected.length !== digest.length) return false;
    let difference = 0;
    for (let index = 0; index < digest.length; index += 1) difference |= digest[index] ^ expected[index];
    return difference === 0;
}

export async function cleanupMediaAssets(db: DB, env: Env, now = new Date()) {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const stale = await db.query.mediaAssets.findMany({
        where: and(
            isNull(mediaAssets.feedId),
            lt(mediaAssets.updatedAt, cutoff),
            or(eq(mediaAssets.status, "failed"), eq(mediaAssets.status, "processing")),
        ),
    });
    let cleaned = 0;
    for (const asset of stale) {
        try {
            if (asset.provider === "stream" && env.STREAM && asset.streamUid) await env.STREAM.video(asset.streamUid).delete();
            if (asset.provider !== "stream") await deleteStorageObject(env, asset.objectKey);
            await db.delete(mediaAssets).where(eq(mediaAssets.id, asset.id));
            cleaned += 1;
        } catch (error) {
            console.warn("Failed to clean stale media asset:", asset.id, error);
        }
    }
    return cleaned;
}

async function refreshStreamAsset(db: DB, env: Env, asset: typeof mediaAssets.$inferSelect) {
    if (asset.provider !== "stream" || !asset.streamUid || !env.STREAM) return asset;
    try {
        const details = await env.STREAM.video(asset.streamUid).details();
        const nextStatus = details.readyToStream
            ? "ready"
            : details.status?.state === "error"
                ? "failed"
                : "processing";
        const [updated] = await db.update(mediaAssets).set({
            status: nextStatus,
            fileSize: details.size || asset.fileSize,
            updatedAt: new Date(),
        }).where(eq(mediaAssets.id, asset.id)).returning();
        return updated || asset;
    } catch (error) {
        console.warn("Failed to refresh Stream media status:", error);
        return asset;
    }
}

export async function syncMediaForFeed(db: DB, feedId: number, uid: number, content: string) {
    const ids = extractMediaIds(content);
    await db.update(mediaAssets).set({ feedId: null, updatedAt: new Date() }).where(eq(mediaAssets.feedId, feedId));

    for (const id of ids) {
        await db.update(mediaAssets)
            .set({ feedId, updatedAt: new Date() })
            .where(and(eq(mediaAssets.id, id), eq(mediaAssets.uid, uid)));
    }
}

async function canReadAsset(c: AppContext, asset: typeof mediaAssets.$inferSelect) {
    const uid = c.get("uid");
    const admin = c.get("admin");
    if (admin || asset.uid === uid) return true;

    if (!asset.feedId) return false;
    const feed = await c.get("db").query.feeds.findFirst({
        where: eq(feeds.id, asset.feedId),
        columns: { uid: true, draft: true },
    });
    return Boolean(feed && feed.draft === 0);
}

export function MediaService(): Hono<{
    Bindings: Env;
    Variables: Variables;
}> {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();

    app.post("/stream/webhook", async (c) => {
        const secret = c.get("env").STREAM_WEBHOOK_SECRET;
        if (!secret) return c.text("Cloudflare Stream webhook is not configured", 503);
        const body = await c.req.text();
        if (!await verifyStreamWebhookSignature(c.req.header("Webhook-Signature") || null, body, secret)) return c.text("Invalid webhook signature", 401);
        let payload: { uid?: string; id?: string; readyToStream?: boolean; size?: number; status?: { state?: string } };
        try {
            payload = JSON.parse(body);
        } catch {
            return c.text("Invalid webhook payload", 400);
        }
        const streamUid = payload.uid || payload.id;
        if (!streamUid) return c.text("Webhook video id is required", 400);
        const status = payload.readyToStream ? "ready" : payload.status?.state === "error" ? "failed" : "processing";
        await c.get("db").update(mediaAssets).set({
            status,
            fileSize: payload.size || undefined,
            updatedAt: new Date(),
        }).where(eq(mediaAssets.streamUid, streamUid));
        return c.body(null, 204);
    });

    app.get("/", adminOnly(async (c) => {
        const page = Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1);
        const limit = Math.min(50, Math.max(1, Number.parseInt(c.req.query("limit") || "20", 10) || 20));
        const offset = (page - 1) * limit;
        const db = c.get("db");
        const [sizeResult, rows] = await Promise.all([
            db.select({ count: count() }).from(mediaAssets),
            db.query.mediaAssets.findMany({
                orderBy: [desc(mediaAssets.createdAt)],
                offset,
                limit: limit + 1,
                with: { feed: { columns: { id: true, title: true } } },
            }),
        ]);
        const hasNext = rows.length > limit;
        if (hasNext) rows.pop();
        const refreshedRows = await Promise.all(rows.map((asset) => refreshStreamAsset(c.get("db"), c.get("env"), asset)));
        return c.json({
            size: sizeResult[0]?.count || 0,
            data: refreshedRows.map((asset, index) => toContract(asset, rows[index]?.feed)),
            hasNext,
        });
    }, { message: "Permission denied", status: 403 }));

    app.post("/", adminOnly(async (c) => {
        const uid = c.get("uid");
        if (!uid) return c.text("Unauthorized", 401);

        const body = await profileAsync(c, "media_parse", () => c.req.parseBody());
        const file = body.file;
        if (!(file instanceof File)) {
            return c.text("Media file is required", 400);
        }

        const mimeType = file.type.toLowerCase();
        const type = mediaTypeForMime(mimeType);
        if (!type) {
            return c.text("Unsupported image, audio or video type", 400);
        }
        if (file.size <= 0 || file.size > maxSizeForType(type)) {
            return c.text("Media file is empty or too large", 400);
        }

        const id = crypto.randomUUID();
        const key = `media/${uid}/${id}.${extensionForMime(mimeType)}`;
        let storedKey: string | undefined;
        try {
            const stored = await profileAsync(c, "media_put", () => putStorageObject(
                c.get("env"),
                key,
                file,
                mimeType,
                new URL(c.req.url).origin,
            ));
            storedKey = stored.key;

            const asset = await profileAsync(c, "media_insert", () => c.get("db").insert(mediaAssets).values({
                id,
                uid,
                provider: c.get("env").R2_BUCKET ? "r2" : "s3",
                type,
                objectKey: stored.key,
                mimeType,
                fileSize: file.size,
                status: "ready",
            }).returning().then((rows) => rows[0]));

            if (!asset) {
                await deleteStorageObject(c.get("env"), stored.key);
                return c.text("Failed to create media asset", 500);
            }
            return c.json(toContract(asset));
        } catch (error) {
            if (storedKey) await deleteStorageObject(c.get("env"), storedKey).catch(() => undefined);
            console.error("Media upload failed:", error);
            return c.text(error instanceof Error ? error.message : "Media upload failed", 400);
        }
    }, { message: "Permission denied", status: 403 }));

    app.post("/stream/upload", adminOnly(async (c) => {
        const uid = c.get("uid");
        const env = c.get("env");
        const stream = env.STREAM;
        if (!uid) return c.text("Unauthorized", 401);
        // STREAM binding still required for playback tokens / delete / details.
        if (!stream) return c.text("Cloudflare Stream is not configured", 503);

        let body: { fileName?: string; fileSize?: number; maxDurationSeconds?: number };
        try {
            body = await c.req.json();
        } catch {
            return c.text("Invalid JSON body", 400);
        }

        const fileSize = Math.floor(Number(body.fileSize) || 0);
        if (fileSize <= 0 || fileSize > MAX_STREAM_VIDEO_SIZE) {
            return c.text("Stream video fileSize is required and must be <= 1 GiB", 400);
        }

        const maxDurationSeconds = Math.min(
            36000,
            Math.max(1, Math.floor(Number(body.maxDurationSeconds) || 3600)),
        );
        const fileName = String(body.fileName || "video");
        const allowedOrigins = streamAllowedOrigin(env.FRONTEND_URL);

        // Workers binding createDirectUpload does not support >200MB; always use TUS
        // for the editor Stream path (100MB–1GB). Requires account id + API token.
        const accountId = (env.CLOUDFLARE_ACCOUNT_ID || "").trim();
        const apiToken = (env.CLOUDFLARE_API_TOKEN || "").trim();
        if (!accountId || !apiToken) {
            return c.text(
                "Stream TUS upload requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN",
                503,
            );
        }

        let provisioned: StreamTusProvisionResult;
        try {
            provisioned = await provisionStreamTusUpload({
                accountId,
                apiToken,
                uploadLength: fileSize,
                metadata: buildStreamTusMetadata({
                    fileName,
                    maxDurationSeconds,
                    creator: String(uid),
                    requireSignedURLs: true,
                    allowedOrigins,
                }),
            });
        } catch (error) {
            console.error("Stream TUS provision failed:", error);
            return c.text(error instanceof Error ? error.message : "Stream TUS provision failed", 502);
        }

        const id = crypto.randomUUID();
        const playbackUrl = streamPlaybackUrl(env, provisioned.streamUid);
        let asset: typeof mediaAssets.$inferSelect | undefined;
        try {
            asset = await c.get("db").insert(mediaAssets).values({
                id,
                uid,
                provider: "stream",
                streamUid: provisioned.streamUid,
                playbackUrl,
                type: "video",
                objectKey: `stream/${uid}/${provisioned.streamUid}`,
                mimeType: "video/mp4",
                fileSize,
                status: "processing",
            }).returning().then((rows) => rows[0]);
        } catch (error) {
            await stream.video(provisioned.streamUid).delete().catch(() => undefined);
            throw error;
        }

        if (!asset) {
            await stream.video(provisioned.streamUid).delete().catch(() => undefined);
            return c.text("Failed to create Stream media asset", 500);
        }
        return c.json({
            asset: toContract(asset),
            uploadUrl: provisioned.uploadUrl,
            protocol: "tus" as const,
        });
    }, { message: "Permission denied", status: 403 }));

    app.get("/:id/playback", async (c) => {
        const asset = await c.get("db").query.mediaAssets.findFirst({
            where: eq(mediaAssets.id, c.req.param("id")),
        });
        if (!asset || asset.status === "failed" || (asset.status !== "ready" && asset.provider !== "stream")) return c.text("Not found", 404);
        if (!(await canReadAsset(c, asset))) return c.text("Permission denied", 403);

        if (asset.provider === "stream") {
            if (!asset.playbackUrl) return c.text("Stream playback is not configured", 503);
            const stream = c.get("env").STREAM;
            if (!asset.streamUid || !stream) return c.text("Cloudflare Stream is not configured", 503);
            try {
                const token = await stream.video(asset.streamUid).generateToken();
                return Response.redirect(streamPlaybackUrl(c.get("env"), token) || asset.playbackUrl, 302);
            } catch {
                return c.text("Stream playback token is unavailable", 503);
            }
        }

        const response = await profileAsync(c, "media_playback", () => getStorageObject(
            c.get("env"),
            asset.objectKey,
            c.req.header("range"),
        ));
        if (!response) return c.text("Not found", 404);

        response.headers.set("Content-Disposition", "inline");
        response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return response;
    });

    app.get("/:id", async (c) => {
        const asset = await c.get("db").query.mediaAssets.findFirst({
            where: eq(mediaAssets.id, c.req.param("id")),
        });
        if (!asset || !(await canReadAsset(c, asset))) return c.text("Not found", 404);
        return c.json(toContract(await refreshStreamAsset(c.get("db"), c.get("env"), asset)));
    });

    app.delete("/:id", adminOnly(async (c) => {
        const id = c.req.param("id");
        const db = c.get("db");
        const asset = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, id) });
        if (!asset) return c.text("Not found", 404);
        if (asset.feedId) return c.text("Media is still used by an article", 409);

        try {
            if (asset.provider === "stream") {
                const stream = c.get("env").STREAM;
                if (!stream || !asset.streamUid) return c.text("Cloudflare Stream is not configured", 503);
                await stream.video(asset.streamUid).delete();
            } else {
                await deleteStorageObject(c.get("env"), asset.objectKey);
            }
            await db.delete(mediaAssets).where(eq(mediaAssets.id, id));
            return c.body(null, 204);
        } catch (error) {
            console.error("Media deletion failed:", error);
            return c.text(error instanceof Error ? error.message : "Media deletion failed", 400);
        }
    }, { message: "Permission denied", status: 403 }));

    return app;
}

export { extractMediaIds, verifyStreamWebhookSignature };
