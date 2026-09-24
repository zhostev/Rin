import { describe, it, expect } from "bun:test";
import {
    buildNoCoverageAnswer,
    checkAskRateLimit,
    decideCoverage,
    isFinancePolicyTopic,
    normalizeAskMode,
    type RetrievalMatch,
} from "../ask";

function match(score: number, title = "t", text = "x"): RetrievalMatch {
    return {
        score,
        chunk: {
            id: "s1b1c0",
            storyId: 1,
            storySlug: "s",
            title,
            blockId: 1,
            kind: "block",
            text,
            url: "/story/s",
        },
    };
}

describe("normalizeAskMode", () => {
    it("defaults to quick", () => {
        expect(normalizeAskMode(undefined)).toBe("quick");
        expect(normalizeAskMode("full")).toBe("full");
        expect(normalizeAskMode("weird")).toBe("quick");
    });
});

describe("decideCoverage", () => {
    it("none when no matches", () => {
        expect(decideCoverage([])).toBe("none");
    });
    it("partial for 1-2 matches", () => {
        expect(decideCoverage([match(0.9)])).toBe("partial");
        expect(decideCoverage([match(0.9), match(0.8)])).toBe("partial");
    });
    it("full for 3+ matches", () => {
        expect(decideCoverage([match(0.9), match(0.8), match(0.7)])).toBe("full");
    });
});

describe("buildNoCoverageAnswer", () => {
    it("always contains 本站没有覆盖", () => {
        expect(buildNoCoverageAnswer("量子计算")).toContain("本站没有覆盖");
    });
});

describe("isFinancePolicyTopic", () => {
    it("detects finance keywords in the question", () => {
        expect(isFinancePolicyTopic("如何用人民币支付 Claude 账单？", [])).toBe(true);
        expect(isFinancePolicyTopic("签证政策有什么变化？", [])).toBe(true);
    });
    it("detects finance keywords in matched chunks", () => {
        expect(isFinancePolicyTopic("怎么付款", [match(0.9, "支付", "银行卡手续费")])).toBe(true);
    });
    it("returns false for unrelated topics", () => {
        expect(isFinancePolicyTopic("今天天气怎么样", [match(0.9, "游记", "爬山")])).toBe(false);
    });
});

describe("checkAskRateLimit", () => {
    it("allows up to the limit then blocks", () => {
        const buckets = new Map<string, number[]>();
        const now = 1_000_000;
        for (let i = 0; i < 20; i++) {
            expect(checkAskRateLimit(buckets, "k", now + i)).toBe(true);
        }
        expect(checkAskRateLimit(buckets, "k", now + 21)).toBe(false);
    });

    it("slides the window", () => {
        const buckets = new Map<string, number[]>();
        const now = 1_000_000;
        for (let i = 0; i < 20; i++) {
            checkAskRateLimit(buckets, "k", now);
        }
        expect(checkAskRateLimit(buckets, "k", now)).toBe(false);
        // 10 分钟窗口过去后恢复
        expect(checkAskRateLimit(buckets, "k", now + 10 * 60 * 1000 + 1)).toBe(true);
    });

    it("tracks keys independently", () => {
        const buckets = new Map<string, number[]>();
        const now = 1_000_000;
        for (let i = 0; i < 20; i++) checkAskRateLimit(buckets, "a", now);
        expect(checkAskRateLimit(buckets, "a", now)).toBe(false);
        expect(checkAskRateLimit(buckets, "b", now)).toBe(true);
    });
});
