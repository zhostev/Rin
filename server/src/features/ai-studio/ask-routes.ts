/**
 * Stage 4 · 站内问答公开路由（挂载到 /api/ask，无需登录，简单限流）。
 *
 * POST / {question, mode?: 'quick'|'full'} -> 200 {answer, citations, coverage, verifiedAt?}
 * GET  /recommend?storyId=123 | ?slug=some-slug -> 200 {items:[{storySlug,title,reason}]}
 *   （storyId 与 slug 任传其一；slug 优先解析）
 *
 * 同样受 AI 总开关/配额守卫保护（ai_enabled=0 → 503，超配额 → 429）。
 */
import { t } from "@rin/api";
import { Hono } from "hono";
import type { AppContext, Variables } from "../../core/hono-types";
import { withJsonBody } from "../../core/route-boundaries";
import { getClientIp } from "../../utils/client-ip";
import {
    answerQuestion,
    checkAskRateLimit,
    normalizeAskMode,
    recommendForStory,
} from "./ask";
import { checkAIGuard, type AIGuardFailure } from "./guard";
import { findStoryIdBySlug } from "./jobs";

type HonoApp = Hono<{ Bindings: Env; Variables: Variables }>;

/** 限流桶（worker isolate 内共享；多 isolate 下为近似限流，符合"简单限流"要求） */
const rateBuckets = new Map<string, number[]>();

function guardError(c: AppContext, failure: AIGuardFailure) {
    return c.json(
        { error: { code: failure.code, message: failure.message } },
        failure.status,
    );
}

async function withAIGuard(
    c: AppContext,
    handler: (c: AppContext) => Promise<Response>,
): Promise<Response> {
    const guard = await checkAIGuard(c.get("db"));
    if (!guard.ok) return guardError(c, guard);
    return handler(c);
}

const askSchema = t.Object({
    question: t.String({ minLength: 1 }),
    mode: t.Optional(t.String()),
});

type AskBody = { question: string; mode?: string };

export function AskService(): HonoApp {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();

    // POST /api/ask
    app.post(
        "/",
        withJsonBody<AskBody>(askSchema, async (c, body) => {
            return withAIGuard(c, async () => {
                const ip = getClientIp(c.req.raw.headers) || "unknown";
                if (!checkAskRateLimit(rateBuckets, `ask:${ip}`, Date.now())) {
                    return c.json(
                        { error: { code: "rate_limited", message: "提问太频繁，请稍后再试" } },
                        429,
                    );
                }

                const mode = normalizeAskMode(body.mode);
                const result = await answerQuestion(c.get("env"), c.get("db"), body.question, mode);
                return c.json(result);
            });
        }),
    );

    // GET /api/ask/recommend?storyId=123 或 ?slug=some-slug（任一即可，slug 优先）
    app.get("/recommend", async (c) => {
        return withAIGuard(c, async () => {
            const db = c.get("db");
            const slug = (c.req.query("slug") ?? "").trim();
            let storyId = Number.parseInt(c.req.query("storyId") ?? "", 10);
            if (slug) {
                const found = await findStoryIdBySlug(db, slug);
                if (found === null) {
                    return c.json(
                        { error: { code: "not_found", message: "找不到该 story" } },
                        404,
                    );
                }
                storyId = found;
            }
            if (!Number.isInteger(storyId)) {
                return c.json(
                    { error: { code: "invalid_story_ref", message: "需要 storyId 或 slug 参数" } },
                    400,
                );
            }
            const result = await recommendForStory(c.get("env"), db, storyId);
            if ("error" in result) {
                return c.json({ error: { code: "not_found", message: "找不到该 story" } }, 404);
            }
            return c.json(result);
        });
    });

    return app;
}
