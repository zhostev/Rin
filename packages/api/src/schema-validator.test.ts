import { describe, expect, it } from "bun:test";
import { t, validateSchema } from "./schema-validator";
import { feedAIComposeSchema, feedAIReviseSchema } from "./schemas";

describe('validateSchema', () => {
  it('validates nested objects, arrays, optionals, and date-times', () => {
    const schema = t.Object({
      title: t.String(),
      publishedAt: t.Date({ optional: true }),
      tags: t.Array(t.String()),
    }, { additionalProperties: false });

    expect(validateSchema(schema, {
      title: 'Rin',
      publishedAt: '2026-08-19T00:00:00.000Z',
      tags: ['architecture'],
    }).success).toBe(true);

    const invalid = validateSchema(schema, {
      title: 1,
      publishedAt: 'not-a-date',
      tags: ['architecture', 2],
      extra: true,
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.issues.map((issue) => issue.path)).toEqual([
        'title',
        'publishedAt',
        'tags[1]',
        'extra',
      ]);
    }
  });

  it('distinguishes finite numbers and integers', () => {
    expect(validateSchema(t.Number(), Number.NaN).success).toBe(false);
    expect(validateSchema(t.Integer(), 1.5).success).toBe(false);
    expect(validateSchema(t.Integer(), 2).success).toBe(true);
  });

  it('supports non-empty string contracts', () => {
    expect(validateSchema(t.String({ minLength: 1 }), '').success).toBe(false);
    expect(validateSchema(t.String({ minLength: 1 }), 'Rin').success).toBe(true);
  });
});

describe("feedAIComposeSchema", () => {
  it("accepts a minimal request", () => {
    const result = validateSchema(feedAIComposeSchema, {
      topic: "聊聊本地优先软件",
      assets: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts assets with notes and optional fields", () => {
    const result = validateSchema(feedAIComposeSchema, {
      topic: "聊聊本地优先软件",
      assets: [{ id: "abc-123", note: "架构示意图" }],
      length: "long",
      style: "冷静克制",
      listed: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty topic", () => {
    const result = validateSchema(feedAIComposeSchema, { topic: "", assets: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]?.path).toBe("topic");
    }
  });

  it("rejects an asset without an id", () => {
    const result = validateSchema(feedAIComposeSchema, {
      topic: "选题",
      assets: [{ note: "缺少 id" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("feedAIReviseSchema", () => {
  it("accepts a mode-only request", () => {
    const result = validateSchema(feedAIReviseSchema, { mode: "polish" });
    expect(result.success).toBe(true);
  });

  it("accepts a custom request with instruction", () => {
    const result = validateSchema(feedAIReviseSchema, {
      mode: "custom",
      instruction: "把口语化的地方改正式一点",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty mode", () => {
    const result = validateSchema(feedAIReviseSchema, { mode: "" });
    expect(result.success).toBe(false);
  });
});
