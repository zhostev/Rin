import { getAIConfig } from "./db-config";

type ConfigReader = {
    get(key: string): Promise<unknown>;
};

// AI Provider presets with their default API URLs
const AI_PROVIDER_URLS: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    claude: "https://api.anthropic.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    deepseek: "https://api.deepseek.com/v1",
};

// Cloudflare Worker AI models mapping (short name -> full model ID)
export const WORKER_AI_MODELS: Record<string, string> = {
    "llama-3-8b": "@cf/meta/llama-3-8b-instruct",
    "llama-3-1-8b-fp8": "@cf/meta/llama-3.1-8b-instruct-fp8",
    "llama-2-7b": "@cf/meta/llama-2-7b-chat-int8",
    "mistral-7b": "@cf/mistral/mistral-7b-instruct-v0.1",
    "mistral-7b-v2": "@cf/mistral/mistral-7b-instruct-v0.2-lora",
    "gemma-2b": "@cf/google/gemma-2b-it-lora",
    "gemma-7b": "@cf/google/gemma-7b-it-lora",
    "deepseek-coder": "@cf/deepseek-ai/deepseek-coder-6.7b-base-awq",
    "qwen-7b": "@cf/qwen/qwen1.5-7b-chat-awq",
    // Stage 4 · AI Studio：语音转写与文本向量（embedding 维度 768，对齐
    // Vectorize index s7ea-qa-staging）。
    "whisper": "@cf/openai/whisper",
    "bge-base-en": "@cf/baai/bge-base-en-v1.5",
    // 读图（截图生文）：llama-3.2 视觉指令模型，支持 OpenAI 式 vision 消息。
    "llama-3.2-11b-vision": "@cf/meta/llama-3.2-11b-vision-instruct",
};

/** worker-ai 渠道读图时的默认视觉模型（vision_model 为空时使用）。 */
export const DEFAULT_WORKER_AI_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export type AIGenerationOptions = {
    maxTokens?: number;
    temperature?: number;
};

/** OpenAI 兼容的视觉消息内容块：文本或图片（data URL / http(s) URL）。 */
export type AIVisionContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export type AIChatMessage = {
    role: "system" | "user" | "assistant";
    content: string | AIVisionContentPart[];
};

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_TEMPERATURE = 0.3;

/** 文本生成的结构化结果：正文 + 模型返回的 finish_reason。 */
export interface AITextResult {
    /** 生成的文本；空响应时为 null。 */
    text: string | null;
    /** 如 "stop" / "length"；拿不到时为 null。"length" 表示输出被截断。 */
    finishReason: string | null;
    /** 推理模型的思考过程（DeepSeek 系的 reasoning_content）；没有时为 null。 */
    reasoningContent: string | null;
}

export const AI_SUMMARY_SYSTEM_PROMPT =
    "你是一个中文内容摘要助手。请用简洁、准确、自然的中文总结用户提供的内容，不超过200字，不要添加原文没有的信息，不要输出标题或项目符号。";

/**
 * Get full Worker AI model ID from short name
 */
export function getWorkerAIModelId(shortName: string): string {
    return WORKER_AI_MODELS[shortName] || shortName;
}

export function normalizeExternalAIBaseUrl(apiUrl: string): string {
    return apiUrl
        .trim()
        .replace(/\/+$/g, "")
        .replace(/\/chat\/completions$/i, "");
}

export function buildExternalAIChatCompletionsUrl(
    provider: string,
    apiUrl: string,
): string {
    const normalizedApiUrl = normalizeExternalAIBaseUrl(apiUrl || AI_PROVIDER_URLS[provider] || "");
    if (!normalizedApiUrl) {
        throw new Error("API URL not configured");
    }

    return `${normalizedApiUrl}/chat/completions`;
}

export function extractAIText(response: unknown): string | null {
    if (typeof response === "string") {
        return response;
    }

    if (!response || typeof response !== "object") {
        return null;
    }

    const responseObj = response as Record<string, any>;

    if (typeof responseObj.response === "string") return responseObj.response;
    if (typeof responseObj.content === "string") return responseObj.content;
    if (typeof responseObj.output === "string") return responseObj.output;
    if (typeof responseObj.result === "string") return responseObj.result;

    const messageContent = responseObj.choices?.[0]?.message?.content;
    if (typeof messageContent === "string" && messageContent.trim()) {
        return messageContent.trim();
    }

    const outputText = responseObj.output?.[0]?.content?.[0]?.text;
    if (typeof outputText === "string" && outputText.trim()) {
        return outputText.trim();
    }

    return null;
}

/**
 * Best-effort extraction of the reasoning trace from a chat-completion
 * response. Reasoning models (e.g. DeepSeek's thinker variants) expose it at
 * choices[0].message.reasoning_content; it is null when the provider folds
 * everything into content or doesn't think out loud.
 */
export function extractReasoningContent(response: unknown): string | null {
    if (!response || typeof response !== "object") return null;
    const content = (response as Record<string, any>).choices?.[0]?.message?.reasoning_content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
}

/**
 * Best-effort extraction of the finish reason from a chat-completion response.
 * OpenAI-compatible providers put it at choices[0].finish_reason.
 * Workers AI binding responses generally don't carry one → null.
 */
export function extractFinishReason(response: unknown): string | null {
    if (!response || typeof response !== "object") return null;
    const reason = (response as Record<string, any>).choices?.[0]?.finish_reason;
    return typeof reason === "string" && reason.length > 0 ? reason : null;
}

/**
 * Execute Worker AI request
 */
async function executeWorkerAI(
    env: Env,
    modelId: string,
    messages: AIChatMessage[],
    options?: AIGenerationOptions,
): Promise<AITextResult> {
    if (!env.AI || typeof env.AI.run !== "function") {
        throw new Error("Workers AI binding is not configured");
    }

    const response = await env.AI.run(modelId as any, {
        messages,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
    } as any);

    return {
        text: extractAIText(response),
        finishReason: extractFinishReason(response),
        reasoningContent: extractReasoningContent(response),
    };
}

/**
 * Run a Workers AI model with a raw (non-chat) input and return the raw
 * response. Used by Stage 4 AI Studio for whisper (audio) and embeddings,
 * whose input/output shapes are not chat messages.
 *
 * Short model names from WORKER_AI_MODELS are accepted ("whisper",
 * "bge-base-en"); full "@cf/…" IDs pass through unchanged.
 */
export async function runWorkerAIModel(
    env: Env,
    model: string,
    input: unknown,
): Promise<unknown> {
    if (!env.AI || typeof env.AI.run !== "function") {
        throw new Error("Workers AI binding is not configured");
    }

    return env.AI.run(getWorkerAIModelId(model) as any, input as any);
}

/**
 * Best-effort extraction of token usage from a Workers AI raw response.
 * Chat models may return { usage: { prompt_tokens, completion_tokens } };
 * whisper/embeddings do not — callers record 0 in that case.
 */
export function extractAIUsage(response: unknown): { tokensIn: number; tokensOut: number } {
    if (!response || typeof response !== "object") {
        return { tokensIn: 0, tokensOut: 0 };
    }
    const usage = (response as Record<string, any>).usage;
    if (!usage || typeof usage !== "object") {
        return { tokensIn: 0, tokensOut: 0 };
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
    return {
        tokensIn: num(usage.prompt_tokens ?? usage.input_tokens),
        tokensOut: num(usage.completion_tokens ?? usage.output_tokens),
    };
}

/**
 * Execute external AI API request
 */
async function executeExternalAI(
    config: {
        provider: string;
        model: string;
        api_key: string;
        api_url: string;
    },
    messages: AIChatMessage[],
    options?: AIGenerationOptions,
): Promise<AITextResult> {
    const { provider, model, api_key, api_url } = config;

    if (!api_key) {
        throw new Error("API key not configured");
    }

    const finalApiUrl = buildExternalAIChatCompletionsUrl(provider, api_url);

    const response = await fetch(finalApiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${api_key}`,
        },
        body: JSON.stringify({
            model: model,
            messages,
            max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as any;
    return {
        text: data.choices?.[0]?.message?.content?.trim() || null,
        finishReason: extractFinishReason(data),
        reasoningContent: extractReasoningContent(data),
    };
}

/**
 * Single entry point for text generation, hiding the worker-ai vs external
 * API split from callers.
 */
export async function generateAIText(
    env: Env,
    config: {
        provider: string;
        model: string;
        api_key: string;
        api_url: string;
    },
    messages: AIChatMessage[],
    options?: AIGenerationOptions,
): Promise<AITextResult> {
    if (config.provider === 'worker-ai') {
        return executeWorkerAI(env, getWorkerAIModelId(config.model), messages, options);
    }

    return executeExternalAI(config, messages, options);
}

/**
 * 读图时实际使用的模型：
 * - worker-ai：用 vision_model 配置，空则用内置默认视觉模型（文本模型看不懂图）；
 * - 外部渠道：沿用配置的 model（OpenAI 兼容接口多为同一模型支持视觉）。
 */
export function resolveVisionModel(config: {
    provider: string;
    model: string;
    vision_model?: string;
}): string {
    if (config.provider === "worker-ai") {
        return config.vision_model?.trim() || DEFAULT_WORKER_AI_VISION_MODEL;
    }
    return config.model;
}

/**
 * 带图片输入的文本生成：截图生文用。消息 content 可混排文本块与
 * image_url 块（data URL），worker-ai 与外部渠道都走 OpenAI 兼容格式。
 */
export async function generateAITextWithVision(
    env: Env,
    config: {
        provider: string;
        model: string;
        api_key: string;
        api_url: string;
        vision_model?: string;
    },
    messages: AIChatMessage[],
    options?: AIGenerationOptions,
): Promise<AITextResult> {
    const model = resolveVisionModel(config);
    if (config.provider === 'worker-ai') {
        return executeWorkerAI(env, getWorkerAIModelId(model), messages, options);
    }

    return executeExternalAI({ ...config, model }, messages, options);
}

/**
 * Test AI model configuration
 */
export async function testAIModel(
    env: Env,
    config: {
        provider: string;
        model: string;
        api_key?: string;
        api_url?: string;
    },
    testPrompt: string
): Promise<{ success: boolean; response?: string; error?: string; details?: string }> {
    try {
        if (config.provider === 'worker-ai') {
            const fullModelName = getWorkerAIModelId(config.model);
            console.log(`[Test AI] Using Worker AI model: ${fullModelName}`);
        }

        const result = await generateAIText(env, {
            provider: config.provider,
            model: config.model,
            api_key: config.api_key || '',
            api_url: config.api_url || '',
        }, [
            { role: "user", content: testPrompt },
        ]);

        if (result.text) {
            return {
                success: true,
                response: result.text,
            };
        } else {
            return {
                success: false,
                error: 'Empty response from AI'
            };
        }
    } catch (error: any) {
        return processAIError(error, config.model, config.provider);
    }
}

/**
 * Generate AI summary for article content
 */
export async function generateAISummary(
    env: Env, 
    serverConfig: ConfigReader,
    content: string
): Promise<string | null> {
    const result = await generateAISummaryResult(env, serverConfig, content);
    return result.summary;
}

export async function generateAISummaryResult(
    env: Env,
    serverConfig: ConfigReader,
    content: string
): Promise<{ summary: string | null; skipped: boolean; error?: string }> {
    const config = await getAIConfig(serverConfig);

    if (!config.enabled) {
        return { summary: null, skipped: true };
    }

    const { provider, model } = config;
    const maxContentLength = 8000;
    const truncatedContent = content.length > maxContentLength
        ? content.slice(0, maxContentLength) + "..."
        : content;
    const summaryMessages = [
        { role: "system" as const, content: AI_SUMMARY_SYSTEM_PROMPT },
        { role: "user" as const, content: truncatedContent },
    ];

    try {
        const result = await generateAIText(env, config, summaryMessages);

        if (!result.text || !result.text.trim()) {
            return {
                summary: null,
                skipped: false,
                error: `Empty response from AI provider "${provider}" using model "${model}"`,
            };
        }

        const cleaned = stripReasoningTags(result.text);
        if (!cleaned.trim()) {
            return {
                summary: null,
                skipped: false,
                error: `AI response contained only reasoning tags with no final answer (provider "${provider}", model "${model}")`,
            };
        }

        return { summary: cleaned, skipped: false };
    } catch (error) {
        console.error("[AI Summary] Failed to generate summary:", error);
        return {
            summary: null,
            skipped: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function stripReasoningTags(text: string): string {
    if (!text) return "";

    let out = text;
    out = out.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think\s*>/gi, "");
    out = out.replace(/<think(?:\s[^>]*)?>[\s\S]*$/gi, "");
    out = out.replace(/<thinking(?:\s[^>]*)?>[\s\S]*?<\/thinking\s*>/gi, "");
    out = out.replace(/<thinking(?:\s[^>]*)?>[\s\S]*$/gi, "");
    out = out.replace(/<reasoning(?:\s[^>]*)?>[\s\S]*?<\/reasoning\s*>/gi, "");
    out = out.replace(/<reasoning(?:\s[^>]*)?>[\s\S]*$/gi, "");

    return out.trim();
}

/**
 * Process AI error and return user-friendly message
 */
function processAIError(
    error: any, 
    model: string, 
    provider: string
): { success: false; error: string; details?: string } {
    const originalMessage = error.message || 'Unknown error';
    console.error('[AI] Error:', error);

    let errorMessage = originalMessage;
    let errorDetails = '';

    if (originalMessage.includes('fetch failed') || originalMessage.includes('NetworkError')) {
        errorMessage = 'Network error: Unable to connect to AI service';
        errorDetails = 'Please check your API URL and network connection.';
    } else if (originalMessage.includes('Workers AI binding is not configured')) {
        errorMessage = 'Workers AI is not configured';
        errorDetails = 'Add the Cloudflare Workers AI binding before testing the worker-ai provider.';
    } else if (originalMessage.includes('401') || originalMessage.includes('Unauthorized')) {
        errorMessage = 'Authentication failed: Invalid API key';
        errorDetails = 'Please check your API key is correct and not expired.';
    } else if (originalMessage.includes('429')) {
        errorMessage = 'Rate limit exceeded';
        errorDetails = 'Too many requests. Please wait a moment.';
    } else if (originalMessage.includes('404')) {
        errorMessage = 'Model not found';
        errorDetails = `Model "${model}" not found for provider "${provider}".`;
    } else if (originalMessage.includes('500') || originalMessage.includes('503')) {
        errorMessage = 'AI service temporarily unavailable';
        errorDetails = 'Service is experiencing issues. Please try again later.';
    } else if (originalMessage.includes('Invalid')) {
        errorMessage = `AI model error: ${originalMessage}`;
        errorDetails = `Model "${model}" may not be supported. Please verify the model ID.`;
    }

    return { 
        success: false, 
        error: errorMessage,
        details: errorDetails || `Original: ${originalMessage}`
    };
}

/**
 * Get available models for a provider
 */
export function getAvailableModels(provider: string): string[] {
    if (provider === 'worker-ai') {
        return Object.keys(WORKER_AI_MODELS);
    }
    return [];
}

/**
 * Check if provider requires API key
 */
export function requiresApiKey(provider: string): boolean {
    return provider !== 'worker-ai';
}
