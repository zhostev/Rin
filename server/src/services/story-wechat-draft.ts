import type { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import { findStoryById } from "../features/story/repository";
import {
    pushWechatDraftRelay,
    resolveWechatRelayConfig,
    wechatTitleByteLength,
} from "./feed-wechat-draft";

type StoryBlockLike = {
    type?: string;
    payloadJson?: string | null;
    payload?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
    return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function parsePayload(block: StoryBlockLike): Record<string, unknown> {
    if (block.payload && typeof block.payload === "object") {
        return asRecord(block.payload);
    }
    if (typeof block.payloadJson === "string") {
        try {
            const parsed = JSON.parse(block.payloadJson);
            return asRecord(parsed);
        } catch {
            return {};
        }
    }
    return {};
}

function imageMarkdown(payload: Record<string, unknown>): string {
    const url = asString(payload.url);
    // 图集项本身就是资产（{id, url, alt}）；图片块则是 asset_id / asset.id。
    const assetId =
        payload.asset_id ??
        asRecord(payload.asset).id ??
        (typeof payload.id === "number" ? payload.id : undefined);
    const src = url || (typeof assetId === "number" ? `/api/media/${assetId}/playback` : "");
    if (!src) return "";
    const alt = asString(payload.alt) || asString(payload.caption) || "";
    return `![${alt}](${src})`;
}

/**
 * 把故事内容块拼成一篇公众号可接受的 Markdown：与 Feed 推送同一格式
 * （content_markdown），正文 rich_text 原样保留，图片/图集块转成图片语法，
 * 其它文本块取其文本字段。纯函数，可单测。
 */
export function extractStoryMarkdown(blocks: StoryBlockLike[]): string {
    const parts: string[] = [];
    for (const block of blocks ?? []) {
        const payload = parsePayload(block);
        switch (block.type) {
            case "rich_text": {
                const markdown = asString(payload.markdown).trim();
                if (markdown) parts.push(markdown);
                break;
            }
            case "image": {
                const md = imageMarkdown(payload);
                if (md) parts.push(md);
                break;
            }
            case "gallery": {
                const items = Array.isArray(payload.items) ? payload.items : [];
                for (const item of items) {
                    const md = imageMarkdown(asRecord(item));
                    if (md) parts.push(md);
                }
                break;
            }
            case "quote":
            case "callout":
            case "code": {
                const text = (
                    asString(payload.text) ||
                    asString(payload.code) ||
                    asString(payload.title)
                ).trim();
                if (text) parts.push(text);
                break;
            }
            default:
                break;
        }
    }
    return parts.join("\n\n").trim();
}

export function registerStoryWechatDraftRoutes(app: Hono<{ Bindings: Env; Variables: Variables }>) {
    // POST /admin/stories/:id/wechat-draft — 与 Feed 推送同一中转、同一标题
    // 字节校验、同一错误原话；内容取故事 rich_text 正文（+图片/图集转图片语法）。
    app.post(
        "/:id/wechat-draft",
        adminOnly(async (c) => {
            const db = c.get("db");
            const env = c.get("env");

            const id = Number.parseInt(c.req.param("id"), 10);
            if (!Number.isFinite(id) || id < 1) {
                return c.text("Not found", 404);
            }

            const relay = resolveWechatRelayConfig(env);
            if (!relay.ok) {
                return c.text(relay.error, 400);
            }

            const story = await findStoryById(db, id);
            if (!story) {
                return c.text("Not found", 404);
            }
            const title = (story.title || "").trim();
            if (!title) {
                return c.text("文章标题为空", 400);
            }
            if (wechatTitleByteLength(title) > 64) {
                return c.text(
                    `标题超过微信 64 字节限制（当前 ${wechatTitleByteLength(title)} 字节）`,
                    400,
                );
            }
            const contentMarkdown = extractStoryMarkdown(
                (story.blocks ?? []) as StoryBlockLike[],
            );
            if (!contentMarkdown) {
                return c.text("Article content is empty", 400);
            }

            const origin =
                env.FRONTEND_URL?.replace(/\/+$/, "") || new URL(c.req.url).origin;

            const pushed = await pushWechatDraftRelay({
                relayUrl: relay.relayUrl,
                relaySecret: relay.relaySecret,
                title,
                digest: (story.summary || "").trim(),
                contentMarkdown,
                siteBaseUrl: origin,
                articleUrl: `${origin}/story/${story.slug}`,
            });
            if (!pushed.ok) {
                return c.text(pushed.message, 502);
            }
            return c.json({ draft_media_id: pushed.draft_media_id });
        }),
    );
}
