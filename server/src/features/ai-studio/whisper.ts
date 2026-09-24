/**
 * Stage 4 · Whisper 语音转写。
 *
 * 输入格式（已按 Cloudflare 官方文档确认；live 实测因所存 API token 缺少
 * Workers AI 权限返回 401，未能跑通，故以文档为准）：
 *   env.AI.run("@cf/openai/whisper", { audio: [...new Uint8Array(arrayBuffer)] })
 * 即 { audio: number[] }（音频文件的原始字节数组），或 REST 下直接传二进制。
 * 输出：{ text: string, word_count: number, words?: [{word, start, end}] }
 * （词级时间戳；无 sentence 级 segments，本模块按标点聚合成 segments）。
 *
 * 长音频策略：按 media_assets.duration 等比截取前 maxMinutes 分钟，
 * 另有 TRANSCRIBE_MAX_BYTES 硬上限；截断时 artifact 标记 truncated=true。
 */
import { getWorkerAIModelId, runWorkerAIModel } from "../../utils/ai";
import { TRANSCRIBE_DEFAULT_MAX_MINUTES, TRANSCRIBE_MAX_BYTES, WHISPER_MODEL } from "./models";

export interface WhisperSegment {
    start: number;
    end: number;
    text: string;
}

export interface WhisperWord {
    word: string;
    start: number;
    end: number;
}

export interface TranscribeResult {
    text: string;
    language: string;
    segments: WhisperSegment[];
    words: WhisperWord[];
    truncated: boolean;
    model: string;
}

export interface TruncatePlan {
    bytes: Uint8Array;
    truncated: boolean;
}

/**
 * 按时长等比截断音频字节（CBR 近似；VBR 会有偏差，文档注明）。
 * durationSec<=0 或未知时不做时长截断，只做硬上限截断。
 */
export function planTruncation(
    data: Uint8Array,
    durationSec: number | null | undefined,
    maxMinutes: number = TRANSCRIBE_DEFAULT_MAX_MINUTES,
    maxBytes: number = TRANSCRIBE_MAX_BYTES,
): TruncatePlan {
    let bytes = data;
    let truncated = false;

    if (durationSec && durationSec > 0 && maxMinutes > 0) {
        const keepRatio = (maxMinutes * 60) / durationSec;
        if (keepRatio < 1) {
            const keep = Math.max(1024, Math.floor(data.length * keepRatio));
            bytes = data.slice(0, keep);
            truncated = true;
        }
    }

    if (bytes.length > maxBytes) {
        bytes = bytes.slice(0, maxBytes);
        truncated = true;
    }

    return { bytes, truncated };
}

/**
 * 把 whisper 的词级时间戳聚成"句子级" segments：
 * 遇到中英文句末标点或词间间隔 > 1.2s 即断句；单句最长 60 词兜底。
 */
export function groupWordsIntoSegments(words: WhisperWord[]): WhisperSegment[] {
    const segments: WhisperSegment[] = [];
    let current: WhisperWord[] = [];

    const flush = () => {
        if (current.length === 0) return;
        segments.push({
            start: current[0].start,
            end: current[current.length - 1].end,
            text: current.map((w) => w.word).join(""),
        });
        current = [];
    };

    for (const word of words) {
        const prev = current[current.length - 1];
        if (prev && word.start - prev.end > 1.2) flush();
        current.push(word);
        if (/[。！？!?]$/.test(word.word) || current.length >= 60) flush();
    }
    flush();
    return segments;
}

function parseWhisperResponse(response: unknown): { text: string; words: WhisperWord[] } {
    if (!response || typeof response !== "object") {
        throw new Error("Whisper 返回了空响应");
    }
    const r = response as Record<string, any>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    const words: WhisperWord[] = Array.isArray(r.words)
        ? r.words
              .filter(
                  (w: any) =>
                      w && typeof w.word === "string" && typeof w.start === "number" && typeof w.end === "number",
              )
              .map((w: any) => ({ word: w.word, start: w.start, end: w.end }))
        : [];
    // whisper 有时返回 segments（large-v3 系列）；兼容提取
    if (words.length === 0 && Array.isArray(r.segments)) {
        for (const s of r.segments) {
            if (s && typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number") {
                words.push({ word: s.text, start: s.start, end: s.end });
            }
        }
    }
    return { text, words };
}

export async function transcribeAudio(
    env: Env,
    audio: Uint8Array,
    options: { durationSec?: number | null; maxMinutes?: number; language?: string } = {},
): Promise<TranscribeResult> {
    const { bytes, truncated } = planTruncation(audio, options.durationSec, options.maxMinutes);

    // 官方文档格式：{ audio: number[] }（原始文件字节数组）
    const response = await runWorkerAIModel(env, WHISPER_MODEL, {
        audio: [...bytes],
    });

    const { text, words } = parseWhisperResponse(response);
    const segments =
        words.length > 0
            ? groupWordsIntoSegments(words)
            : text
              ? [{ start: 0, end: 0, text }]
              : [];

    return {
        text,
        language: options.language ?? "",
        segments,
        words,
        truncated,
        model: getWorkerAIModelId(WHISPER_MODEL),
    };
}
