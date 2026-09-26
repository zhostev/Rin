import { describe, expect, it } from "bun:test";
import {
  decideComposeOutcome,
  generateArticleWithContinuation,
  normalizeComposeLength,
  stripLeadingFrontMatter,
} from "../feed-ai-compose";
import type { AIChatMessage, AITextResult } from "../../utils/ai";

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

describe("stripLeadingFrontMatter", () => {
  it("removes a front-matter block at the start of a continuation chunk", () => {
    const chunk = "---\ntitle: 重复的标题\nsummary: x\n---\n\n续写正文。";
    expect(stripLeadingFrontMatter(chunk)).toBe("\n续写正文。");
  });

  it("leaves chunks without front-matter untouched", () => {
    expect(stripLeadingFrontMatter("直接续写正文。")).toBe("直接续写正文。");
  });

  it("leaves an unterminated --- block untouched", () => {
    expect(stripLeadingFrontMatter("---\n只有开头没有结尾")).toBe("---\n只有开头没有结尾");
  });
});

describe("generateArticleWithContinuation", () => {
  const baseMessages: AIChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "写一篇文章" },
  ];

  function stubGenerate(results: AITextResult[] | Error) {
    const calls: AIChatMessage[][] = [];
    const generate = async (messages: AIChatMessage[]): Promise<AITextResult> => {
      calls.push(messages);
      const next = Array.isArray(results) ? results[calls.length - 1] : results;
      if (next instanceof Error) throw next;
      if (!next) throw new Error("stub ran out of results");
      return next;
    };
    return { calls, generate };
  }

  it("returns the text as-is when the model stops normally", async () => {
    const { calls, generate } = stubGenerate([{ text: "完整文章。", finishReason: "stop" }]);

    const out = await generateArticleWithContinuation(baseMessages, generate);

    expect(out.raw).toBe("完整文章。");
    expect(out.truncated).toBe(false);
    expect(out.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(baseMessages);
  });

  it("continues once after a length truncation and joins the chunks", async () => {
    const { calls, generate } = stubGenerate([
      { text: "第一段没写完，", finishReason: "length" },
      { text: "第二段写完了。", finishReason: "stop" },
    ]);

    const out = await generateArticleWithContinuation(baseMessages, generate);

    expect(out.raw).toBe("第一段没写完，第二段写完了。");
    expect(out.truncated).toBe(false);
    expect(calls).toHaveLength(2);
    // 第二次调用带上已生成内容 + 续写指令
    const retry = calls[1]!;
    expect(retry[2]).toEqual({ role: "assistant", content: "第一段没写完，" });
    expect(retry[3]?.role).toBe("user");
    expect(retry[3]?.content).toContain("继续");
  });

  it("reports truncated when every attempt hits the length limit", async () => {
    const { calls, generate } = stubGenerate([
      { text: "a", finishReason: "length" },
      { text: "b", finishReason: "length" },
      { text: "c", finishReason: "length" },
    ]);

    const out = await generateArticleWithContinuation(baseMessages, generate, 2);

    expect(out.truncated).toBe(true);
    expect(out.raw).toBe("abc");
    expect(calls).toHaveLength(3);
  });

  it("does not retry when finishReason is missing (e.g. Workers AI)", async () => {
    const { calls, generate } = stubGenerate([{ text: "半句", finishReason: null }]);

    const out = await generateArticleWithContinuation(baseMessages, generate);

    expect(out.truncated).toBe(false);
    expect(out.raw).toBe("半句");
    expect(calls).toHaveLength(1);
  });

  it("strips a repeated front-matter block from the continuation chunk", async () => {
    const { generate } = stubGenerate([
      { text: "---\ntitle: T\n---\n\n开头", finishReason: "length" },
      { text: "---\ntitle: T\n---\n\n结尾", finishReason: "stop" },
    ]);

    const out = await generateArticleWithContinuation(baseMessages, generate);

    expect(out.raw).toBe("---\ntitle: T\n---\n\n开头\n结尾");
    expect(out.truncated).toBe(false);
  });

  it("drops image parts when retrying a vision request", async () => {
    const visionBase: AIChatMessage[] = [
      { role: "system", content: "system" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "text", text: "看图写话" },
        ],
      },
    ];
    const { calls, generate } = stubGenerate([
      { text: "第一段，", finishReason: "length" },
      { text: "第二段。", finishReason: "stop" },
    ]);

    await generateArticleWithContinuation(visionBase, generate);

    const retryUser = calls[1]![1]!;
    expect(typeof retryUser.content).toBe("string");
    expect(retryUser.content).not.toContain("base64,AAA");
    expect(retryUser.content).toContain("看图写话");
  });

  it("surfaces provider errors without marking truncated", async () => {
    const { generate } = stubGenerate(new Error("API error 500"));

    const out = await generateArticleWithContinuation(baseMessages, generate);

    expect(out.error).toContain("500");
    expect(out.truncated).toBe(false);
    expect(out.raw).toBeNull();
  });
});
