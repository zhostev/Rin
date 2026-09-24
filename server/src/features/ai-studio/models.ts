/**
 * Stage 4 · AI Studio / 站内问答共享常量。
 *
 * AI 后端只用 Cloudflare Workers AI（env.AI 绑定），不引入外部付费 API。
 */

// Workers AI 模型（短名，见 server/src/utils/ai.ts WORKER_AI_MODELS）
export const WHISPER_MODEL = "whisper"; // @cf/openai/whisper
export const EMBED_MODEL = "bge-base-en"; // @cf/baai/bge-base-en-v1.5
export const CHAT_MODEL = "llama-3-1-8b-fp8"; // @cf/meta/llama-3.1-8b-instruct-fp8（llama-3.1-8b-instruct 已于 2026-05-30 下线）

/** bge-base-en-v1.5 的向量维度；Vectorize index s7ea-qa-staging 按此建 */
export const EMBEDDING_DIMENSIONS = 768;

/** Vectorize index 名（staging）。binding 名为 VECTORIZE（staging-only）。 */
export const QA_VECTORIZE_INDEX = "s7ea-qa-staging";

/** 站内问答 topK：quick/full */
export const ASK_TOPK_QUICK = 5;
export const ASK_TOPK_FULL = 10;

/** 向量命中分数阈值（cosine）：低于此视为无有效命中 */
export const RETRIEVAL_SCORE_FLOOR = 0.35;

/** 转写：默认只取音频前 N 分钟（Workers AI 输入有大小限制，长音频不做全量转写） */
export const TRANSCRIBE_DEFAULT_MAX_MINUTES = 10;
/** 转写输入硬上限（25MB），超过则截断并标记 truncated */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

/** embedding 批量大小（单次 AI.run 的文本条数） */
export const EMBED_BATCH_SIZE = 20;
/** Vectorize upsert 批量大小（向量条数） */
export const VECTORIZE_UPSERT_BATCH_SIZE = 100;

/** 文本切块：块大小/重叠（字符） */
export const CHUNK_SIZE = 500;
export const CHUNK_OVERLAP = 50;

/**
 * ai_artifacts.output_json 结构约定（按 job kind）。
 *
 * 所有 AI 输出先以 draft 形态落 artifacts（accepted_at 为空），人工 accept
 * 后才写入正文/转录。embed / retrieval-test / check 的产物本身即最终形态，
 * accept 仅做确认标记（幂等，不重复写）。
 *
 * --- aistudio.transcribe → kind: "transcript" ---
 * {
 *   kind: "transcript", assetId: number, language: string,
 *   text: string,                       // 全文
 *   segments: [{ start: number, end: number, text: string }], // 时间码分段
 *   words?: [{ word: string, start: number, end: number }],   // whisper 原始词级时间戳
 *   truncated: boolean,                 // 是否因 maxMinutes/MAX_BYTES 被截断
 *   model: string
 * }
 * accept: upsert transcripts(asset_id) → status 'draft'。
 *
 * --- aistudio.derive → kind: "derive" ---
 * {
 *   kind: "derive", storyId: number,
 *   summary: string,                    // 摘要（accept 时写入 stories.summary）
 *   sections: [{ title: string, summary: string }],  // 章节提要（仅参考）
 *   platformCopy: { xiaohongshu: string, weibo: string }, // 平台文案（仅参考）
 *   model: string
 * }
 * accept: 仅 summary 写入 stories.summary（不改 story 状态）；其余字段为参考素材。
 *
 * --- aistudio.check → kind: "check" ---
 * {
 *   kind: "check", storyId: number, checkedAt: number,
 *   issues: [{ type: "broken_link"|"missing_alt"|"stale_fact"|"metadata",
 *              detail: string, location: string }]
 * }
 * accept: 无正文写入，仅标记已阅（幂等）。
 *
 * --- aistudio.retrieval-test → kind: "retrieval-test" ---
 * {
 *   kind: "retrieval-test", question: string,
 *   chunks: [{ id: string, storyId: number, storySlug: string, title: string,
 *              blockId: number|null, text: string, score: number, url: string }]
 * }
 * accept: 无写入，仅标记已阅。
 *
 * --- aistudio.embed → kind: "embed" ---
 * { kind: "embed", chunks: number, vectors: number, model: string,
 *   dimensions: 768, index: "s7ea-qa-staging" }
 * accept: 向量已在 job 执行时 upsert，accept 仅确认（幂等）。
 */

export const AI_STUDIO_JOB_KINDS = [
    "transcribe",
    "derive",
    "check",
    "retrieval-test",
    "embed",
] as const;

export type AIStudioJobKind = (typeof AI_STUDIO_JOB_KINDS)[number];

/** 队列任务类型（与 server/src/queue/tasks.ts 中的常量保持一致） */
export function aiStudioQueueType(kind: AIStudioJobKind): string {
    return `aistudio.${kind}`;
}

export function aiStudioJobType(kind: AIStudioJobKind): string {
    return `aistudio.${kind}`;
}

export function isAIStudioJobKind(value: unknown): value is AIStudioJobKind {
    return (
        typeof value === "string" &&
        (AI_STUDIO_JOB_KINDS as readonly string[]).includes(value)
    );
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const DERIVE_SYSTEM_PROMPT =
    "你是一个中文内容编辑助手。根据用户提供的文章内容，输出严格的 JSON（不要输出 markdown 代码围栏以外的任何文字），" +
    "格式：{\"summary\": \"200字以内摘要\", " +
    "\"sections\": [{\"title\": \"章节标题\", \"summary\": \"章节提要\"}], " +
    "\"platformCopy\": {\"xiaohongshu\": \"小红书风格文案，带emoji，150字以内\", \"weibo\": \"微博风格文案，140字以内\"}}。" +
    "不要编造原文没有的信息。";

export const CHECK_STALE_FACT_SYSTEM_PROMPT =
    "你是一个中文内容校对助手。阅读用户提供的文章，找出其中可能已经过期的事实性表述" +
    "（如具体日期、价格、版本号、政策、活动信息），输出严格的 JSON 数组，" +
    "格式：[{\"detail\": \"问题描述\", \"location\": \"原文片段\"}]。" +
    "没有发现则输出 []。不要输出 JSON 以外的任何文字，不要编造。";

export const ASK_SYSTEM_PROMPT =
    "你是 s7ea.com（弯曲的时间，一个中文个人博客）的站内问答助手。" +
    "只根据下面提供的站内内容片段回答用户问题，回答用简洁自然的中文。" +
    "引用片段时在句末用 [1][2] 这样的序号标注，序号对应片段列表的顺序。" +
    "不要编造片段中没有的信息；如果片段不足以回答，如实说明。";
