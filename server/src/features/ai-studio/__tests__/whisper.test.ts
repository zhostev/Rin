import { describe, it, expect } from "bun:test";
import { groupWordsIntoSegments, planTruncation } from "../whisper";

describe("planTruncation", () => {
    const data = new Uint8Array(100_000);

    it("keeps everything when audio is short", () => {
        const { bytes, truncated } = planTruncation(data, 60, 10);
        expect(bytes.length).toBe(100_000);
        expect(truncated).toBe(false);
    });

    it("truncates proportionally to maxMinutes", () => {
        // 20 分钟音频，maxMinutes=10 → 保留一半
        const { bytes, truncated } = planTruncation(data, 1200, 10);
        expect(bytes.length).toBe(50_000);
        expect(truncated).toBe(true);
    });

    it("does not truncate on unknown duration (only hard cap applies)", () => {
        const { bytes, truncated } = planTruncation(data, null, 10);
        expect(bytes.length).toBe(100_000);
        expect(truncated).toBe(false);
    });

    it("applies the hard byte cap", () => {
        const big = new Uint8Array(30 * 1024 * 1024);
        const { bytes, truncated } = planTruncation(big, null, 10, 25 * 1024 * 1024);
        expect(bytes.length).toBe(25 * 1024 * 1024);
        expect(truncated).toBe(true);
    });
});

describe("groupWordsIntoSegments", () => {
    it("groups words into sentence segments at punctuation", () => {
        const segments = groupWordsIntoSegments([
            { word: "你好", start: 0, end: 0.5 },
            { word: "世界。", start: 0.5, end: 1.0 },
            { word: "今天", start: 1.0, end: 1.5 },
            { word: "很好。", start: 1.5, end: 2.0 },
        ]);
        expect(segments).toEqual([
            { start: 0, end: 1.0, text: "你好世界。" },
            { start: 1.0, end: 2.0, text: "今天很好。" },
        ]);
    });

    it("breaks on long pauses", () => {
        const segments = groupWordsIntoSegments([
            { word: "前半", start: 0, end: 0.5 },
            { word: "后半", start: 5.0, end: 5.5 },
        ]);
        expect(segments.length).toBe(2);
        expect(segments[0]).toEqual({ start: 0, end: 0.5, text: "前半" });
    });

    it("returns empty for no words", () => {
        expect(groupWordsIntoSegments([])).toEqual([]);
    });
});
