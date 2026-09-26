import { describe, expect, it } from "bun:test";
import {
    buildReviseUserMessage,
    describeEmptyReviseResult,
    estimateReviseMaxTokens,
    normalizeReviseMode,
} from "../feed-ai-revise";

describe("normalizeReviseMode", () => {
    it("accepts the five known modes", () => {
        for (const mode of ["polish", "expand", "shorten", "proofread", "custom"] as const) {
            expect(normalizeReviseMode(mode)).toBe(mode);
        }
    });

    it("rejects anything else", () => {
        expect(normalizeReviseMode("rewrite")).toBeNull();
        expect(normalizeReviseMode(undefined)).toBeNull();
        expect(normalizeReviseMode(42)).toBeNull();
    });
});

describe("buildReviseUserMessage", () => {
    const content = "原文正文";

    it("uses the preset task for polish", () => {
        const message = buildReviseUserMessage({ mode: "polish", content });
        expect(message).toContain("润色");
        expect(message).toContain(content);
    });

    it("appends the extra instruction for preset modes", () => {
        const message = buildReviseUserMessage({
            mode: "shorten",
            instruction: "保留小标题",
            content,
        });
        expect(message).toContain("精简");
        expect(message).toContain("额外要求：保留小标题");
    });

    it("uses the custom instruction verbatim for custom mode", () => {
        const message = buildReviseUserMessage({
            mode: "custom",
            instruction: "改成鲁迅的风格",
            content,
        });
        expect(message).toContain("任务：改成鲁迅的风格");
    });
});

describe("estimateReviseMaxTokens", () => {
    it("scales with content length", () => {
        const small = estimateReviseMaxTokens("a".repeat(100));
        const large = estimateReviseMaxTokens("a".repeat(10000));
        expect(large).toBeGreaterThan(small);
        expect(small).toBeGreaterThan(500);
    });
});

describe("describeEmptyReviseResult", () => {
    it("calls out reasoning-only output from thinker models", () => {
        const message = describeEmptyReviseResult({
            finishReason: "stop",
            reasoningContent: "思考过程…",
        });
        expect(message).toContain("reasoning");
    });

    it("calls out content-filter blocks", () => {
        const message = describeEmptyReviseResult({
            finishReason: "content_filter",
            reasoningContent: null,
        });
        expect(message).toContain("content filter");
    });

    it("attaches the finish_reason for unknown empty responses", () => {
        expect(
            describeEmptyReviseResult({ finishReason: "length", reasoningContent: null }),
        ).toContain("finish_reason: length");
        expect(
            describeEmptyReviseResult({ finishReason: null, reasoningContent: null }),
        ).toBe("AI returned empty result. Please retry.");
    });
});
