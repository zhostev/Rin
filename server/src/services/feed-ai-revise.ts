import { feedAIReviseSchema } from "@rin/api";
import type { AIReviseMode, CreateAIReviseRequest } from "@rin/api";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { adminOnly, withJsonBody } from "../core/route-boundaries";
import { feeds } from "../db/schema";
import { generateAIText, stripReasoningTags } from "../utils/ai";
import { getAIWriterConfig } from "../utils/db-config";

const REVISE_MODES: AIReviseMode[] = ["polish", "expand", "shorten", "proofread", "custom"];

/** Pure so mode validation can be tested without IO. */
export function normalizeReviseMode(value: unknown): AIReviseMode | null {
    return REVISE_MODES.includes(value as AIReviseMode) ? (value as AIReviseMode) : null;
}

const REVISE_MODE_TASKS: Record<Exclude<AIReviseMode, "custom">, string> = {
    polish: "润色文章：优化措辞、句式和行文节奏，使表达更流畅自然。不改变原意、观点和整体结构。",
    expand: "扩写文章：在保持原有风格和观点的前提下，丰富细节、补充例子和论述，使内容更充实。不要偏离主题，不要编造事实。",
    shorten: "精简文章：压缩篇幅，删除冗余表达，保留核心观点、关键信息和原文气质。",
    proofread: "校对文章：修正错别字、标点符号和语病。不改变原文的文风、观点和结构，只做最小必要修改。",
};

const REVISE_SYSTEM_PROMPT = [
    "你是一位中文写作编辑，负责按用户要求修改文章。",
    "规则：",
    "1. 只输出修改后的文章正文（Markdown），不要输出任何解释、前言、总结或修改说明。",
    "2. 保留原文的 Markdown 结构：标题层级、列表、引用、代码块保持原样。",
    "3. 图片语法 ![](...) 和超链接必须原样保留，一个字符都不能改动。",
    "4. 不要添加原文没有的事实信息。",
].join("\n");

/** Pure so prompt assembly can be tested without IO. */
export function buildReviseUserMessage(input: {
    mode: AIReviseMode;
    instruction?: string;
    content: string;
}): string {
    const task =
        input.mode === "custom"
            ? input.instruction?.trim() || "请优化这篇文章。"
            : REVISE_MODE_TASKS[input.mode];
    const extra =
        input.mode !== "custom" && input.instruction?.trim()
            ? `\n\n额外要求：${input.instruction.trim()}`
            : "";
    return `任务：${task}${extra}\n\n以下是需要修改的文章正文：\n\n${input.content}`;
}

/**
 * Rough output token ceiling for a revise call: the revised text is usually
 * close to the input length (expand mode may grow it), so scale from the
 * input size instead of using a fixed small default.
 */
export function estimateReviseMaxTokens(content: string): number {
    return Math.ceil(content.length / 2) * 2 + 500;
}

export function registerFeedAIReviseRoutes(app: Hono<{ Bindings: Env; Variables: Variables }>) {
    // Must be registered before app.post('/:id', ...): see the ai-compose note in feed.ts.
    app.post(
        "/:id/ai-revise",
        adminOnly(
            withJsonBody<CreateAIReviseRequest>(feedAIReviseSchema, async (c, body) => {
                const db = c.get("db");
                const env = c.get("env");
                const serverConfig = c.get("serverConfig");

                const id = Number.parseInt(c.req.param("id"), 10);
                if (!Number.isFinite(id)) {
                    return c.text("Invalid id", 400);
                }

                const mode = normalizeReviseMode(body.mode);
                if (!mode) {
                    return c.text(`Unknown revise mode: ${body.mode}`, 400);
                }
                if (mode === "custom" && !body.instruction?.trim()) {
                    return c.text("Instruction is required for custom mode", 400);
                }

                const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
                if (!feed) {
                    return c.text("Not found", 404);
                }
                if (!feed.content?.trim()) {
                    return c.text("Article content is empty", 400);
                }

                const writerConfig = await getAIWriterConfig(serverConfig);
                if (!writerConfig.enabled) {
                    return c.text("AI writer is not enabled", 400);
                }

                let raw: string | null = null;
                try {
                    raw = await generateAIText(
                        env,
                        writerConfig,
                        [
                            {
                                role: "system",
                                content: writerConfig.system_prompt.trim() || REVISE_SYSTEM_PROMPT,
                            },
                            {
                                role: "user",
                                content: buildReviseUserMessage({
                                    mode,
                                    instruction: body.instruction,
                                    content: feed.content,
                                }),
                            },
                        ],
                        {
                            maxTokens: Math.max(
                                writerConfig.max_tokens,
                                estimateReviseMaxTokens(feed.content),
                            ),
                            temperature: writerConfig.temperature,
                        },
                    );
                } catch (error) {
                    console.error("[AI Revise] Generation failed:", error);
                    return c.text(error instanceof Error ? error.message : String(error), 500);
                }

                const revised = stripReasoningTags(raw ?? "").trim();
                if (!revised) {
                    return c.text("AI returned empty result", 500);
                }

                return c.json({ revised });
            }),
            { message: "Permission denied", status: 403 },
        ),
    );
}
