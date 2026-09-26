import { describe, expect, it } from "bun:test";
import {
    normalizeImageCount,
    normalizeImageMode,
    parsePlannedImages,
    planImagesWithRetry,
    salvagePartialPrompts,
    toImageBytes,
} from "../ai-images";
import type { AITextResult } from "../../utils/ai";

describe("normalizeImageMode", () => {
    it("passes through the supported modes", () => {
        expect(normalizeImageMode("none")).toBe("none");
        expect(normalizeImageMode("generate")).toBe("generate");
        expect(normalizeImageMode("search")).toBe("search");
    });

    it("falls back to none for anything else", () => {
        expect(normalizeImageMode(undefined)).toBe("none");
        expect(normalizeImageMode("")).toBe("none");
        expect(normalizeImageMode("dall-e")).toBe("none");
        expect(normalizeImageMode("GENERATE")).toBe("none");
    });
});

describe("normalizeImageCount", () => {
    it("keeps values inside 1..3", () => {
        expect(normalizeImageCount(1)).toBe(1);
        expect(normalizeImageCount(2)).toBe(2);
        expect(normalizeImageCount(3)).toBe(3);
    });

    it("clamps out-of-range values", () => {
        expect(normalizeImageCount(0)).toBe(1);
        expect(normalizeImageCount(-2)).toBe(1);
        expect(normalizeImageCount(5)).toBe(3);
        expect(normalizeImageCount(2.7)).toBe(2);
    });

    it("defaults to 2 for non-numbers", () => {
        expect(normalizeImageCount(undefined)).toBe(2);
        expect(normalizeImageCount(Number.NaN)).toBe(2);
        expect(normalizeImageCount("abc")).toBe(2);
    });

    it("accepts numeric strings", () => {
        expect(normalizeImageCount("3")).toBe(3);
    });
});

describe("parsePlannedImages", () => {
    const payload = JSON.stringify([
        { prompt: "a misty mountain at dawn", alt: "晨雾中的山" },
        { prompt: "a river in the valley", alt: "山谷里的河" },
    ]);

    it("parses a plain JSON array", () => {
        const result = parsePlannedImages(payload, 2);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ prompt: "a misty mountain at dawn", alt: "晨雾中的山" });
    });

    it("strips markdown code fences", () => {
        const result = parsePlannedImages(`\`\`\`json\n${payload}\n\`\`\``, 2);
        expect(result).toHaveLength(2);
    });

    it("tolerates surrounding prose", () => {
        const result = parsePlannedImages(`好的，这是计划：\n${payload}\n祝使用愉快`, 2);
        expect(result).toHaveLength(2);
    });

    it("caps the result at the requested count", () => {
        const result = parsePlannedImages(payload, 1);
        expect(result).toHaveLength(1);
    });

    it("drops entries without a prompt", () => {
        const mixed = JSON.stringify([
            { prompt: "", alt: "空的" },
            { prompt: "a lake", alt: "" },
            { alt: "没 prompt" },
        ]);
        const result = parsePlannedImages(mixed, 3);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ prompt: "a lake", alt: "" });
    });

    it("returns [] for invalid input", () => {
        expect(parsePlannedImages(null, 2)).toEqual([]);
        expect(parsePlannedImages("", 2)).toEqual([]);
        expect(parsePlannedImages(JSON.stringify({ prompt: "x" }), 2)).toEqual([]);
    });

    it("treats plain text as keyword candidates (search fallback)", () => {
        expect(parsePlannedImages("not json at all", 2)).toEqual([
            { prompt: "not json at all", alt: "" },
        ]);
    });
});

describe("toImageBytes", () => {
    // 最小的合法 PNG（1x1）和 JPEG 头
    const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

    it("accepts a ReadableStream (Workers AI 图片模型的实际返回)", async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(jpegBytes);
                controller.close();
            },
        });
        const result = await toImageBytes(stream);
        expect(result.bytes).toEqual(jpegBytes);
        expect(result.mime).toBe("image/jpeg");
    });

    it("sniffs PNG from raw bytes", async () => {
        const result = await toImageBytes(pngBytes);
        expect(result.mime).toBe("image/png");
    });

    it("accepts an ArrayBuffer", async () => {
        const result = await toImageBytes(jpegBytes.buffer as ArrayBuffer);
        expect(result.mime).toBe("image/jpeg");
    });

    it("accepts a Response-like object", async () => {
        const result = await toImageBytes(new Response(pngBytes));
        expect(result.mime).toBe("image/png");
    });

    it("accepts a base64 data URL", async () => {
        const b64 = Buffer.from(jpegBytes).toString("base64");
        const result = await toImageBytes(`data:image/jpeg;base64,${b64}`);
        expect(result.mime).toBe("image/jpeg");
        expect(result.bytes).toEqual(jpegBytes);
    });

    it("accepts { image: base64 }", async () => {
        const b64 = Buffer.from(pngBytes).toString("base64");
        const result = await toImageBytes({ image: b64 });
        expect(result.mime).toBe("image/png");
    });

    it("rejects unrecognized shapes", async () => {
        await expect(toImageBytes(null)).rejects.toThrow("无法识别");
        await expect(toImageBytes(42)).rejects.toThrow("无法识别");
        await expect(toImageBytes({ foo: "bar" })).rejects.toThrow("无法识别");
        await expect(toImageBytes("not-base64!!")).rejects.toThrow("无法识别");
    });
});

describe("parsePlannedImages 容错", () => {
    it("accepts a wrapped object", () => {
        const raw = `{"images": [{"prompt": "sunset beach", "alt": "海滩"}]}`;
        expect(parsePlannedImages(raw, 3)).toEqual([{ prompt: "sunset beach", alt: "海滩" }]);
    });

    it("accepts a plain string array", () => {
        const raw = `["sunset beach", "mountain lake"]`;
        const result = parsePlannedImages(raw, 3);
        expect(result.map((r) => r.prompt)).toEqual(["sunset beach", "mountain lake"]);
    });

    it("accepts keyword as field name", () => {
        const raw = `[{"keyword": "city night"}, {"keyword": "forest"}]`;
        expect(parsePlannedImages(raw, 3).map((r) => r.prompt)).toEqual(["city night", "forest"]);
    });

    it("falls back to one-keyword-per-line text", () => {
        const raw = `sunset beach\nocean waves\nmountain lake`;
        expect(parsePlannedImages(raw, 2).map((r) => r.prompt)).toEqual([
            "sunset beach",
            "ocean waves",
        ]);
    });

    it("falls back to numbered lines", () => {
        const raw = `1. sunset beach\n2. ocean waves`;
        expect(parsePlannedImages(raw, 3).map((r) => r.prompt)).toEqual([
            "sunset beach",
            "ocean waves",
        ]);
    });

    it("still rejects empty or non-keyword input", () => {
        expect(parsePlannedImages(null, 3)).toEqual([]);
        expect(parsePlannedImages("   ", 3)).toEqual([]);
        expect(parsePlannedImages(JSON.stringify({ prompt: "x" }), 3)).toEqual([]);
        expect(parsePlannedImages('{"a": 1}', 3)).toEqual([]);
    });
});

describe("salvagePartialPrompts", () => {
    it("rescues a prompt from truncated single-line JSON", () => {
        // 2026-09-26 用户实测：模型返回写到一半被截断
        const raw = `[{"prompt": "Cinematic realistic photograph of a lone upright Ming dynasty official in plain blue robes standing before a grand imperial palace hall, facing a c`;
        const result = salvagePartialPrompts(raw, 2);
        expect(result).toHaveLength(1);
        expect(result[0].prompt).toContain("Ming dynasty official");
        expect(result[0].alt).toBe("");
    });

    it("rescues each prompt from partially truncated JSON", () => {
        const raw = `[{"prompt": "a misty mountain at dawn", "alt": "晨雾"}, {"prompt": "a river in the vall`;
        const result = salvagePartialPrompts(raw, 3);
        expect(result.map((r) => r.prompt)).toEqual([
            "a misty mountain at dawn",
            "a river in the vall",
        ]);
    });

    it("accepts the keyword field name", () => {
        expect(salvagePartialPrompts(`[{"keyword": "city night skyline"`, 2)).toEqual([
            { prompt: "city night skyline", alt: "" },
        ]);
    });

    it("ignores too-short fragments and dedupes", () => {
        const raw = `[{"prompt": "abc"}, {"prompt": "a misty mountain at dawn"}, {"prompt": "a misty mountain at dawn"`;
        expect(salvagePartialPrompts(raw, 3)).toEqual([
            { prompt: "a misty mountain at dawn", alt: "" },
        ]);
    });

    it("caps at count and returns [] for null or prompt-less input", () => {
        const raw = `[{"prompt": "mountain sunrise over the calm lake"}, {"prompt": "forest path in autumn mist"}]`;
        expect(salvagePartialPrompts(raw, 1)).toHaveLength(1);
        expect(salvagePartialPrompts(null, 2)).toEqual([]);
        expect(salvagePartialPrompts("no prompts here", 2)).toEqual([]);
    });
});

describe("planImagesWithRetry", () => {
    const ok = (text: string | null, finishReason: string | null = "stop"): AITextResult => ({
        text,
        finishReason,
    });
    const payload = JSON.stringify([{ prompt: "a misty mountain at dawn", alt: "晨雾" }]);

    function stubGenerate(results: (AITextResult | Error)[]) {
        const calls: number[] = [];
        const generate = async (): Promise<AITextResult> => {
            calls.push(1);
            const next = results[calls.length - 1];
            if (next instanceof Error) throw next;
            if (!next) throw new Error("stub ran out of results");
            return next;
        };
        return { calls, generate };
    }

    it("returns the plan on first success without retrying", async () => {
        const { calls, generate } = stubGenerate([ok(payload)]);
        const { planned, raw } = await planImagesWithRetry(generate, 2);
        expect(planned).toEqual([{ prompt: "a misty mountain at dawn", alt: "晨雾" }]);
        expect(raw).toBe(payload);
        expect(calls).toHaveLength(1);
    });

    it("retries once when the model returns empty", async () => {
        const { calls, generate } = stubGenerate([ok(""), ok(payload)]);
        const { planned } = await planImagesWithRetry(generate, 2);
        expect(planned).toHaveLength(1);
        expect(calls).toHaveLength(2);
    });

    it("retries once when the output is truncated (finish_reason=length)", async () => {
        const truncated = `[{"prompt": "Cinematic realistic photograph of a lone upright Ming dynasty official in plain blue robes standing before a grand imperial palace hall, facing a c`;
        const { calls, generate } = stubGenerate([ok(truncated, "length"), ok(payload)]);
        const { planned } = await planImagesWithRetry(generate, 2);
        expect(planned).toHaveLength(1);
        expect(calls).toHaveLength(2);
    });

    it("salvages a partial prompt when the retry also fails", async () => {
        const truncated = `[{"prompt": "Cinematic realistic photograph of a lone upright Ming dynasty official in plain blue robes standing before a grand imperial palace hall, facing a c`;
        const { calls, generate } = stubGenerate([ok(truncated, "length"), ok("", "stop")]);
        const { planned } = await planImagesWithRetry(generate, 2);
        expect(planned).toHaveLength(1);
        expect(planned[0].prompt).toContain("Ming dynasty official");
        expect(calls).toHaveLength(2);
    });

    it("returns an empty plan when everything fails (caller throws the user-facing error)", async () => {
        const { calls, generate } = stubGenerate([ok(""), ok("   ")]);
        const { planned, raw } = await planImagesWithRetry(generate, 2);
        expect(planned).toEqual([]);
        expect(raw).toBe("   ");
        expect(calls).toHaveLength(2);
    });

    it("does not retry unparseable non-truncated output", async () => {
        const { calls, generate } = stubGenerate([ok("a".repeat(130))]);
        const { planned } = await planImagesWithRetry(generate, 2);
        expect(planned).toEqual([]);
        expect(calls).toHaveLength(1);
    });

    it("propagates generate errors to the caller", async () => {
        const { generate } = stubGenerate([new Error("boom")]);
        await expect(planImagesWithRetry(generate, 2)).rejects.toThrow("boom");
    });
});
