/**
 * Stage 3 · 转录搜索（P1 字幕/转录索引的检索侧）。
 *
 * 命中 transcripts 表的 text / segments_json，只返回命中片段前后各 ~40 字，
 * 不把整篇转录文本甩给前端。segments 只返回包含关键词的条目（最多 3 条）。
 */
import type { DB } from "../../core/hono-types";
import { buildAssetStoryMap, findTranscriptsByKeyword, VISIBLE_STORY_STATUSES } from "./repository";

export interface TranscriptSegmentHit {
    start: number;
    end: number;
    text: string;
}

export interface TranscriptHit {
    assetId: number;
    storyId: number;
    storySlug: string;
    storyTitle: string | null;
    /** 命中位置前后各 ~40 字，截断处加省略号 */
    snippet: string;
    segments: TranscriptSegmentHit[];
}

const SNIPPET_RADIUS = 40;
const MAX_SEGMENTS = 3;

function buildSnippet(text: string, keyword: string): string {
    const lower = text.toLowerCase();
    const needle = keyword.toLowerCase();
    const idx = lower.indexOf(needle);
    if (idx === -1) {
        // 理论上不会发生（SQL 已 LIKE 命中），兜底取开头
        const head = text.slice(0, SNIPPET_RADIUS * 2);
        return text.length > head.length ? `${head}…` : head;
    }
    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(text.length, idx + keyword.length + SNIPPET_RADIUS);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return `${prefix}${text.slice(start, end)}${suffix}`;
}

interface RawSegment {
    start?: unknown;
    end?: unknown;
    text?: unknown;
}

function pickHitSegments(segmentsJson: string, keyword: string): TranscriptSegmentHit[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(segmentsJson);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    const needle = keyword.toLowerCase();
    const hits: TranscriptSegmentHit[] = [];
    for (const entry of parsed as RawSegment[]) {
        if (typeof entry !== "object" || entry === null) {
            continue;
        }
        const text = entry.text;
        if (typeof text !== "string" || !text.toLowerCase().includes(needle)) {
            continue;
        }
        hits.push({
            start: typeof entry.start === "number" ? entry.start : 0,
            end: typeof entry.end === "number" ? entry.end : 0,
            text,
        });
        if (hits.length >= MAX_SEGMENTS) {
            break;
        }
    }
    return hits;
}

/**
 * 公开搜索只返回归属 story 为 published/updated 的转录；
 * 管理端（publicOnly=false）不限制 story 状态。
 */
export async function searchTranscripts(
    db: DB,
    keyword: string,
    options: { publicOnly: boolean },
): Promise<TranscriptHit[]> {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) {
        return [];
    }
    const [rows, storyMap] = await Promise.all([
        findTranscriptsByKeyword(db, trimmed),
        buildAssetStoryMap(db, options.publicOnly ? VISIBLE_STORY_STATUSES : undefined),
    ]);

    const hits: TranscriptHit[] = [];
    for (const row of rows) {
        const info = storyMap.get(row.assetId);
        if (!info) {
            // 转录所属资产没有被任何（可见）story 引用：公开搜索跳过，
            // 管理端同样跳过——无归属的转录在前端无处落脚。
            continue;
        }
        hits.push({
            assetId: row.assetId,
            storyId: info.storyId,
            storySlug: info.storySlug,
            storyTitle: info.storyTitle,
            snippet: buildSnippet(row.text, trimmed),
            segments: pickHitSegments(row.segmentsJson, trimmed),
        });
    }
    return hits;
}
