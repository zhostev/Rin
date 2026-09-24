/**
 * Stage 4 · 站内问答（/api/ask）业务逻辑。
 *
 * POST /api/ask {question, mode?}：
 *   问题 → embedding → Vectorize 检索 top chunks → LLM 生成带引用回答。
 *   无命中：coverage 'none'，answer 必须包含"本站没有覆盖"。
 *   金融/政策类：返回 verifiedAt（引用 story 中最晚的 verified_at）。
 *
 * GET /api/ask/recommend?storyId=：按概念向量返回关联 story。
 */
import { inArray } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import { stories } from "../../db/schema";
import { getWorkerAIModelId } from "../../utils/ai";
import { embedOne, querySimilar, retrieveForQuestion, type RetrievalMatch } from "./embed";

// 测试与外部调用者可从本模块取到检索命中的类型。
export type { RetrievalMatch };
import { recordUsage } from "./guard";
import { loadStoryContent } from "./jobs";
import { ASK_TOPK_FULL, ASK_TOPK_QUICK, EMBED_MODEL } from "./models";
import { answerWithCitations } from "./processors";
import { extractBlockText } from "./chunk";

export type AskMode = "quick" | "full";
export type AskCoverage = "full" | "partial" | "none";

export interface AskCitation {
    storySlug: string;
    title: string;
    blockId?: number;
    text: string;
    url: string;
}

export interface AskResult {
    answer: string;
    citations: AskCitation[];
    coverage: AskCoverage;
    verifiedAt?: string;
}

export function normalizeAskMode(value: unknown): AskMode {
    return value === "full" ? "full" : "quick";
}

/**
 * coverage 判定（纯函数，可单测）：
 * - 无命中 → none
 * - 命中 1–2 个 → partial
 * - 3+ → full
 */
export function decideCoverage(matches: RetrievalMatch[]): AskCoverage {
    if (matches.length === 0) return "none";
    if (matches.length < 3) return "partial";
    return "full";
}

/** 无覆盖时的固定回答（必须包含"本站没有覆盖"） */
export function buildNoCoverageAnswer(question: string): string {
    return `本站没有覆盖「${question.trim()}」相关的内容，暂时无法回答。换个问法试试，或去站内搜索看看。`;
}

/** 金融/政策类关键词（命中则回答附 verifiedAt） */
const FINANCE_POLICY_RE = /(金融|理财|投资|股票|基金|利率|汇率|银行|支付|保险|税务|税收|个税|政策|法规|法律|签证|医保|社保|公积金|房贷|贷款|信用卡|借记卡|手续费|跨境|汇款)/;

export function isFinancePolicyTopic(question: string, matches: RetrievalMatch[]): boolean {
    if (FINANCE_POLICY_RE.test(question)) return true;
    return matches.some((m) => FINANCE_POLICY_RE.test(`${m.chunk.title} ${m.chunk.text.slice(0, 200)}`));
}

function citationFromMatch(m: RetrievalMatch): AskCitation {
    const citation: AskCitation = {
        storySlug: m.chunk.storySlug,
        title: m.chunk.title,
        text: m.chunk.text.slice(0, 200),
        url: m.chunk.url,
    };
    if (m.chunk.blockId !== null) citation.blockId = m.chunk.blockId;
    return citation;
}

export async function answerQuestion(
    env: Env,
    db: DB,
    question: string,
    mode: AskMode,
): Promise<AskResult> {
    const q = question.trim();
    const { matches } = await retrieveForQuestion(env, q, mode);
    await recordUsage(db, { jobId: null, model: getWorkerAIModelId(EMBED_MODEL) });

    const coverage = decideCoverage(matches);
    if (coverage === "none") {
        return { answer: buildNoCoverageAnswer(q), citations: [], coverage };
    }

    const topK = mode === "full" ? ASK_TOPK_FULL : ASK_TOPK_QUICK;
    const used = matches.slice(0, topK);
    const context = used
        .map((m, i) => `[${i + 1}] 《${m.chunk.title}》\n${m.chunk.text}`)
        .join("\n\n");

    const { text } = await answerWithCitations(env, db, q, context);
    const answer = text.trim() || buildNoCoverageAnswer(q);

    const result: AskResult = {
        answer,
        citations: used.map(citationFromMatch),
        coverage,
    };

    if (isFinancePolicyTopic(q, used)) {
        const storyIds = [...new Set(used.map((m) => m.chunk.storyId).filter((id) => id > 0))];
        if (storyIds.length > 0) {
            const rows = await db.query.stories.findMany({
                where: inArray(stories.id, storyIds),
            });
            let latest: number | null = null;
            for (const row of rows) {
                const v = row.verifiedAt;
                const ts = v instanceof Date ? Math.floor(v.getTime() / 1000) : typeof v === "number" ? v : null;
                if (ts && (latest === null || ts > latest)) latest = ts;
            }
            if (latest !== null) {
                result.verifiedAt = new Date(latest * 1000).toISOString().slice(0, 10);
            }
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// 简单限流：每 IP 每 10 分钟最多 N 次（纯函数 + 模块级桶，可单测）
// ---------------------------------------------------------------------------

export const ASK_RATE_LIMIT = 20;
export const ASK_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * 返回 true 表示允许本次请求（并计入），false 表示超限。
 * buckets 由调用方持有（worker 内为模块级 Map）。
 */
export function checkAskRateLimit(
    buckets: Map<string, number[]>,
    key: string,
    nowMs: number,
    limit: number = ASK_RATE_LIMIT,
    windowMs: number = ASK_RATE_WINDOW_MS,
): boolean {
    const cutoff = nowMs - windowMs;
    const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length >= limit) {
        buckets.set(key, hits);
        return false;
    }
    hits.push(nowMs);
    buckets.set(key, hits);
    return true;
}

// ---------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------

export interface RecommendItem {
    storySlug: string;
    title: string;
    reason: string;
}

function storyTextForRecommend(content: {
    title: string | null;
    summary: string;
    blocks: Array<{ payloadJson: string }>;
}): string {
    const parts = [`${content.title ?? ""}\n${content.summary ?? ""}`];
    for (const block of content.blocks.slice(0, 5)) {
        const t = extractBlockText(block.payloadJson);
        if (t) parts.push(t);
    }
    return parts.join("\n\n").slice(0, 2000).trim();
}

export async function recommendForStory(
    env: Env,
    db: DB,
    storyId: number,
): Promise<{ items: RecommendItem[] } | { error: "not_found" }> {
    const story = await loadStoryContent(db, storyId);
    if (!story) return { error: "not_found" };

    const text = storyTextForRecommend(story);
    if (!text) return { items: [] };

    const vector = await embedOne(env, text);
    await recordUsage(db, { jobId: null, model: getWorkerAIModelId(EMBED_MODEL) });

    const matches = await querySimilar(env, vector, 12);

    const seen = new Set<number>();
    const picked: RetrievalMatch[] = [];
    for (const m of matches) {
        if (m.chunk.storyId === storyId || m.chunk.storyId <= 0) continue;
        if (seen.has(m.chunk.storyId)) continue;
        seen.add(m.chunk.storyId);
        picked.push(m);
        if (picked.length >= 5) break;
    }
    if (picked.length === 0) return { items: [] };

    const rows = await db.query.stories.findMany({
        where: inArray(stories.id, picked.map((p) => p.chunk.storyId)),
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    return {
        items: picked
            .map((p) => {
                const row = byId.get(p.chunk.storyId);
                if (!row) return null;
                return {
                    storySlug: row.slug,
                    title: row.title ?? p.chunk.title,
                    reason: `与《${story.title ?? story.slug}》语义相关`,
                };
            })
            .filter((i): i is RecommendItem => i !== null),
    };
}
