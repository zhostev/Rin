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
import {
    TRANSCRIBE_DEFAULT_MAX_MINUTES,
    TRANSCRIBE_MAX_BYTES,
    TRANSCRIBE_CHUNK_SECONDS,
    TRANSCRIBE_CHUNK_TMP_PREFIX,
    WHISPER_MODEL,
} from "./models";

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
    /** 分片转写时为 true（客户端已在浏览器内切好片，服务端逐片转写再拼接） */
    chunked?: boolean;
    /** 分片转写时的片数 */
    chunks?: number;
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

/** Workers AI 调用函数类型（默认 runWorkerAIModel；测试可注入 fake，避免 mock.module 跨文件泄漏） */
export type WorkerAIRunner = (env: Env, model: string, input: unknown) => Promise<unknown>;

export async function transcribeAudio(
    env: Env,
    audio: Uint8Array,
    options: {
        durationSec?: number | null;
        maxMinutes?: number;
        language?: string;
        runModel?: WorkerAIRunner;
    } = {},
): Promise<TranscribeResult> {
    const { bytes, truncated } = planTruncation(audio, options.durationSec, options.maxMinutes);

    // 官方文档格式：{ audio: number[] }（原始文件字节数组）
    const response = await (options.runModel ?? runWorkerAIModel)(env, WHISPER_MODEL, {
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

/**
 * 从 16-bit PCM WAV 头解析音频时长（秒）。客户端分片固定生成此格式，
 * 用于拼接时给后一片的时间戳加偏移。解析失败返回 null（调用方用
 * TRANSCRIBE_CHUNK_SECONDS 兜底）。
 */
export function parseWavDurationSec(data: Uint8Array): number | null {
    try {
        if (data.length < 44) return null;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const ascii = (off: number, len: number) => {
            let s = "";
            for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
            return s;
        };
        if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return null;
        const sampleRate = view.getUint32(24, true);
        const channels = view.getUint16(22, true);
        const bitsPerSample = view.getUint16(34, true);
        if (!sampleRate || !channels || !bitsPerSample) return null;
        // data 子块不一定紧跟 fmt 之后，逐块扫描
        let off = 12;
        while (off + 8 <= data.length) {
            const id = ascii(off, 4);
            const size = view.getUint32(off + 4, true);
            if (id === "data") {
                const bytesPerSec = (sampleRate * channels * bitsPerSample) / 8;
                return bytesPerSec > 0 ? size / bytesPerSec : null;
            }
            off += 8 + size;
        }
        return null;
    } catch {
        return null;
    }
}

const CHUNK_KEY_RE = /^tmp\/aistudio-transcribe\/\d{14}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/chunk-\d{3}\.wav$/;

/**
 * 校验分片 R2 key：只允许本服务 presign 生成的固定格式，防止 task 参数被
 * 伪造成任意 R2 key 读取（key 遍历）。
 */
export function isTranscribeChunkKey(key: unknown): key is string {
    return typeof key === "string" && CHUNK_KEY_RE.test(key);
}

/** 生成一批分片的 R2 key（与 isTranscribeChunkKey 的正则保持一致）。 */
export function buildTranscribeChunkKeys(batchId: string, count: number): string[] {
    return Array.from(
        { length: count },
        (_, i) => `${TRANSCRIBE_CHUNK_TMP_PREFIX}${batchId}/chunk-${String(i).padStart(3, "0")}.wav`,
    );
}

/**
 * 逐片转写并拼接。time offset 按各片实际时长累加（WAV 头解析，失败则按
 * TRANSCRIBE_CHUNK_SECONDS 兜底），保证分段文稿的时间戳连续。
 * options.onChunk 每完成一片回调一次（processor 用来记用量）。
 */
export async function transcribeChunks(
    env: Env,
    chunks: Uint8Array[],
    options: {
        onChunk?: (index: number, result: TranscribeResult) => void | Promise<void>;
        runModel?: WorkerAIRunner;
    } = {},
): Promise<TranscribeResult> {
    const { onChunk, runModel } = options;
    const texts: string[] = [];
    const words: WhisperWord[] = [];
    const segments: WhisperSegment[] = [];
    let language = "";
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        const result = await transcribeAudio(env, chunks[i], { durationSec: null, runModel });
        if (onChunk) await onChunk(i, result);
        if (!language && result.language) language = result.language;
        if (result.text) texts.push(result.text);
        for (const w of result.words) {
            words.push({ word: w.word, start: w.start + offset, end: w.end + offset });
        }
        for (const s of result.segments) {
            segments.push({ start: s.start + offset, end: s.end + offset, text: s.text });
        }
        offset += parseWavDurationSec(chunks[i]) ?? TRANSCRIBE_CHUNK_SECONDS;
    }
    return {
        text: texts.join("\n"),
        language,
        segments,
        words,
        truncated: false,
        model: getWorkerAIModelId(WHISPER_MODEL),
        chunked: true,
        chunks: chunks.length,
    };
}
