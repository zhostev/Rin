import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import { feeds } from "../db/schema";

/** 微信草稿标题硬限制 64 字节（UTF-8）。纯函数，可单测。 */
export function wechatTitleByteLength(title: string): number {
    return new TextEncoder().encode(title).length;
}

/**
 * 去掉字符串中的全部空白与不可见格式字符：零宽空格 U+200B、零宽非断空格
 * U+FEFF（属 \s，能被 trim 去掉，列出仅为明确）、零宽连字 U+200C/U+200D、
 * 词连接符 U+2060、软连字符 U+00AD。这些字符 trim() 去不掉，iOS 从网页/
 * 富文本复制粘贴时常带入，会让 new URL / fetch 报 "Invalid URL"。
 * URL 与 Bearer token 里永远不会合法出现这类字符。纯函数，可单测。
 */
export function stripInvisibleChars(value: string): string {
    return value.replace(/[\s\u200B-\u200D\u2060\u00AD]/g, "");
}

/**
 * 规范化 WECHAT_RELAY_URL：先清掉全部不可见字符（见 stripInvisibleChars），
 * 再去掉末尾斜杠。空字符串视为未配置。纯函数，可单测。
 */
export function normalizeRelayUrl(url: string | undefined): string | undefined {
    const normalized = url ? stripInvisibleChars(url).replace(/\/+$/, "") : "";
    return normalized || undefined;
}

/**
 * 解析中转配置：Feed 与故事公众号推送共用。返回 ok:false 时 error 即为
 * 应直接返回给管理员的服务端原话。
 */
export function resolveWechatRelayConfig(env: Env):
    | { ok: true; relayUrl: string; relaySecret: string }
    | { ok: false; error: string } {
    const relayUrl = normalizeRelayUrl(env.WECHAT_RELAY_URL);
    const relaySecret = env.WECHAT_RELAY_SECRET
        ? stripInvisibleChars(env.WECHAT_RELAY_SECRET) || undefined
        : undefined;
    if (!relayUrl || !relaySecret) {
        return { ok: false, error: "微信中转服务未配置（WECHAT_RELAY_URL / WECHAT_RELAY_SECRET）" };
    }
    try {
        new URL(relayUrl);
    } catch {
        return { ok: false, error: "WECHAT_RELAY_URL 不是合法的 URL" };
    }
    return { ok: true, relayUrl, relaySecret };
}

export type WechatRelayPushInput = {
    relayUrl: string;
    relaySecret: string;
    title: string;
    digest: string;
    contentMarkdown: string;
    siteBaseUrl: string;
    articleUrl: string;
};

export type WechatRelayPushResult =
    | { ok: true; draft_media_id?: string }
    | { ok: false; message: string };

/**
 * 向 ECS 中转发一次公众号草稿。fetchImpl 可注入（测试用 mock，不真实调用
 * 中转服务）；默认用全局 fetch。传图+建草稿是同步长任务，给足 120s。
 * 返回的 message 已是可直接返回给管理员的原话。
 */
export async function pushWechatDraftRelay(
    input: WechatRelayPushInput,
    fetchImpl: typeof fetch = fetch,
): Promise<WechatRelayPushResult> {
    let resp: Response;
    try {
        resp = await fetchImpl(`${input.relayUrl}/push-draft`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${input.relaySecret}`,
            },
            body: JSON.stringify({
                title: input.title,
                digest: input.digest,
                content_markdown: input.contentMarkdown,
                site_base_url: input.siteBaseUrl,
                article_url: input.articleUrl,
            }),
            signal: AbortSignal.timeout(120000),
        });
    } catch (error) {
        return {
            ok: false,
            message: `中转服务连接失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    let data: { ok?: boolean; error?: string; draft_media_id?: string } | null = null;
    try {
        data = (await resp.json()) as {
            ok?: boolean;
            error?: string;
            draft_media_id?: string;
        };
    } catch {
        // ignore: fall through to the error branch below
    }
    if (!resp.ok || !data?.ok) {
        return { ok: false, message: `推送失败：${data?.error || `HTTP ${resp.status}`}` };
    }
    return { ok: true, draft_media_id: data.draft_media_id };
}

export function registerFeedWechatDraftRoutes(app: Hono<{ Bindings: Env; Variables: Variables }>) {
    // Must be registered before app.post('/:id', ...) below: see the ai-compose note in feed.ts.
    app.post(
        "/:id/wechat-draft",
        adminOnly(async (c) => {
            const db = c.get("db");
            const env = c.get("env");

            const id = Number.parseInt(c.req.param("id"), 10);
            if (!Number.isFinite(id)) {
                return c.text("Invalid id", 400);
            }

            const relay = resolveWechatRelayConfig(env);
            if (!relay.ok) {
                return c.text(relay.error, 400);
            }

            const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
            if (!feed) {
                return c.text("Not found", 404);
            }
            const title = (feed.title || "").trim();
            if (!title) {
                return c.text("文章标题为空", 400);
            }
            if (wechatTitleByteLength(title) > 64) {
                return c.text(
                    `标题超过微信 64 字节限制（当前 ${wechatTitleByteLength(title)} 字节）`,
                    400,
                );
            }
            if (!feed.content?.trim()) {
                return c.text("Article content is empty", 400);
            }

            const origin =
                env.FRONTEND_URL?.replace(/\/+$/, "") || new URL(c.req.url).origin;

            const pushed = await pushWechatDraftRelay({
                relayUrl: relay.relayUrl,
                relaySecret: relay.relaySecret,
                title,
                digest: (feed.summary || "").trim(),
                contentMarkdown: feed.content,
                siteBaseUrl: origin,
                articleUrl: `${origin}/feed/${id}`,
            });
            if (!pushed.ok) {
                return c.text(pushed.message, 502);
            }
            return c.json({ draft_media_id: pushed.draft_media_id });
        }),
    );
}
