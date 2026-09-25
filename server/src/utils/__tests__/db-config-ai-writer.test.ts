import { describe, expect, it } from "bun:test";
import { getAIWriterConfig, setAIWriterConfig } from "../db-config";

function reader(values: Record<string, unknown>) {
  return { get: async (key: string) => values[key] };
}

function writer(values: Record<string, unknown>) {
  const written: Record<string, unknown> = {};
  return {
    written,
    config: {
      get: async (key: string) => values[key],
      set: async (key: string, value: unknown) => {
        written[key] = value;
      },
      save: async () => {},
    },
  };
}

const summaryValues = {
  "ai_summary.enabled": true,
  "ai_summary.provider": "openai",
  "ai_summary.model": "gpt-4o-mini",
  "ai_summary.api_key": "sk-summary",
  "ai_summary.api_url": "https://api.openai.com/v1",
};

describe("getAIWriterConfig", () => {
  it("inherits provider, model, key and url from ai_summary when blank", async () => {
    const config = await getAIWriterConfig(reader({ ...summaryValues, "ai_writer.enabled": true }));

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.api_key).toBe("sk-summary");
    expect(config.api_url).toBe("https://api.openai.com/v1");
  });

  it("lets a writer-only model override while still inheriting credentials", async () => {
    const config = await getAIWriterConfig(
      reader({ ...summaryValues, "ai_writer.model": "gpt-4o" }),
    );

    expect(config.model).toBe("gpt-4o");
    expect(config.api_key).toBe("sk-summary");
    expect(config.provider).toBe("openai");
  });

  it("treats blank strings as inherit, not as an explicit empty value", async () => {
    const config = await getAIWriterConfig(
      reader({ ...summaryValues, "ai_writer.provider": "", "ai_writer.api_key": "   " }),
    );

    expect(config.provider).toBe("openai");
    expect(config.api_key).toBe("sk-summary");
  });

  it("is disabled by default", async () => {
    const config = await getAIWriterConfig(reader(summaryValues));
    expect(config.enabled).toBe(false);
  });

  it("falls back to tuning defaults and coerces stored strings to numbers", async () => {
    const plain = await getAIWriterConfig(reader(summaryValues));
    expect(plain.temperature).toBe(0.8);
    expect(plain.max_tokens).toBe(4000);

    const stored = await getAIWriterConfig(
      reader({ ...summaryValues, "ai_writer.temperature": "0.5", "ai_writer.max_tokens": "8000" }),
    );
    expect(stored.temperature).toBe(0.5);
    expect(stored.max_tokens).toBe(8000);
  });

  it("ignores non-numeric tuning values rather than producing NaN", async () => {
    const config = await getAIWriterConfig(
      reader({ ...summaryValues, "ai_writer.temperature": "hot", "ai_writer.max_tokens": "" }),
    );

    expect(config.temperature).toBe(0.8);
    expect(config.max_tokens).toBe(4000);
  });

  it("reads the standalone pexels key (no inheritance from ai_summary)", async () => {
    const config = await getAIWriterConfig(
      reader({ ...summaryValues, "ai_writer.pexels_api_key": "px-123" }),
    );
    expect(config.pexels_api_key).toBe("px-123");

    const blank = await getAIWriterConfig(reader(summaryValues));
    expect(blank.pexels_api_key).toBe("");
  });

  it("skips a blank pexels key so a re-saved form cannot erase the stored one", async () => {
    const { written, config } = writer(summaryValues);

    await setAIWriterConfig(config, { pexels_api_key: "   " });

    expect(written["ai_writer.pexels_api_key"]).toBeUndefined();
  });
});

describe("setAIWriterConfig", () => {
  it("skips a blank api_key so a re-saved form cannot erase the stored one", async () => {
    const { written, config } = writer(summaryValues);

    await setAIWriterConfig(config, { api_key: "   ", model: "gpt-4o" });

    expect(written["ai_writer.api_key"]).toBeUndefined();
    expect(written["ai_writer.model"]).toBe("gpt-4o");
  });

  it("writes a non-blank api_key", async () => {
    const { written, config } = writer(summaryValues);

    await setAIWriterConfig(config, { api_key: "sk-writer" });

    expect(written["ai_writer.api_key"]).toBe("sk-writer");
  });

  it("ignores fields that were not supplied", async () => {
    const { written, config } = writer(summaryValues);

    await setAIWriterConfig(config, { enabled: true });

    expect(written["ai_writer.enabled"]).toBe(true);
    expect(Object.keys(written)).toEqual(["ai_writer.enabled"]);
  });
});
