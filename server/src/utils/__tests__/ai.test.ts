import { afterEach, describe, expect, it } from "bun:test";
import {
    buildExternalAIChatCompletionsUrl,
    generateAIText,
    normalizeExternalAIBaseUrl,
} from "../ai";

describe("normalizeExternalAIBaseUrl", () => {
    it("removes trailing slash", () => {
        expect(normalizeExternalAIBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    });

    it("removes chat completions suffix", () => {
        expect(normalizeExternalAIBaseUrl("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
    });

    it("removes chat completions suffix after trimming", () => {
        expect(normalizeExternalAIBaseUrl(" https://api.openai.com/v1/chat/completions/ ")).toBe("https://api.openai.com/v1");
    });
});

describe("buildExternalAIChatCompletionsUrl", () => {
    it("builds standard chat completions URL from base URL", () => {
        expect(buildExternalAIChatCompletionsUrl("openai", "https://api.openai.com/v1")).toBe(
            "https://api.openai.com/v1/chat/completions",
        );
    });

    it("normalizes full chat completions URL before rebuilding", () => {
        expect(buildExternalAIChatCompletionsUrl("openai", "https://api.openai.com/v1/chat/completions")).toBe(
            "https://api.openai.com/v1/chat/completions",
        );
    });

    it("falls back to provider preset when api URL is empty", () => {
        expect(buildExternalAIChatCompletionsUrl("openai", "")).toBe(
            "https://api.openai.com/v1/chat/completions",
        );
    });
});

describe("generateAIText", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function captureExternalRequest(responseText: string) {
    const captured: { body?: any } = {};
    globalThis.fetch = (async (_url: any, init: any) => {
      captured.body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: responseText } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    return captured;
  }

  const externalConfig = {
    provider: "openai",
    model: "gpt-4o-mini",
    api_key: "sk-test",
    api_url: "https://api.openai.com/v1",
  };

  it("defaults to the summary tuning when no options are given", async () => {
    const captured = captureExternalRequest("ok");

    await generateAIText({} as Env, externalConfig, [{ role: "user", content: "hi" }]);

    expect(captured.body.max_tokens).toBe(500);
    expect(captured.body.temperature).toBe(0.3);
  });

  it("forwards explicit generation options", async () => {
    const captured = captureExternalRequest("ok");

    await generateAIText({} as Env, externalConfig, [{ role: "user", content: "hi" }], {
      maxTokens: 4000,
      temperature: 0.8,
    });

    expect(captured.body.max_tokens).toBe(4000);
    expect(captured.body.temperature).toBe(0.8);
  });

  it("routes worker-ai through the AI binding with the full model id", async () => {
    const calls: Array<{ model: string; input: any }> = [];
    const env = {
      AI: {
        run: async (model: string, input: any) => {
          calls.push({ model, input });
          return { response: "worker ok" };
        },
      },
    } as unknown as Env;

    const result = await generateAIText(
      env,
      { provider: "worker-ai", model: "llama-3-8b", api_key: "", api_url: "" },
      [{ role: "user", content: "hi" }],
      { maxTokens: 4000 },
    );

    expect(result).toBe("worker ok");
    expect(calls[0]?.model).toBe("@cf/meta/llama-3-8b-instruct");
    expect(calls[0]?.input.max_tokens).toBe(4000);
  });
});
