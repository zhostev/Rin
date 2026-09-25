import { describe, expect, it } from "bun:test";
import {
    normalizeImageCount,
    normalizeImageMode,
    parsePlannedImages,
} from "../ai-images";

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
        expect(parsePlannedImages("not json at all", 2)).toEqual([]);
        expect(parsePlannedImages(JSON.stringify({ prompt: "x" }), 2)).toEqual([]);
    });
});
