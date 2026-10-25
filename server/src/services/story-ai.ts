import {
    storyAIComposeSchema,
    storyAIReviseSchema,
} from "@rin/api";
import type {
    ComposeLength,
    StoryAIComposeRequest,
    StoryAIReviseRequest,
} from "@rin/api";
import type { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { adminOnly, withJsonBody } from "../core/route-boundaries";
import { findStoryById } from "../features/story/repository";
import { generateAIText, stripReasoningTags } from "../utils/ai";
import { COMPOSE_LENGTH_RANGES, composeMaxTokensFloor } from "../utils/ai-compose";
import { getAIWriterConfig } from "../utils/db-config";
import {
    REVISE_SYSTEM_PROMPT,
    buildReviseUserMessage,
    describeEmptyReviseResult,
    normalizeReviseMode,
    resolveReviseMaxTokens,
} from "./feed-ai-revise";

const COMPOSE_LENGTHS: ComposeLength[] = ["short", "medium", "long"];

export function normalizeStoryComposeLength(value: unknown): ComposeLength {
    return COMPOSE_LENGTHS.includes(value as ComposeLength) ? (value as ComposeLength) : "medium";
}

/**
 * 故事 AI 写作的系统提示：与 Feed AI 同一套写作口径（中文博客作者），但输出
 * 是一段正文而不是整篇文章——不要 front-matter、不要解释、不要标题重复。
 * 素材只来自请求里的 sourceText；没有素材时只按选题写，不要编造媒体链接
 * 与未给出的事实。纯函数，可单测。
 */
export const STORY_AI_COMPOSE_SYSTEM_PROMPT = [
    "你是一位中文博客作者，负责为一个故事内容包写一段正文。",
    "规则：",
    "1. 只输出正文 Markdown，不要输出 front-matter、解释、前言或总结。",
    "2. 不要重复故事标题；不要加一级标题。",
    "3. 素材中给出的图片链接、引用必须原样保留，一个字符都不能改动；不要新增任何图片、视频、音频引用，也不要编造媒体链接。",
    "4. 不要添加素材和选题之外的事实信息；素材不足时宁可少写，不要编造。",
].join("\n");

/** Pure so prompt assembly can be tested without IO. */
export function buildStoryComposeUserMessage(input: {
    topic: string;
    style?: string;
    length: ComposeLength;
    sourceText?: string;
}): string {
    const range = COMPOSE_LENGTH_RANGES[input.length];
    const sections: string[] = [
        `选题：${input.topic}`,
        `篇幅：正文约 ${range.min} 到 ${range.max} 个中文字符。`,
    ];
    if (input.style?.trim()) {
        sections.push(`风格：${input.style.trim()}`);
    }
    if (input.sourceText?.trim()) {
        sections.push(`已有素材（正文与图片说明，仅可据此展开，不要编造素材之外的事实）：\n\n${input.sourceText.trim()}`);
    }
    return sections.join("\n\n");
}

function parseStoryId(value: string): number | null {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
}

export function registerStoryAIRoutes(app: Hono<{ Bindings: Env; Variables: Variables }>) {
    // POST /admin/stories/:id/ai-compose — 同步生成一段正文，只返回给编辑器。
    // 绝不写库、不改故事状态：编辑器把结果插成新的 rich_text 块，用户检查
    // 修改后点保存才落盘；不保存则结果随编辑器关闭而丢弃。
    app.post(
        "/:id/ai-compose",
        adminOnly(
            withJsonBody<StoryAIComposeRequest>(storyAIComposeSchema, async (c, body) => {
                const db = c.get("db");
                const env = c.get("env");
                const serverConfig = c.get("serverConfig");

                const id = parseStoryId(c.req.param("id"));
                if (id === null) {
                    return c.text("Not found", 404);
                }
                const story = await findStoryById(db, id);
                if (!story) {
                    return c.text("Not found", 404);
                }

                const topic = (body.topic ?? "").trim();
                const sourceText = (body.sourceText ?? "").trim();
                if (!topic && !sourceText) {
                    return c.text("请填写选题，或勾选已有正文作素材", 400);
                }

                const writerConfig = await getAIWriterConfig(serverConfig);
                if (!writerConfig.enabled) {
                    return c.text("AI writer is not enabled", 400);
                }

                const length = normalizeStoryComposeLength(body.length);
                const messages: { role: "system" | "user"; content: string }[] = [
                    {
                        role: "system",
                        content: writerConfig.system_prompt.trim() || STORY_AI_COMPOSE_SYSTEM_PROMPT,
                    },
                    {
                        role: "user",
                        content: buildStoryComposeUserMessage({
                            topic: topic || story.title || "请根据已有素材写一段正文",
                            style: body.style,
                            length,
                            sourceText: sourceText || undefined,
                        }),
                    },
                ];

                let result;
                try {
                    result = await generateAIText(env, writerConfig, messages, {
                        maxTokens: Math.max(writerConfig.max_tokens, composeMaxTokensFloor(length)),
                        temperature: writerConfig.temperature,
                    });
                } catch (error) {
                    return c.text(error instanceof Error ? error.message : String(error), 500);
                }
                const markdown = stripReasoningTags(result.text ?? "").trim();
                if (!markdown) {
                    return c.text(
                        result ? describeEmptyReviseResult(result) : "AI returned empty result",
                        500,
                    );
                }
                return c.json({ markdown });
            }),
            { message: "Permission denied", status: 403 },
        ),
    );

    // POST /admin/stories/:id/ai-revise — 改写编辑器里选中的单个 rich_text 块。
    // content 来自请求体（编辑器当前未保存的内容），同样只返回、不写库。
    app.post(
        "/:id/ai-revise",
        adminOnly(
            withJsonBody<StoryAIReviseRequest>(storyAIReviseSchema, async (c, body) => {
                const db = c.get("db");
                const env = c.get("env");
                const serverConfig = c.get("serverConfig");

                const id = parseStoryId(c.req.param("id"));
                if (id === null) {
                    return c.text("Not found", 404);
                }
                const story = await findStoryById(db, id);
                if (!story) {
                    return c.text("Not found", 404);
                }

                const mode = normalizeReviseMode(body.mode);
                if (!mode) {
                    return c.text(`Unknown revise mode: ${body.mode}`, 400);
                }
                if (mode === "custom" && !body.instruction?.trim()) {
                    return c.text("Instruction is required for custom mode", 400);
                }
                if (!body.content?.trim()) {
                    return c.text("Block content is empty", 400);
                }

                const writerConfig = await getAIWriterConfig(serverConfig);
                if (!writerConfig.enabled) {
                    return c.text("AI writer is not enabled", 400);
                }

                const maxTokens = resolveReviseMaxTokens(body.content, writerConfig.max_tokens);
                const messages: { role: "system" | "user"; content: string }[] = [
                    {
                        role: "system",
                        content: writerConfig.system_prompt.trim() || REVISE_SYSTEM_PROMPT,
                    },
                    {
                        role: "user",
                        content: buildReviseUserMessage({
                            mode,
                            instruction: body.instruction,
                            content: body.content,
                        }),
                    },
                ];

                let result = null;
                let revised = "";
                for (let attempt = 0; attempt < 2 && !revised; attempt++) {
                    try {
                        result = await generateAIText(env, writerConfig, messages, {
                            maxTokens,
                            temperature: writerConfig.temperature,
                        });
                    } catch (error) {
                        return c.text(error instanceof Error ? error.message : String(error), 500);
                    }
                    revised = stripReasoningTags(result.text ?? "").trim();
                }
                if (!revised) {
                    return c.text(
                        result ? describeEmptyReviseResult(result) : "AI returned empty result",
                        500,
                    );
                }
                return c.json({ revised });
            }),
            { message: "Permission denied", status: 403 },
        ),
    );
}
