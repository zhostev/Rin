import type { AIConfig, AIWriterConfig } from "@rin/api";

export const WEBHOOK_URL_KEY = "WEBHOOK_URL";

export const CLIENT_CONFIG_DEFAULTS = new Map(
  Object.entries({
    "cache.enabled": false,
    "counter.enabled": true,
    "friend_apply_enable": true,
    "header.behavior": "fixed",
    "header.layout": "classic",
    "feed.layout": "list",
    "feed.card_variant": "default",
    "theme.color": "#fc466b",
    "comment.enabled": true,
    "login.enabled": true,
    "site.name": "Rin",
    "site.description": "A lightweight personal blogging system",
    "site.avatar": "",
    "site.page_size": 5,
  }),
);

export const SERVER_CONFIG_DEFAULTS = new Map(
  Object.entries({
    friend_apply_auto_accept: false,
    friend_crontab: true,
    friend_ua: "Rin-Check/0.1.0",
    "webhook.method": "POST",
    "webhook.content_type": "application/json",
    "webhook.headers": "{}",
    "webhook.body_template": "{\"content\":\"{{message}}\"}",
  }),
);

export const CLIENT_CONFIG_ENV_DEFAULTS: Record<string, string> = {
  "site.name": "NAME",
  "site.description": "DESCRIPTION",
  "site.avatar": "AVATAR",
  "site.page_size": "PAGE_SIZE",
};

export const AI_CONFIG_PREFIX = "ai_summary.";

export const AI_CONFIG_KEYS = [
  `${AI_CONFIG_PREFIX}enabled`,
  `${AI_CONFIG_PREFIX}provider`,
  `${AI_CONFIG_PREFIX}model`,
  `${AI_CONFIG_PREFIX}api_key`,
  `${AI_CONFIG_PREFIX}api_url`,
] as const;

export const AI_WRITER_CONFIG_PREFIX = "ai_writer.";

export const AI_WRITER_CONFIG_FIELDS = [
  "enabled",
  "provider",
  "model",
  "api_key",
  "api_url",
  "temperature",
  "max_tokens",
  "system_prompt",
  "pexels_api_key",
] as const;

export const AI_WRITER_CONFIG_KEYS = AI_WRITER_CONFIG_FIELDS.map(
  (field) => `${AI_WRITER_CONFIG_PREFIX}${field}`,
);

/** 访客指纹的伪名化种子；泄露即可反推每日盐，不得出现在设置面板的响应里。 */
export const ANALYTICS_SALT_SEED_KEY = "analytics.salt_seed";

export const SENSITIVE_SERVER_CONFIG_FIELDS = [
  `${AI_CONFIG_PREFIX}api_key`,
  `${AI_WRITER_CONFIG_PREFIX}api_key`,
  `${AI_WRITER_CONFIG_PREFIX}pexels_api_key`,
  ANALYTICS_SALT_SEED_KEY,
] as const;

export const DEFAULT_AI_CONFIG: AIConfig = {
  enabled: false,
  provider: "openai",
  model: "gpt-4o-mini",
  api_key: "",
  api_url: "https://api.openai.com/v1",
};

/**
 * provider/model/api_key/api_url 的空串表示「继承 ai_summary.* 的同名值」，
 * 合并逻辑在 server/src/utils/db-config.ts 的 getAIWriterConfig 中显式实现。
 * ConfigWrapper.get 的空值回落只能落到静态默认值，表达不了跨命名空间继承。
 */
export const DEFAULT_AI_WRITER_CONFIG: AIWriterConfig = {
  enabled: false,
  provider: "",
  model: "",
  api_key: "",
  api_url: "",
  temperature: 0.8,
  max_tokens: 4000,
  system_prompt: "",
  pexels_api_key: "",
};

export class ConfigWrapper {
  config: Record<string, unknown>;
  defaultConfig: Map<string, unknown>;

  constructor(config: Record<string, unknown>, defaultConfig: Map<string, unknown>) {
    this.config = config;
    this.defaultConfig = defaultConfig;
  }

  get<T>(key: string) {
    const value = this.config[key];
    if (value !== undefined && value !== "") {
      return value as T;
    }
    if (this.defaultConfig.has(key)) {
      return this.defaultConfig.get(key) as T;
    }
    return undefined;
  }

  default<T>(key: string) {
    return this.defaultConfig.get(key) as T;
  }

  getBoolean(key: string) {
    const value = this.get<unknown>(key);

    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const normalizedValue = value.trim().toLowerCase();

      if (normalizedValue === "true") {
        return true;
      }

      if (normalizedValue === "false") {
        return false;
      }
    }

    if (typeof value === "number") {
      return value !== 0;
    }

    return Boolean(value);
  }
}
