import { describe, expect, it } from "bun:test";
import {
    concatMp3,
    estimateDurationSec,
    stripID3v2,
    synthesizeSpeech,
    ttsResponseToBytes,
} from "../tts";

function id3v2Tag(payloadSize: number): Uint8Array {
    // ID3v2 头：ID3 + ver(2B) + flags(1B) + 4B 同步安全整数
    const header = new Uint8Array(10);
    header[0] = 0x49;
    header[1] = 0x44;
    header[2] = 0x33;
    header[3] = 0x04;
    header[4] = 0x00;
    header[5] = 0x00;
    header[6] = (payloadSize >> 21) & 0x7f;
    header[7] = (payloadSize >> 14) & 0x7f;
    header[8] = (payloadSize >> 7) & 0x7f;
    header[9] = payloadSize & 0x7f;
    const tag = new Uint8Array(10 + payloadSize);
    tag.set(header, 0);
    tag.fill(0xaa, 10);
    return tag;
}

const fakeMp3Frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0xde, 0xad, 0xbe, 0xef]);

describe("stripID3v2", () => {
    it("strips a single ID3v2 header", () => {
        const chunk = new Uint8Array([...id3v2Tag(20), ...fakeMp3Frame]);
        const out = stripID3v2(chunk);
        expect(out).toEqual(fakeMp3Frame);
    });

    it("leaves chunks without a tag untouched", () => {
        expect(stripID3v2(fakeMp3Frame)).toEqual(fakeMp3Frame);
    });

    it("handles a zero-length tag", () => {
        const chunk = new Uint8Array([...id3v2Tag(0), ...fakeMp3Frame]);
        expect(stripID3v2(chunk)).toEqual(fakeMp3Frame);
    });
});

describe("concatMp3", () => {
    it("concatenates frames after stripping tags", () => {
        const a = new Uint8Array([...id3v2Tag(10), 1, 2, 3]);
        const b = new Uint8Array([...id3v2Tag(5), 4, 5]);
        const c = new Uint8Array([6, 7, 8, 9]); // 无标签块
        expect(concatMp3([a, b, c])).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    });

    it("returns empty for empty input", () => {
        expect(concatMp3([])).toEqual(new Uint8Array(0));
    });
});

describe("estimateDurationSec", () => {
    it("estimates Chinese at 4.5 chars/sec", () => {
        // 45 个汉字 → 10 秒
        expect(estimateDurationSec("中".repeat(45))).toBe(10);
    });

    it("estimates English words at 2.5 words/sec", () => {
        expect(estimateDurationSec("hello ".repeat(25).trim())).toBe(10);
    });

    it("floors at 1 second", () => {
        expect(estimateDurationSec("嗨")).toBe(1);
        expect(estimateDurationSec("")).toBe(1);
    });
});

describe("ttsResponseToBytes", () => {
    it("passes through Uint8Array", async () => {
        const b = new Uint8Array([1, 2, 3]);
        expect(await ttsResponseToBytes(b)).toBe(b);
    });

    it("wraps ArrayBuffer", async () => {
        const b = new Uint8Array([4, 5]).buffer;
        expect(await ttsResponseToBytes(b)).toEqual(new Uint8Array([4, 5]));
    });

    it("awaits Response-like objects", async () => {
        const resp = new Response(new Uint8Array([6, 7, 8]));
        expect(await ttsResponseToBytes(resp)).toEqual(new Uint8Array([6, 7, 8]));
    });

    it("accepts { audio: number[] }", async () => {
        expect(await ttsResponseToBytes({ audio: [9, 10] })).toEqual(new Uint8Array([9, 10]));
    });

    it("accepts { audio: base64 }", async () => {
        const b64 = Buffer.from([11, 12]).toString("base64");
        expect(await ttsResponseToBytes({ audio: b64 })).toEqual(new Uint8Array([11, 12]));
    });

    it("throws on unrecognized shapes", async () => {
        await expect(ttsResponseToBytes(null)).rejects.toThrow();
        await expect(ttsResponseToBytes({ text: "nope" })).rejects.toThrow();
    });
});

describe("synthesizeSpeech", () => {
    it("calls MeloTTS with ZH and returns bytes", async () => {
        const calls: Array<{ model: string; input: unknown }> = [];
        const env = {
            AI: {
                run: async (model: string, input: unknown) => {
                    calls.push({ model, input });
                    return new Uint8Array([0xff, 0xfb, 1, 2]).buffer;
                },
            },
        } as unknown as Env;
        const bytes = await synthesizeSpeech(env, "你好");
        expect(bytes).toEqual(new Uint8Array([0xff, 0xfb, 1, 2]));
        expect(calls).toHaveLength(1);
        expect(calls[0].model).toBe("@cf/myshell-ai/melotts");
        expect(calls[0].input).toEqual({ prompt: "你好", lang: "ZH" });
    });

    it("rejects empty text", async () => {
        const env = { AI: { run: async () => new ArrayBuffer(0) } } as unknown as Env;
        await expect(synthesizeSpeech(env, "  ")).rejects.toThrow("为空");
    });

    it("surfaces Workers AI errors (e.g. 401 without permission)", async () => {
        const env = {
            AI: {
                run: async () => {
                    throw new Error("401 Unauthorized");
                },
            },
        } as unknown as Env;
        await expect(synthesizeSpeech(env, "你好")).rejects.toThrow("401");
    });

    it("rejects when the AI binding is missing", async () => {
        await expect(synthesizeSpeech({} as Env, "你好")).rejects.toThrow();
    });
});
