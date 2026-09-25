import type { ComposeLength, MediaType } from "@rin/api";

export type ComposeAsset = {
    id: string;
    type: MediaType;
    provider: "r2" | "stream";
    note: string;
};

export type ComposedArticle = {
    title: string;
    summary: string;
    tags: string[];
    content: string;
};

export type ComposeGateResult = { ok: true } | { ok: false; reason: string };

/** Chinese-character ranges quoted to the model; not enforced by the gate. */
export const COMPOSE_LENGTH_RANGES: Record<ComposeLength, { min: number; max: number }> = {
    short: { min: 600, max: 1000 },
    medium: { min: 1200, max: 2000 },
    long: { min: 2500, max: 4000 },
};

/** Roughly two tokens per Chinese character, so a long article is not truncated. */
const TOKENS_PER_CHARACTER = 2;

const MIN_BODY_LENGTH = 100;

const PLACEHOLDER_PATTERN = /\[\[media:(\d+)\]\]/g;

export const DEFAULT_COMPOSE_SYSTEM_PROMPT = [
    "你是一位中文博客作者。请根据用户给出的选题与素材写出一篇完整的 Markdown 文章。",
    "",
    "输出格式要求（必须严格遵守）：",
    "1. 以一段 front-matter 开头，用三个连字符包围，其中包含 title、summary、tags 三个字段。",
    "2. front-matter 之后空一行，接正文 Markdown。",
    "3. 正文中不要再重复一级标题。",
    "4. 只输出文章本身，不要输出任何解释、前言或代码块包裹。",
    "5. 绝不编造图片、视频、音频链接或 HTML 标签；没有提供素材清单时，正文中不要插入任何媒体引用。",
    "",
    "示例：",
    "---",
    "title: 文章标题",
    "summary: 一句话摘要",
    "tags: 标签一, 标签二",
    "---",
    "",
    "正文第一段……",
].join("\n");

export function composeMaxTokensFloor(length: ComposeLength): number {
    return COMPOSE_LENGTH_RANGES[length].max * TOKENS_PER_CHARACTER;
}

export function buildComposeUserMessage(input: {
    topic: string;
    assets: ComposeAsset[];
    length: ComposeLength;
    style?: string;
}): string {
    const { topic, assets, length, style } = input;
    const range = COMPOSE_LENGTH_RANGES[length];

    const sections: string[] = [
        `选题：${topic}`,
        `篇幅：正文约 ${range.min} 到 ${range.max} 个中文字符。`,
    ];

    if (style && style.trim().length > 0) {
        sections.push(`风格：${style.trim()}`);
    }

    if (assets.length > 0) {
        const lines = assets.map((asset, index) => {
            const kind = asset.type === "image" ? "图片" : asset.type === "video" ? "视频" : "音频";
            const note = asset.note.trim() || "（无说明）";
            return `[[media:${index + 1}]] ${kind} —— ${note}`;
        });

        sections.push(
            [
                "素材清单：",
                ...lines,
                "",
                "请在正文中合适的位置插入素材，写法是 [[media:编号]]，例如 [[media:1]]。",
                "编号只能来自上面的清单。不要自行编写图片链接或 HTML 标签，系统会把占位符替换为正确的引用。",
                "每个素材至少引用一次。",
            ].join("\n"),
        );
    }

    return sections.join("\n\n");
}

/** The model sometimes wraps the whole answer in a fenced block. */
function stripCodeFence(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("```")) {
        return trimmed;
    }

    const lines = trimmed.split("\n");
    if (lines.length < 2) {
        return trimmed;
    }

    lines.shift();
    if (lines[lines.length - 1]?.trim().startsWith("```")) {
        lines.pop();
    }

    return lines.join("\n").trim();
}

function unquote(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1).trim();
        }
    }
    return trimmed;
}

function parseTags(value: string): string[] {
    return unquote(value)
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(/[,，、]/)
        .map((tag) => unquote(tag))
        .filter((tag) => tag.length > 0);
}

export function parseComposedArticle(raw: string): ComposedArticle {
    const text = stripCodeFence(raw);
    const article: ComposedArticle = { title: "", summary: "", tags: [], content: "" };

    const lines = text.split("\n");

    if (lines[0]?.trim() === "---") {
        const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

        if (closing > 0) {
            for (const line of lines.slice(1, closing)) {
                const separator = line.indexOf(":");
                if (separator <= 0) continue;

                const key = line.slice(0, separator).trim().toLowerCase();
                const value = line.slice(separator + 1);

                if (key === "title") article.title = unquote(value);
                else if (key === "summary") article.summary = unquote(value);
                else if (key === "tags") article.tags = parseTags(value);
            }

            article.content = lines.slice(closing + 1).join("\n").trim();
            return article;
        }
    }

    // No usable front-matter: fall back to the first h1, if any.
    const headingIndex = lines.findIndex((line) => /^#\s+/.test(line.trim()));
    if (headingIndex >= 0) {
        article.title = lines[headingIndex].trim().replace(/^#\s+/, "").trim();
        article.content = [...lines.slice(0, headingIndex), ...lines.slice(headingIndex + 1)]
            .join("\n")
            .trim();
        return article;
    }

    article.content = text.trim();
    return article;
}

/**
 * Only rejects output that is plainly broken. Quality is explicitly not judged —
 * the spec's publish-without-review decision rests on this being the sole gate.
 * Runs before placeholders are rendered so the length check measures prose.
 */
export function checkComposeGate(article: ComposedArticle): ComposeGateResult {
    if (article.title.trim().length === 0) {
        return { ok: false, reason: "AI 返回的内容里没有解析出标题" };
    }

    const prose = article.content.replace(PLACEHOLDER_PATTERN, "").trim();
    if (prose.length < MIN_BODY_LENGTH) {
        return {
            ok: false,
            reason: `AI 返回的正文过短（${prose.length} 字符，至少需要 ${MIN_BODY_LENGTH} 字符）`,
        };
    }

    return { ok: true };
}

function imageMarkup(asset: ComposeAsset): string {
    const alt = asset.note.replace(/[[\]]/g, "").trim();
    return `![${alt}](/api/media/${encodeURIComponent(asset.id)}/playback)`;
}

/** Mirrors client/src/components/media-embed.tsx buildMediaMarkup. */
function playableMarkup(asset: ComposeAsset): string {
    const tag = asset.type === "audio" ? "audio" : "video";
    const safeTitle = asset.note.replace(/["<>]/g, "").trim();
    const titleAttribute = safeTitle ? ` title="${safeTitle}"` : "";
    const providerAttribute =
        asset.provider !== "r2" ? ` data-rin-media-provider="${asset.provider}"` : "";
    return `<${tag} data-rin-media-id="${asset.id}"${providerAttribute}${titleAttribute} controls></${tag}>`;
}

function assetMarkup(asset: ComposeAsset): string {
    return asset.type === "image" ? imageMarkup(asset) : playableMarkup(asset);
}

export function renderMediaPlaceholders(content: string, assets: ComposeAsset[]): string {
    if (assets.length === 0) {
        return content;
    }

    const used = new Set<number>();

    const rendered = content.replace(PLACEHOLDER_PATTERN, (_match, rawIndex: string) => {
        const index = Number.parseInt(rawIndex, 10) - 1;
        const asset = assets[index];
        if (!asset) {
            // The model invented a number we never offered: drop it rather than
            // leaving bracket noise in a published article.
            return "";
        }

        used.add(index);
        return assetMarkup(asset);
    });

    const unused = assets.filter((_asset, index) => !used.has(index));
    if (unused.length === 0) {
        return rendered;
    }

    // The admin deliberately supplied these; appending beats dropping silently.
    return [rendered.trim(), ...unused.map((asset) => assetMarkup(asset))].join("\n\n");
}
