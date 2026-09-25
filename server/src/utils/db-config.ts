import type { AIConfig, AIWriterConfig } from "@rin/api";
import {
    AI_CONFIG_PREFIX,
    AI_WRITER_CONFIG_FIELDS,
    AI_WRITER_CONFIG_PREFIX,
    DEFAULT_AI_CONFIG,
    DEFAULT_AI_WRITER_CONFIG,
} from "@rin/config";

type ConfigReader = {
    get(key: string): Promise<unknown>;
};

type ConfigWriter = ConfigReader & {
    set(key: string, value: unknown, save?: boolean): Promise<void>;
    save(): Promise<void>;
};

const AI_CONFIG_FIELDS = ["enabled", "provider", "model", "api_key", "api_url"] as const;

export function readAIConfigFromValues(values: Record<string, unknown>): AIConfig {
    const config: AIConfig = { ...DEFAULT_AI_CONFIG };

    const enabled = values[AI_CONFIG_PREFIX + "enabled"];
    if (enabled != null) {
        config.enabled = enabled === true || enabled === "true";
    }

    const provider = values[AI_CONFIG_PREFIX + "provider"];
    if (typeof provider === "string" && provider.length > 0) {
        config.provider = provider;
    }

    const model = values[AI_CONFIG_PREFIX + "model"];
    if (typeof model === "string") {
        config.model = model;
    }

    const apiKey = values[AI_CONFIG_PREFIX + "api_key"];
    if (typeof apiKey === "string") {
        config.api_key = apiKey;
    }

    const apiUrl = values[AI_CONFIG_PREFIX + "api_url"];
    if (typeof apiUrl === "string") {
        config.api_url = apiUrl;
    }

    return config;
}

export function readAIConfigFromMap(values: Map<string, unknown>): AIConfig {
    return readAIConfigFromValues(Object.fromEntries(values));
}

export async function getAIConfig(config: ConfigReader): Promise<AIConfig> {
    const values = await Promise.all(
        AI_CONFIG_FIELDS.map(async (field) => [field, await config.get(AI_CONFIG_PREFIX + field)] as const),
    );

    return readAIConfigFromValues(
        Object.fromEntries(values.map(([field, value]) => [AI_CONFIG_PREFIX + field, value])),
    );
}

export async function getFrontendAIEnabled(config: ConfigReader): Promise<boolean> {
    const enabled = await config.get(AI_CONFIG_PREFIX + "enabled");
    return enabled == null ? DEFAULT_AI_CONFIG.enabled : enabled === true || enabled === "true";
}

export async function setAIConfig(config: ConfigWriter, updates: Partial<AIConfig>): Promise<void> {
    for (const field of AI_CONFIG_FIELDS) {
        const value = updates[field];
        if (value === undefined) {
            continue;
        }

        if (field === "api_key" && typeof value === "string" && value.trim() === "") {
            continue;
        }

        await config.set(AI_CONFIG_PREFIX + field, value, false);
    }

    await config.save();
}

export async function getAIConfigForFrontend(
    config: ConfigReader,
): Promise<AIConfig & { api_key_set: boolean }> {
    const aiConfig = await getAIConfig(config);
    return {
        ...aiConfig,
        api_key: "",
        api_key_set: aiConfig.api_key.length > 0,
    };
}

/** Blank means "inherit from ai_summary.*", so whitespace-only counts as blank. */
function inheritedString(own: unknown, fallback: string): string {
    return typeof own === "string" && own.trim().length > 0 ? own : fallback;
}

function coercedNumber(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
}

export async function getAIWriterConfig(config: ConfigReader): Promise<AIWriterConfig> {
    const base = await getAIConfig(config);
    const entries = await Promise.all(
        AI_WRITER_CONFIG_FIELDS.map(
            async (field) => [field, await config.get(AI_WRITER_CONFIG_PREFIX + field)] as const,
        ),
    );
    const values = Object.fromEntries(entries) as Record<string, unknown>;

    const enabled = values.enabled;

    return {
        enabled: enabled == null
            ? DEFAULT_AI_WRITER_CONFIG.enabled
            : enabled === true || enabled === "true",
        provider: inheritedString(values.provider, base.provider),
        model: inheritedString(values.model, base.model),
        api_key: inheritedString(values.api_key, base.api_key),
        api_url: inheritedString(values.api_url, base.api_url),
        temperature: coercedNumber(values.temperature, DEFAULT_AI_WRITER_CONFIG.temperature),
        max_tokens: coercedNumber(values.max_tokens, DEFAULT_AI_WRITER_CONFIG.max_tokens),
        system_prompt: typeof values.system_prompt === "string" ? values.system_prompt : "",
        pexels_api_key: typeof values.pexels_api_key === "string" ? values.pexels_api_key : "",
        vision_model: typeof values.vision_model === "string" ? values.vision_model : "",
    };
}

export async function setAIWriterConfig(
    config: ConfigWriter,
    updates: Partial<AIWriterConfig>,
): Promise<void> {
    for (const field of AI_WRITER_CONFIG_FIELDS) {
        const value = updates[field];
        if (value === undefined) {
            continue;
        }

        // Mirrors setAIConfig: a blank key means "leave the stored one alone",
        // so re-saving a form that never shows the key cannot wipe it.
        if (
            (field === "api_key" || field === "pexels_api_key") &&
            typeof value === "string" &&
            value.trim() === ""
        ) {
            continue;
        }

        await config.set(AI_WRITER_CONFIG_PREFIX + field, value, false);
    }

    await config.save();
}

export async function getAIWriterConfigForFrontend(
    config: ConfigReader,
): Promise<AIWriterConfig & { api_key_set: boolean; pexels_api_key_set: boolean }> {
    const writerConfig = await getAIWriterConfig(config);
    return {
        ...writerConfig,
        api_key: "",
        api_key_set: writerConfig.api_key.length > 0,
        pexels_api_key: "",
        pexels_api_key_set: writerConfig.pexels_api_key.length > 0,
    };
}
