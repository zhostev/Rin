/**
 * 文章播客化 TTS · Workers AI MeloTTS 合成。
 *
 * P0 硬编码中文单音色：env.AI.run("@cf/myshell-ai/melotts", { prompt, lang: "ZH" })。
 * 注意：该环境 API token 可能没有 Workers AI 权限（whisper 有 401 前科），
 * 调用失败时抛错，由调用方落 failed 状态并记录原因，不要假设能 live 调通。
 */
import { runWorkerAIModel } from "./ai";

/** Workers AI MeloTTS 中文语音合成模型（短名，见 utils/ai.ts WORKER_AI_MODELS）。 */
export const MELOTTS_MODEL = "melotts";

/** 单篇文章朗读文本上限（字符）：超了直接 failed，提示拆篇。 */
export const TTS_MAX_CHARS = 20000;

/** 单次合成的文本块上限（字符）：MeloTTS 短文本更稳定。 */
export const TTS_CHUNK_CHARS = 1500;

/** 中文朗读语速（字/秒），用于时长估算。 */
export const ZH_CHARS_PER_SEC = 4.5;

/** 英文朗读语速（词/秒），用于时长估算。 */
export const EN_WORDS_PER_SEC = 2.5;

/**
 * 把 Workers AI TTS 的各种返回形态统一成字节。
 * REST 下是二进制音频；binding 下可能是 ArrayBuffer / Response / { audio }。
 * 纯函数（除 Response 分支），可单测。
 */
export async function ttsResponseToBytes(response: unknown): Promise<Uint8Array> {
    if (response instanceof Uint8Array) return response;
    if (response instanceof ArrayBuffer) return new Uint8Array(response);
    if (typeof SharedArrayBuffer !== "undefined" && response instanceof SharedArrayBuffer) {
        return new Uint8Array(response);
    }
    if (
        response &&
        typeof (response as { arrayBuffer?: unknown }).arrayBuffer === "function"
    ) {
        return new Uint8Array(
            await (response as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer(),
        );
    }
    if (response && typeof response === "object") {
        const audio = (response as Record<string, unknown>).audio;
        if (Array.isArray(audio)) return Uint8Array.from(audio as number[]);
        if (typeof audio === "string") return base64ToBytes(audio);
    }
    throw new Error("MeloTTS 返回了无法识别的响应格式");
}

function base64ToBytes(base64: string): Uint8Array {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/**
 * 合成一段文本的语音。失败抛错（含 Workers AI 401/限流等）。
 */
export async function synthesizeSpeech(env: Env, text: string): Promise<Uint8Array> {
    if (!text.trim()) throw new Error("TTS 文本为空");
    const response = await runWorkerAIModel(env, MELOTTS_MODEL, {
        prompt: text,
        lang: "ZH",
    });
    const bytes = await ttsResponseToBytes(response);
    if (bytes.length === 0) throw new Error("MeloTTS 返回了空音频");
    return bytes;
}

/**
 * 去掉单个 MP3 块的 ID3v2 头，返回头之后的内容。
 * ID3v2 头：3 字节 "ID3" + 2 字节版本 + 1 字节 flags + 4 字节同步安全整数（总长）。
 * 纯函数，可单测。
 */
export function stripID3v2(chunk: Uint8Array): Uint8Array {
    let offset = 0;
    while (
        chunk.length - offset >= 10 &&
        chunk[offset] === 0x49 && // I
        chunk[offset + 1] === 0x44 && // D
        chunk[offset + 2] === 0x33 // 3
    ) {
        const size =
            ((chunk[offset + 6] & 0x7f) << 21) |
            ((chunk[offset + 7] & 0x7f) << 14) |
            ((chunk[offset + 8] & 0x7f) << 7) |
            (chunk[offset + 9] & 0x7f);
        offset += 10 + size;
    }
    return chunk.slice(offset);
}

/**
 * 拼接多个 MP3 块：去掉每块的 ID3v2 标签头后直接字节拼接。
 * MP3 是帧流，帧级拼接在主流播放器（Safari/Chrome/播客 App）可连续播放。
 * 纯函数，可单测。
 */
export function concatMp3(chunks: Uint8Array[]): Uint8Array {
    const stripped = chunks.map(stripID3v2).filter((c) => c.length > 0);
    const total = stripped.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of stripped) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const WORD_RE = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*/g;

/**
 * 按语速估算朗读时长（秒），至少 1 秒。纯函数，可单测。
 */
export function estimateDurationSec(text: string): number {
    const cjk = (text.match(CJK_RE) ?? []).length;
    const words = (text.match(WORD_RE) ?? []).length;
    return Math.max(1, Math.ceil(cjk / ZH_CHARS_PER_SEC + words / EN_WORDS_PER_SEC));
}
