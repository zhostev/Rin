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

            const relayUrl = normalizeRelayUrl(env.WECHAT_RELAY_URL);
            const relaySecret = env.WECHAT_RELAY_SECRET
                ? stripInvisibleChars(env.WECHAT_RELAY_SECRET) || undefined
                : undefined;
            if (!relayUrl || !relaySecret) {
                return c.text("微信中转服务未配置（WECHAT_RELAY_URL / WECHAT_RELAY_SECRET）", 400);
            }
            try {
                new URL(relayUrl);
            } catch {
                return c.text("WECHAT_RELAY_URL 不是合法的 URL", 400);
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

            let resp: Response;
            try {
                resp = await fetch(`${relayUrl}/push-draft`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${relaySecret}`,
                    },
                    body: JSON.stringify({
                        title,
                        digest: (feed.summary || "").trim(),
                        content_markdown: feed.content,
                        site_base_url: origin,
                        article_url: `${origin}/feed/${id}`,
                    }),
                    // 传图+建草稿是同步长任务，给足 120s
                    signal: AbortSignal.timeout(120000),
                });
            } catch (error) {
                return c.text(
                    `中转服务连接失败：${error instanceof Error ? error.message : String(error)}`,
                    502,
                );
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
                return c.text(`推送失败：${data?.error || `HTTP ${resp.status}`}`, 502);
            }
            return c.json({ draft_media_id: data.draft_media_id });
        }),
    );
}
