import { describe, expect, it, mock } from "bun:test";

// mock 必须先于 whisper 导入（bun 会提升 mock.module）
const runWorkerAIModel = mock(
    async (_env: unknown, _model: string, _input: unknown): Promise<unknown> => ({}),
);
mock.module("../../../utils/ai", () => ({
    runWorkerAIModel,
    getWorkerAIModelId: (short: string) => `@cf/test/${short}`,
}));

import {
    buildTranscribeChunkKeys,
    isTranscribeChunkKey,
    parseWavDurationSec,
    transcribeChunks,
} from "../whisper";

/** 构造指定时长的 16-bit PCM WAV（与客户端 encodeWavBlob 同格式） */
function makeWav(seconds: number, sampleRate = 16000): Uint8Array {
    const dataSize = Math.floor(seconds * sampleRate) * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const ascii = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, dataSize, true);
    return new Uint8Array(buffer);
}

describe("parseWavDurationSec", () => {
    it("parses duration from a 16kHz mono WAV header", () => {
        expect(parseWavDurationSec(makeWav(30))).toBeCloseTo(30, 3);
        expect(parseWavDurationSec(makeWav(7.5))).toBeCloseTo(7.5, 3);
    });

    it("returns null for non-WAV data", () => {
        expect(parseWavDurationSec(new Uint8Array(100))).toBeNull();
        expect(parseWavDurationSec(new Uint8Array(0))).toBeNull();
        const wav = makeWav(10);
        wav[0] = "X".charCodeAt(0); // 破坏 RIFF magic
        expect(parseWavDurationSec(wav)).toBeNull();
    });
});

describe("isTranscribeChunkKey", () => {
    const valid = buildTranscribeChunkKeys("20261001120000-12345678-1234-1234-1234-123456789abc", 2);

    it("accepts keys built by buildTranscribeChunkKeys", () => {
        expect(valid).toHaveLength(2);
        for (const key of valid) expect(isTranscribeChunkKey(key)).toBe(true);
    });

    it("rejects path traversal and arbitrary keys", () => {
        expect(
            isTranscribeChunkKey("tmp/aistudio-transcribe/20261001120000-12345678-1234-1234-1234-123456789abc/../evil.wav"),
        ).toBe(false);
        expect(isTranscribeChunkKey("media/a.mp3")).toBe(false);
        expect(isTranscribeChunkKey("tmp/aistudio-transcribe/x/chunk-000.wav")).toBe(false);
        expect(isTranscribeChunkKey("tmp/aistudio-transcribe/20261001120000-12345678-1234-1234-1234-123456789abc/chunk-0.wav")).toBe(false);
        expect(isTranscribeChunkKey(undefined)).toBe(false);
        expect(isTranscribeChunkKey(123)).toBe(false);
    });
});

describe("transcribeChunks", () => {
    it("transcribes each chunk and offsets timestamps by chunk duration", async () => {
        runWorkerAIModel.mockReset();
        runWorkerAIModel.mockImplementation(async () => {
            const n = runWorkerAIModel.mock.calls.length;
            return n === 1
                ? { text: "第一段", words: [{ word: "第一段", start: 0, end: 2 }] }
                : { text: "第二段", words: [{ word: "第二段", start: 1, end: 3 }] };
        });

        const seen: number[] = [];
        const result = await transcribeChunks(null as any, [makeWav(30), makeWav(30)], async (i) => {
            seen.push(i);
        });

        expect(runWorkerAIModel.mock.calls).toHaveLength(2);
        // Whisper binding 契约：{ audio: number[] }
        for (const call of runWorkerAIModel.mock.calls) {
            expect(Array.isArray((call[2] as any).audio)).toBe(true);
        }
        expect(seen).toEqual([0, 1]);
        expect(result.text).toBe("第一段\n第二段");
        expect(result.chunked).toBe(true);
        expect(result.chunks).toBe(2);
        expect(result.truncated).toBe(false);
        // 第二片的时间戳按第一片时长（30s）偏移
        expect(result.words[0]).toEqual({ word: "第一段", start: 0, end: 2 });
        expect(result.words[1]).toEqual({ word: "第二段", start: 31, end: 33 });
        expect(result.segments[1].start).toBe(31);
    });

    it("skips empty chunk texts when joining", async () => {
        runWorkerAIModel.mockReset();
        runWorkerAIModel.mockImplementation(async () => {
            const n = runWorkerAIModel.mock.calls.length;
            return n === 1 ? { text: "", words: [] } : { text: "有声", words: [] };
        });
        const result = await transcribeChunks(null as any, [makeWav(30), makeWav(30)]);
        expect(result.text).toBe("有声");
    });
});
