import { ANALYTICS_SALT_SEED_KEY } from "@rin/config";
import type { AppContext } from "../core/hono-types";
import { getClientIp } from "./geo";

export type DeviceType = "mobile" | "desktop";

// 单一来源在 @rin/config：该键同时出现在 SENSITIVE_SERVER_CONFIG_FIELDS 里。
export { ANALYTICS_SALT_SEED_KEY };

/** blob 总量上限 16 KB；标题是唯一可能超长的字段，单独截断。 */
const MAX_TITLE_BYTES = 256;

const BOT_PATTERNS = [
    "bot", "crawler", "spider", "slurp", "curl", "wget", "python-requests",
    "headlesschrome", "phantomjs", "monitor", "preview", "fetcher",
];

const MOBILE_PATTERNS = ["mobile", "android", "iphone", "ipod", "ipad", "windows phone"];

export interface PageViewDataPoint {
    indexes: [string];
    blobs: string[];
    doubles: [number];
}

/** 空 UA 视为 bot：真实浏览器一定会带 UA。 */
export function isBotUserAgent(userAgent: string): boolean {
    const ua = userAgent.trim().toLowerCase();
    if (!ua) {
        return true;
    }
    return BOT_PATTERNS.some((pattern) => ua.includes(pattern));
}

export function detectDevice(userAgent: string): DeviceType {
    const ua = userAgent.toLowerCase();
    return MOBILE_PATTERNS.some((pattern) => ua.includes(pattern)) ? "mobile" : "desktop";
}

/** 只保留来源 host；同源、缺失、非法一律记为 direct，不存完整 URL。 */
export function normalizeReferrer(referrer: string | null | undefined, selfHost: string): string {
    if (!referrer) {
        return "direct";
    }

    try {
        const host = new URL(referrer).host;
        if (!host || host === selfHost) {
            return "direct";
        }
        return host;
    } catch {
        return "direct";
    }
}

export function utcDateString(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/**
 * Truncate to a UTF-8 byte budget in a single pass.
 *
 * Iterating with `for...of` walks code points, so a surrogate pair is seen as
 * one unit and can never be cut in half; the byte width is derived from the
 * code point rather than re-encoding the candidate string on every step.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return "";
    }

    let bytes = 0;
    let end = 0;

    for (const char of value) {
        const codePoint = char.codePointAt(0) ?? 0;
        const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

        if (bytes + size > maxBytes) {
            return value.slice(0, end);
        }

        bytes += size;
        end += char.length;
    }

    return value;
}

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

export async function visitorFingerprint(input: {
    ip: string;
    userAgent: string;
    feedId: number;
    salt: string;
}): Promise<string> {
    const hash = await sha256Hex(`${input.ip}|${input.userAgent}|${input.feedId}|${input.salt}`);
    return hash.slice(0, 16);
}

type SaltConfig = {
    getOrDefault<T>(key: string, defaultValue: T): Promise<T>;
    set(key: string, value: unknown, save?: boolean): Promise<void>;
};

/**
 * 每日轮换的盐：一次性随机种子持久化在 serverConfig，按 UTC 日期派生当日盐。
 * 跨天无法关联同一访客，也无法从存储值反推 IP。
 */
export async function resolveDailySalt(serverConfig: SaltConfig, date: string): Promise<string> {
    let seed = await serverConfig.getOrDefault<string>(ANALYTICS_SALT_SEED_KEY, "");

    if (!seed) {
        seed = crypto.randomUUID();
        await serverConfig.set(ANALYTICS_SALT_SEED_KEY, seed, true);
    }

    return sha256Hex(`${seed}|${date}`);
}

export function buildPageViewDataPoint(input: {
    feedId: number;
    title: string | null;
    path: string;
    referrerHost: string;
    country: string;
    city: string;
    device: DeviceType;
    fingerprint: string;
    ip: string;
}): PageViewDataPoint {
    return {
        indexes: [String(input.feedId)],
        blobs: [
            input.path,
            input.referrerHost,
            input.country,
            input.city,
            input.device,
            input.fingerprint,
            truncateToBytes(input.title ?? "", MAX_TITLE_BYTES),
            input.ip,
        ],
        doubles: [1],
    };
}

/**
 * 非阻塞记录一次文章浏览。任何缺失的前置条件（binding 未配置、bot、开关关闭）
 * 都静默跳过，绝不影响页面响应。
 */
export async function recordPageView(
    c: AppContext,
    options: { feedId: number; title: string | null },
): Promise<void> {
    const dataset = c.env.ANALYTICS;
    if (!dataset) {
        return;
    }

    const userAgent = c.req.header("user-agent") ?? "";
    if (isBotUserAgent(userAgent)) {
        return;
    }

    try {
        const serverConfig = c.get("serverConfig");
        const date = utcDateString(new Date());
        const salt = await resolveDailySalt(serverConfig, date);
        const ip = getClientIp(c.req.raw.headers);
        const cf = (c.req.raw as unknown as { cf?: Record<string, unknown> }).cf ?? {};

        const point = buildPageViewDataPoint({
            feedId: options.feedId,
            title: options.title,
            path: new URL(c.req.url).pathname,
            referrerHost: normalizeReferrer(c.req.header("referer"), new URL(c.req.url).host),
            country: typeof cf.country === "string" ? cf.country : "",
            city: typeof cf.city === "string" ? cf.city : "",
            device: detectDevice(userAgent),
            fingerprint: await visitorFingerprint({ ip, userAgent, feedId: options.feedId, salt }),
            ip,
        });

        dataset.writeDataPoint(point);
    } catch (error) {
        console.warn("analytics: failed to record page view", error);
    }
}
