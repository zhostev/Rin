import { generateAIText, stripReasoningTags } from "./ai";
import { getAIConfig } from "./db-config";

type ConfigReader = {
    get(key: string): Promise<unknown>;
};

export const TRANSLATION_SYSTEM_PROMPT =
    "You are a professional Chinese-to-English translator for a personal blog. " +
    "Translate the user's Markdown into natural, fluent English. " +
    "Preserve the Markdown structure exactly: headings, lists, quotes, tables, emphasis, " +
    "and line breaks stay in the same places. Keep code blocks, inline code, URLs, image " +
    "syntax, link targets, and HTML tags unchanged (translate only the visible text). " +
    "Do not add, remove, summarize, or explain anything. Output only the translated Markdown.";

/** 单块正文的字符上限：块按段落（空行）聚合，不拆围栏代码块内部。 */
export const TRANSLATION_CHUNK_CHARS = 3000;

/**
 * 与 AI 修改（feed-ai-revise）同一教训：推理模型把思考也计入 max_tokens，
 * 预算不留余量会把答案挤成空响应（finish_reason=length）。只按生成量计费，余量不花钱。
 */
export const TRANSLATION_THINKING_TOKEN_HEADROOM = 8000;

/** Pure: rough output-token estimate for a chunk (CJK ≈ 1 token/char, English words less). */
export function resolveTranslationMaxTokens(chunk: string): number {
    return Math.max(1024, chunk.length + TRANSLATION_THINKING_TOKEN_HEADROOM);
}

/**
 * Pure: split Markdown into translation chunks on paragraph boundaries.
 * A fenced code block is never split: lines inside ``` fences stay with the
 * block, however long it gets, so a chunk boundary can't corrupt code.
 */
export function chunkMarkdownForTranslation(content: string, maxChars = TRANSLATION_CHUNK_CHARS): string[] {
    const blocks: string[] = [];
    let current: string[] = [];
    let inFence = false;
    const flush = () => {
        if (current.length > 0) {
            blocks.push(current.join("\n"));
            current = [];
        }
    };
    for (const line of content.split("\n")) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            current.push(line);
            continue;
        }
        if (!inFence && line.trim() === "") {
            flush();
            continue;
        }
        current.push(line);
    }
    flush();

    const chunks: string[] = [];
    let chunk = "";
    for (const block of blocks) {
        if (chunk && chunk.length + 2 + block.length > maxChars) {
            chunks.push(chunk);
            chunk = "";
        }
        chunk = chunk ? `${chunk}\n\n${block}` : block;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
}

/**
 * Pure: the title/summary call returns two marker lines so one request covers
 * both short fields. Falls back to "whole text is the title" when the model
 * ignores the markers.
 */
export function buildHeadingTranslationPrompt(title: string, summary: string): string {
    return [
        "Translate the following blog title and summary into English.",
        "Reply with exactly two lines, in this format, with nothing else:",
        "TITLE: <translated title>",
        "SUMMARY: <translated summary> (leave after the colon empty if the summary below is empty)",
        "",
        `TITLE: ${title}`,
        `SUMMARY: ${summary}`,
    ].join("\n");
}

export function parseHeadingTranslation(text: string): { title: string; summary: string } {
    let title = "";
    let summary = "";
    for (const line of text.split("\n")) {
        const titleMatch = /^TITLE:\s*(.*)$/i.exec(line.trim());
        if (titleMatch && !title) {
            title = titleMatch[1].trim();
            continue;
        }
        const summaryMatch = /^SUMMARY:\s*(.*)$/i.exec(line.trim());
        if (summaryMatch && !summary) {
            summary = summaryMatch[1].trim();
        }
    }
    if (!title) {
        title = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    }
    return { title, summary };
}

export interface FeedTranslationResult {
    titleEn: string | null;
    summaryEn: string | null;
    contentEn: string | null;
    skipped: boolean;
    error?: string;
}

/**
 * Translate one feed (title + summary in one call, content chunk by chunk)
 * with the site's ai_summary AI config — same enable switch and provider as
 * AI summaries, so no new settings surface is needed.
 */
export async function generateFeedTranslationResult(
    env: Env,
    serverConfig: ConfigReader,
    feed: { title: string | null; summary: string; content: string },
): Promise<FeedTranslationResult> {
    const config = await getAIConfig(serverConfig);
    if (!config.enabled) {
        return { titleEn: null, summaryEn: null, contentEn: null, skipped: true };
    }

    try {
        const heading = await generateAIText(env, config, [
            { role: "system", content: TRANSLATION_SYSTEM_PROMPT },
            { role: "user", content: buildHeadingTranslationPrompt(feed.title ?? "", feed.summary ?? "") },
        ], { maxTokens: resolveTranslationMaxTokens((feed.title ?? "") + (feed.summary ?? "")), temperature: 0.2 });
        const headingText = stripReasoningTags(heading.text ?? "");
        if (!headingText) {
            return {
                titleEn: null, summaryEn: null, contentEn: null, skipped: false,
                error: `Empty response from AI provider "${config.provider}" using model "${config.model}"`,
            };
        }
        const { title, summary } = parseHeadingTranslation(headingText);

        const translatedChunks: string[] = [];
        for (const chunk of chunkMarkdownForTranslation(feed.content)) {
            const result = await generateAIText(env, config, [
                { role: "system", content: TRANSLATION_SYSTEM_PROMPT },
                { role: "user", content: chunk },
            ], { maxTokens: resolveTranslationMaxTokens(chunk), temperature: 0.2 });
            const cleaned = stripReasoningTags(result.text ?? "");
            if (!cleaned) {
                return {
                    titleEn: null, summaryEn: null, contentEn: null, skipped: false,
                    error: `Empty translation for a content chunk (provider "${config.provider}", model "${config.model}")`,
                };
            }
            translatedChunks.push(cleaned);
        }

        return {
            titleEn: title,
            summaryEn: summary,
            contentEn: translatedChunks.join("\n\n"),
            skipped: false,
        };
    } catch (error) {
        console.error("[AI Translation] Failed to translate feed:", error);
        return {
            titleEn: null, summaryEn: null, contentEn: null, skipped: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
