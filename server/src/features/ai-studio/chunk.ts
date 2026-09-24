/**
 * Stage 4 · 文本切块（embedding / 问答检索用）。
 *
 * content_blocks.payload_json 是自由格式 JSON（rich_text 常见 {markdown}/{text}，
 * 图片/音视频块常见 {assetId}/{url}/{caption}），这里做防御式抽取：
 * 只取可读文本键，不把 JSON 结构本身喂给模型。
 */
import { CHUNK_OVERLAP, CHUNK_SIZE } from "./models";

export interface TextChunk {
    text: string;
    chunkIndex: number;
}

/** payload JSON 里可能承载正文的键（按优先级） */
const TEXT_KEYS = ["markdown", "text", "content", "html", "caption", "quote", "code"] as const;

function collectStrings(value: unknown, out: string[]): void {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) out.push(trimmed);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, out);
        return;
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        // 优先按已知文本键抽取，保持原文顺序感
        for (const key of TEXT_KEYS) {
            if (typeof record[key] === "string" && record[key].trim()) {
                out.push((record[key] as string).trim());
            }
        }
        // 兜底：其它字符串值也收（跳过已处理的键与明显非文本键）
        for (const [key, v] of Object.entries(record)) {
            if ((TEXT_KEYS as readonly string[]).includes(key)) continue;
            if (key === "assetId" || key === "asset_id" || key === "url" || key === "id") continue;
            if (typeof v === "string" && v.trim() && v.length < 2000) out.push(v.trim());
            else if (v && typeof v === "object") collectStrings(v, out);
        }
    }
}

/** 从 content_block payload_json 抽取可读文本 */
export function extractBlockText(payloadJson: string | null | undefined): string {
    if (!payloadJson) return "";
    let parsed: unknown;
    try {
        parsed = JSON.parse(payloadJson);
    } catch {
        // 不是 JSON：当纯文本处理
        return payloadJson.trim();
    }
    const parts: string[] = [];
    collectStrings(parsed, parts);
    // 去重（同一文本出现在 markdown+text 两个键时）
    return [...new Set(parts)].join("\n\n").trim();
}

/** 从 payload_json 抽取引用的 media asset id（image/gallery/video/audio 块） */
export function extractAssetIds(payloadJson: string | null | undefined): number[] {
    if (!payloadJson) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    const ids = new Set<number>();
    const walk = (value: unknown) => {
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        if (value && typeof value === "object") {
            for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
                if ((key === "assetId" || key === "asset_id") && typeof v === "number" && Number.isInteger(v)) {
                    ids.add(v);
                } else {
                    walk(v);
                }
            }
        }
    };
    walk(parsed);
    return [...ids];
}

/** 提取所有 http(s) 链接（断链检查用） */
export function extractUrls(text: string): string[] {
    const urls = new Set<string>();
    const re = /https?:\/\/[^\s<>"')\]]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        // 去掉末尾常见标点
        urls.add(m[0].replace(/[.,;!?，。；！？、]+$/, ""));
    }
    return [...urls];
}

/**
 * 按字符切块（中文按字算，无需分词）。块大小 CHUNK_SIZE，重叠 CHUNK_OVERLAP，
 * 尽量在换行/句号处断开，避免把句子拦腰切断。
 */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): TextChunk[] {
    const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    if (!clean) return [];

    const chunks: TextChunk[] = [];
    let start = 0;
    let index = 0;
    while (start < clean.length) {
        let end = Math.min(start + size, clean.length);
        if (end < clean.length) {
            // 找断点：优先换行，其次中英文句号/问号/感叹号
            const window = clean.slice(start, end);
            const breakRe = /[\n。！？!?]/g;
            let lastBreak = -1;
            let bm: RegExpExecArray | null;
            while ((bm = breakRe.exec(window)) !== null) {
                lastBreak = bm.index;
            }
            if (lastBreak > size * 0.4) {
                end = start + lastBreak + 1;
            }
        }
        const piece = clean.slice(start, end).trim();
        if (piece) {
            chunks.push({ text: piece, chunkIndex: index++ });
        }
        if (end >= clean.length) break;
        start = Math.max(end - overlap, start + 1);
    }
    return chunks;
}
