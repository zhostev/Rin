import { describe, expect, it } from "bun:test";
import {
    STORY_AI_COMPOSE_SYSTEM_PROMPT,
    buildStoryComposeUserMessage,
    normalizeStoryComposeLength,
} from "../story-ai";

describe("normalizeStoryComposeLength", () => {
    it("keeps known lengths and defaults unknown values to medium", () => {
        expect(normalizeStoryComposeLength("short")).toBe("short");
        expect(normalizeStoryComposeLength("long")).toBe("long");
        expect(normalizeStoryComposeLength("huge")).toBe("medium");
        expect(normalizeStoryComposeLength(undefined)).toBe("medium");
    });
});

describe("STORY_AI_COMPOSE_SYSTEM_PROMPT", () => {
    it("asks for body-only markdown, not a front-matter article", () => {
        expect(STORY_AI_COMPOSE_SYSTEM_PROMPT).toContain("front-matter");
        expect(STORY_AI_COMPOSE_SYSTEM_PROMPT).toContain("只输出正文");
    });
});

describe("buildStoryComposeUserMessage", () => {
    it("includes topic, length range and style", () => {
        const message = buildStoryComposeUserMessage({
            topic: "山海骑行",
            style: "冷静克制",
            length: "medium",
        });
        expect(message).toContain("选题：山海骑行");
        expect(message).toContain("风格：冷静克制");
        expect(message).toContain("1200");
    });

    it("appends source material when given, and omits the section when absent", () => {
        const withSource = buildStoryComposeUserMessage({
            topic: "山海骑行",
            length: "short",
            sourceText: "早上在会场集合",
        });
        expect(withSource).toContain("早上在会场集合");
        const withoutSource = buildStoryComposeUserMessage({
            topic: "山海骑行",
            length: "short",
        });
        expect(withoutSource).not.toContain("已有素材");
    });
});
