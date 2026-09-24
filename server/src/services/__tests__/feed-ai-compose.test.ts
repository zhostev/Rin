import { describe, expect, it } from "bun:test";
import { decideComposeOutcome, normalizeComposeLength } from "../feed-ai-compose";

const goodBody = "正".repeat(200);
const goodRaw = ["---", "title: 标题", "summary: 摘要", "tags: a, b", "---", "", goodBody].join("\n");

describe("normalizeComposeLength", () => {
  it("accepts the three known values", () => {
    expect(normalizeComposeLength("short")).toBe("short");
    expect(normalizeComposeLength("medium")).toBe("medium");
    expect(normalizeComposeLength("long")).toBe("long");
  });

  it("falls back to medium for anything else", () => {
    expect(normalizeComposeLength("enormous")).toBe("medium");
    expect(normalizeComposeLength(undefined)).toBe("medium");
    expect(normalizeComposeLength(42)).toBe("medium");
  });
});

describe("decideComposeOutcome", () => {
  it("publishes a well-formed article", () => {
    const outcome = decideComposeOutcome({ raw: goodRaw });

    if (outcome.kind !== "published") throw new Error("expected publication");
    expect(outcome.article.title).toBe("标题");
    expect(outcome.article.tags).toEqual(["a", "b"]);
  });

  it("fails when the provider errored", () => {
    const outcome = decideComposeOutcome({ raw: null, error: "API error 401" });

    if (outcome.kind !== "failed") throw new Error("expected failure");
    expect(outcome.error).toContain("401");
  });

  it("fails on an empty response", () => {
    expect(decideComposeOutcome({ raw: "   " }).kind).toBe("failed");
  });

  it("fails when the gate rejects the parsed article", () => {
    const outcome = decideComposeOutcome({ raw: "---\ntitle: T\n---\n\n太短" });

    if (outcome.kind !== "failed") throw new Error("expected failure");
    expect(outcome.error.length).toBeGreaterThan(0);
  });

  it("strips reasoning tags before parsing", () => {
    const outcome = decideComposeOutcome({ raw: `<think>我先想想</think>\n${goodRaw}` });

    if (outcome.kind !== "published") throw new Error("expected publication");
    expect(outcome.article.title).toBe("标题");
    expect(outcome.article.content).not.toContain("我先想想");
  });

  it("fails when the response is only reasoning", () => {
    expect(decideComposeOutcome({ raw: "<think>只有思考</think>" }).kind).toBe("failed");
  });
});
