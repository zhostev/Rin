/**
 * 从 URL 下载图片：服务端直抓远端图片字节 → 调用方负责落 R2 并建资产行。
 *
 * 设计约束：
 * - 仅 http/https；拒绝带 userinfo、localhost/内网 IP/保留域名的 URL
 *   （SSRF 基础防护；注意 Worker 侧无法做 DNS 解析，DNS rebinding
 *   不能完全防住——该接口仅管理员可调，风险面收敛到站长本人）。
 * - 流式读取并设上限（默认 10MB，与 R2 图片直传上限一致），超限即
 *   cancel 中断，不把整包读进内存。
 * - mime 以文件魔数识别为准（部分 CDN 的 content-type 不可信）；
 *   魔数识别失败时才回退到 content-type 的 image/* 声明。
 */
import { R2_DIRECT_MAX_BYTES } from "./r2-direct";

export const FROM_URL_MAX_BYTES = R2_DIRECT_MAX_BYTES.image;

const MAX_URL_LENGTH = 2048;

/** parseRemoteImageUrl 的机器可读错误码（路由层直接透传为 400 code）。 */
export type RemoteUrlErrorCode = "invalid_url" | "url_not_allowed";

function isPrivateIPv4(host: string): boolean {
    const parts = host.split(".");
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) {
        return false;
    }
    const [a, b] = parts.map(Number) as [number, number, number, number];
    if (parts.some((p) => Number(p) > 255)) {
        return false;
    }
    return (
        a === 10 || // 10.0.0.0/8
        a === 127 || // 127.0.0.0/8 loopback
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
        (a === 192 && b === 168) || // 192.168.0.0/16
        (a === 169 && b === 254) || // 169.254.0.0/16 link-local（含云元数据服务）
        a === 0 || // 0.0.0.0/8
        a >= 224 // 224.0.0.0/4+ multicast/reserved
    );
}

function isPrivateIPv6(host: string): boolean {
    const h = host.toLowerCase();
    return (
        h === "::1" || // loopback
        h === "::" || // unspecified
        h.startsWith("fe80:") || // fe80::/10 link-local
        h.startsWith("fc") || // fc00::/7 unique local（fc/fd 开头）
        h.startsWith("ff") // ff00::/8 multicast
    );
}

function isBlockedHostname(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host.length === 0) {
        return true;
    }
    if (host === "localhost" || host.endsWith(".localhost")) {
        return true;
    }
    for (const suffix of [".local", ".internal", ".invalid", ".test", ".example", ".lan"]) {
        if (host.endsWith(suffix)) {
            return true;
        }
    }
    // WHATWG URL 的 hostname 会保留 IPv6 的方括号（[::1]），先剥掉
    const bare =
        host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (bare.includes(":")) {
        return isPrivateIPv6(bare);
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
        return isPrivateIPv4(bare);
    }
    return false;
}

/**
 * 校验用户提交的远端图片 URL。
 * 纯函数，可单测。返回 { url } 或 { error }。
 */
export function parseRemoteImageUrl(
    raw: unknown,
): { url: URL } | { error: RemoteUrlErrorCode } {
    if (typeof raw !== "string") {
        return { error: "invalid_url" };
    }
    const text = raw.trim();
    if (text.length === 0 || text.length > MAX_URL_LENGTH) {
        return { error: "invalid_url" };
    }
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return { error: "invalid_url" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { error: "invalid_url" };
    }
    // URL 里带账密的一律拒绝（防 http://user:pass@host 绕过与凭据外泄）
    if (url.username || url.password) {
        return { error: "url_not_allowed" };
    }
    if (isBlockedHostname(url.hostname)) {
        return { error: "url_not_allowed" };
    }
    return { url };
}

/** 按文件魔数识别图片 mime；识别不出返回 null（与 ai-images 共用）。 */
export function sniffImageMime(bytes: Uint8Array): string | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return "image/webp";
    }
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        return "image/gif";
    }
    // AVIF：RIFF....ftypavif / ftypavis
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x66 && bytes[9] === 0x74 && bytes[10] === 0x79 && bytes[11] === 0x70
    ) {
        return "image/avif";
    }
    return null;
}

/** mime → 文件扩展名（无点），未知时回退 jpg。 */
export function extensionFromMime(mime: string): string {
    switch (mime) {
        case "image/jpeg":
            return "jpg";
        case "image/png":
            return "png";
        case "image/webp":
            return "webp";
        case "image/gif":
            return "gif";
        case "image/avif":
            return "avif";
        case "image/bmp":
            return "bmp";
        default:
            return "jpg";
    }
}

export type RemoteImageDownloadErrorCode =
    | "download_failed"
    | "image_too_large"
    | "not_an_image"
    | "empty_image"
    | "instagram_resolve_failed";

export class RemoteImageDownloadError extends Error {
    readonly code: RemoteImageDownloadErrorCode;
    readonly upstreamStatus?: number;
    constructor(code: RemoteImageDownloadErrorCode, message: string, upstreamStatus?: number) {
        super(message);
        this.name = "RemoteImageDownloadError";
        this.code = code;
        this.upstreamStatus = upstreamStatus;
    }
}

const FETCH_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function mimeFromContentType(contentType: string | null): string | null {
    if (!contentType) {
        return null;
    }
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    return mime.startsWith("image/") ? mime : null;
}

/**
 * 下载远端图片字节（流式限流）。
 * fetchFn 可注入，便于单测 mock；默认用全局 fetch。
 */
export async function downloadImageBytes(
    url: string,
    maxBytes: number = FROM_URL_MAX_BYTES,
    fetchFn: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; mime: string }> {
    let response: Response;
    try {
        response = await fetchFn(url, {
            headers: { "User-Agent": FETCH_USER_AGENT },
            redirect: "follow",
        });
    } catch (error) {
        throw new RemoteImageDownloadError(
            "download_failed",
            `图片下载请求失败：${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!response.ok) {
        throw new RemoteImageDownloadError(
            "download_failed",
            `图片下载失败（HTTP ${response.status}）`,
            response.status,
        );
    }

    // content-length 预检：明显超限直接拒绝，连 body 都不读
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > maxBytes) {
            await response.body?.cancel().catch(() => {});
            throw new RemoteImageDownloadError(
                "image_too_large",
                `图片超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`,
            );
        }
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new RemoteImageDownloadError("empty_image", "下载到的图片是空的");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new RemoteImageDownloadError(
                    "image_too_large",
                    `图片超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`,
                );
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    if (total === 0) {
        throw new RemoteImageDownloadError("empty_image", "下载到的图片是空的");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    const mime =
        sniffImageMime(bytes) ?? mimeFromContentType(response.headers.get("content-type"));
    if (!mime) {
        throw new RemoteImageDownloadError("not_an_image", "URL 返回的不是图片");
    }
    return { bytes, mime };
}

/**
 * 从 URL path 里取一个像样的文件名；取不到/无扩展名时按 mime 生成。
 * 最终 key 仍由 buildDirectUploadKey 做清洗，这里只负责挑名字。
 */
export function filenameFromUrl(url: URL, mime: string): string {
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const stem = last.split("?")[0];
    if (stem && /\.[a-zA-Z0-9]{2,5}$/.test(stem)) {
        return stem;
    }
    const base = stem.replace(/\.[^.]*$/, "") || "image";
    return `${base}.${extensionFromMime(mime)}`;
}

// ---------------------------------------------------------------------------
// Instagram 帖子链接解析
// ---------------------------------------------------------------------------

/** Instagram 帖子/快拍视频页路径：/p/<code>、/reel/<code>、/reels/<code>、/tv/<code> */
const INSTAGRAM_POST_PATH = /^\/(p|reel|reels|tv)\/([\w-]+)\/?$/;

/** 是否为 Instagram 帖子页 URL（解析交给 Apify，见 resolveInstagramImageUrl）。 */
export function isInstagramPostUrl(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    if (host !== "instagram.com" && host !== "www.instagram.com") {
        return false;
    }
    return INSTAGRAM_POST_PATH.test(url.pathname);
}

/** 帖子短码；不是帖子页 URL 时返回 null。 */
export function instagramShortcode(url: URL): string | null {
    return INSTAGRAM_POST_PATH.exec(url.pathname)?.[2] ?? null;
}

/**
 * ?img_index=N 是 1-based 的媒体序号（图片和视频一起数，与浏览器里看到的一致）。
 * 缺省或非法时返回 null，表示取首图。
 */
export function instagramImageIndex(url: URL): number | null {
    const raw = url.searchParams.get("img_index");
    if (!raw || !/^\d+$/.test(raw)) {
        return null;
    }
    const index = Number.parseInt(raw, 10);
    return index > 0 ? index : null;
}

/** Instagram 图片 CDN 域名白名单（解析出的直链必须落在这上面）。 */
const INSTAGRAM_CDN_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];

export const APIFY_ACTOR_PRIMARY = "apify~instagram-scraper";
/** 主 actor 对部分帖子只会回 restricted_page，这时换 data-slayer 取全量媒体对象。 */
export const APIFY_ACTOR_FALLBACK = "data-slayer~instagram-post-details";
const APIFY_BASE = "https://api.apify.com/v2/acts";
const APIFY_TIMEOUT_MS = 60_000;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

export type InstagramMediaEntry = { kind: "image" | "video"; url: string };

/** apify~instagram-scraper：轮播在 childPosts[]，单帖的同名字段在顶层。 */
export function instagramMediaFromApify(item: unknown): InstagramMediaEntry[] {
    const record = asRecord(item);
    if (!record || record.error) {
        return [];
    }
    const children = Array.isArray(record.childPosts) ? record.childPosts : [];
    const entries = children.length > 0 ? children : [record];
    const media: InstagramMediaEntry[] = [];

    for (const entry of entries) {
        const child = asRecord(entry);
        if (!child) continue;
        const url = asString(child.displayUrl) || asString(child.display_url);
        if (!url) continue;
        media.push({
            kind: asString(child.type).toLowerCase() === "video" ? "video" : "image",
            url,
        });
    }

    return media;
}

/** data-slayer：carousel_media[]，图片在 image_versions.items 里按面积取最大的一档。 */
export function instagramMediaFromDataslayer(item: unknown): InstagramMediaEntry[] {
    const record = asRecord(item);
    if (!record) {
        return [];
    }
    const carousel = Array.isArray(record.carousel_media) ? record.carousel_media : [];
    const entries = carousel.length > 0 ? carousel : [record];
    const media: InstagramMediaEntry[] = [];

    for (const entry of entries) {
        const child = asRecord(entry);
        if (!child) continue;

        const videos = child.video_versions;
        if (Array.isArray(videos) && videos.length > 0) {
            const url = asString(asRecord(videos[0])?.url);
            if (url) media.push({ kind: "video", url });
            continue;
        }

        const items = asRecord(child.image_versions)?.items;
        let bestUrl = asString(child.display_url);
        let bestArea = -1;
        if (Array.isArray(items)) {
            for (const candidate of items) {
                const image = asRecord(candidate);
                if (!image) continue;
                const area = Number(image.width ?? 0) * Number(image.height ?? 0);
                if (area > bestArea) {
                    bestArea = area;
                    bestUrl = asString(image.url);
                }
            }
        }
        if (bestUrl) media.push({ kind: "image", url: bestUrl });
    }

    return media;
}

async function callApifyActor(
    actor: string,
    body: unknown,
    token: string,
    fetchFn: typeof fetch,
): Promise<unknown[]> {
    let response: Response;
    try {
        response = await fetchFn(`${APIFY_BASE}/${actor}/run-sync-get-dataset-items?timeout=60`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(APIFY_TIMEOUT_MS),
        });
    } catch (error) {
        throw new RemoteImageDownloadError(
            "instagram_resolve_failed",
            `Apify 调用失败：${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (!response.ok) {
        throw new RemoteImageDownloadError(
            "instagram_resolve_failed",
            `Apify 返回 HTTP ${response.status}`,
            response.status,
        );
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new RemoteImageDownloadError("instagram_resolve_failed", "Apify 返回的不是合法 JSON");
    }
    return Array.isArray(payload) ? payload : [];
}

/**
 * 把 Instagram 帖子页 URL 解析为图片直链。
 *
 * 帖子页 HTML 对机房 IP 会直接 429（抓不动），所以抓取这一步交给 Apify 的
 * actor，这里只把 actor 的响应归一化成 CDN 直链。带 ?img_index=N 时取第 N 个
 * 媒体（与浏览器里看到的一致），否则取首图。
 * 没配 APIFY_TOKEN、帖子不存在/私密/被限流时抛 instagram_resolve_failed。
 */
export async function resolveInstagramImageUrl(
    pageUrl: URL,
    fetchFn: typeof fetch = fetch,
    token: string = "",
): Promise<string> {
    const shortcode = instagramShortcode(pageUrl);
    if (!shortcode) {
        throw new RemoteImageDownloadError("instagram_resolve_failed", "不是 Instagram 帖子链接");
    }

    const apifyToken = token.trim();
    if (!apifyToken) {
        throw new RemoteImageDownloadError(
            "instagram_resolve_failed",
            "未配置 APIFY_TOKEN，无法解析 Instagram 帖子（wrangler secret put APIFY_TOKEN）",
        );
    }

    const permalink = `https://www.instagram.com/p/${shortcode}/`;
    const primary = await callApifyActor(
        APIFY_ACTOR_PRIMARY,
        { directUrls: [permalink], resultsType: "posts" },
        apifyToken,
        fetchFn,
    );
    let media = instagramMediaFromApify(primary[0]);

    if (media.length === 0) {
        // restricted_page（私密、区域限制、限流）在这里不是"帖子不存在"。
        const fallback = await callApifyActor(
            APIFY_ACTOR_FALLBACK,
            { urls: [permalink] },
            apifyToken,
            fetchFn,
        );
        media = instagramMediaFromDataslayer(fallback[0]);
    }

    if (media.length === 0) {
        throw new RemoteImageDownloadError(
            "instagram_resolve_failed",
            "没能解析出帖子内容：可能已删除、私密或受到区域限制",
        );
    }

    const requested = instagramImageIndex(pageUrl);
    let entry: InstagramMediaEntry | undefined;

    if (requested === null) {
        entry = media.find((item) => item.kind === "image");
        if (!entry) {
            throw new RemoteImageDownloadError("instagram_resolve_failed", "该帖子没有图片（只有视频）");
        }
    } else {
        entry = media[requested - 1];
        if (!entry) {
            throw new RemoteImageDownloadError(
                "instagram_resolve_failed",
                `img_index=${requested} 超出范围（该帖共 ${media.length} 个媒体）`,
            );
        }
        if (entry.kind !== "image") {
            throw new RemoteImageDownloadError(
                "instagram_resolve_failed",
                `img_index=${requested} 是视频，这个入口只下载图片`,
            );
        }
    }

    return assertInstagramCdnUrl(entry.url);
}

/** 解析结果必须落在 Instagram CDN 上，避免被 actor 响应里的任意地址带偏。 */
function assertInstagramCdnUrl(raw: string): string {
    let imageUrl: URL;
    try {
        imageUrl = new URL(raw);
    } catch {
        throw new RemoteImageDownloadError("instagram_resolve_failed", "解析出的图片地址无效");
    }
    const host = imageUrl.hostname.toLowerCase();
    const onCdn =
        imageUrl.protocol === "https:" &&
        INSTAGRAM_CDN_SUFFIXES.some((suffix) => host.endsWith(suffix));
    if (!onCdn) {
        throw new RemoteImageDownloadError("instagram_resolve_failed", "解析出的图片地址不在 Instagram CDN 上");
    }
    return imageUrl.toString();
}
