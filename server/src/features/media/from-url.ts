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
    | "empty_image";

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
