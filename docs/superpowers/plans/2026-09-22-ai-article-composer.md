# AI 文章生成（AI Article Composer）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员给出一句话选题与一组媒体库素材，系统经队列异步生成整篇 Markdown 文章并直接发布上线。

**Architecture:** 复用既有的 `server/src/utils/ai.ts` 供应商层与 Cloudflare Queues 状态机。生成内核（prompt 组装、front-matter 解析、素材占位符替换、格式闸门）作为**无依赖纯函数**落在 `server/src/utils/ai-compose.ts`；应用装配（入队、消费、路由）落在 `server/src/services/feed-ai-compose.ts`，与既有 `feed-ai-summary.ts` 严格对称。不新建 workspace package，不新建数据表。

**Tech Stack:** Bun · TypeScript (strict) · Hono-like router · Drizzle ORM + Cloudflare D1 · Cloudflare Queues · Cloudflare Workers AI / OpenAI 兼容 API · React 18 + Vite + TailwindCSS + Wouter + i18next · `bun:test`

**Spec:** `docs/superpowers/specs/2026-09-22-ai-article-composer-design.md`

## Global Constraints

- **测试运行器只用 `bun:test`**。所有测试 `import { describe, expect, it } from "bun:test"`。不得引入其他测试运行器。
- **文件命名 kebab-case**；组件 PascalCase；函数 camelCase；类型/接口 PascalCase；数据库列 snake_case。
- **导入顺序**：外部依赖在前（字母序），内部导入在后（字母序）。
- **提交信息遵循 conventional commits**：`feat:` / `fix:` / `chore:` / `docs:` / `test:` / `style:` / `ci:` / `pref:`。
- **每条提交信息结尾加**：`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **不新建 workspace package**。`packages/ui` 目前还不是真实工作区包，不要往里加东西。
- **共享包（`packages/api`、`packages/config`）不得 import `client/` 或 `server/` 的应用模块。**
- **Worker bundle 体积敏感**：不得为本功能引入 YAML 解析库或任何新的运行时依赖。
- **类型检查**：`bun run check`；测试：`bun run test:server` / `bun run test:client`。
- 数据库迁移一律经 `bun run db:generate` 生成，**不要手写迁移 SQL**。

## 与 spec 的两处偏离（已核实代码后做出）

1. **spec §7.2 要求"校验 `assets[].id` 归属当前用户"** —— 核实 `server/src/services/media.ts:352` 后发现 `GET /api/media` 本身就是 `adminOnly` 且**不按 uid 过滤**，管理员本就能看到全部素材；而 compose 端点同样是 `adminOnly`。因此"归属校验"在此上下文中不产生额外保护。本计划改为**按 id 查库取回资产并拒绝未知 id** —— 这既覆盖了 spec"不能引用任意 id"的实质意图，也是渲染素材标记时**必须**拿到 `type` 与 `provider` 的前提。
2. **spec §5 的步骤顺序是 parse → render → gate**，但 §6.3 的闸门判据写的是"正文**剥除占位符后**短于 100 字符"。若先 render，占位符已变成 HTML 标记，字数会被标记本身撑大，该判据失效。本计划将顺序定为 **parse → gate → render**，闸门在未渲染的正文上测量。

---

### Task 1: 契约与常量（`packages/config` + `packages/api`）

纯声明层，无运行时依赖。先落地是因为后续每个服务端任务都要 import 它们。

**Files:**
- Modify: `packages/config/src/index.ts`（在 `DEFAULT_AI_CONFIG` 之后追加；`SENSITIVE_SERVER_CONFIG_FIELDS` 在 `packages/config/src/index.ts:56`）
- Modify: `packages/api/src/types.ts`（在 `AIConfig` 之后追加，`AIConfig` 在 `packages/api/src/types.ts:310`）
- Modify: `packages/api/src/schemas.ts`（在 `feedSetTopSchema` 之后追加，该 schema 在 `packages/api/src/schemas.ts:37`）
- Test: `packages/api/src/schema-validator.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: 无
- Produces:
  - `AI_WRITER_CONFIG_PREFIX: "ai_writer."`
  - `AI_WRITER_CONFIG_FIELDS: readonly ["enabled","provider","model","api_key","api_url","temperature","max_tokens","system_prompt"]`
  - `DEFAULT_AI_WRITER_CONFIG: AIWriterConfig`
  - `AIWriterConfig`、`ComposeLength`、`ComposeAssetInput`、`CreateAIComposeRequest`、`AIComposeStatusResponse`
  - `feedAIComposeSchema: Schema`

- [ ] **Step 1: 写失败的测试**

在 `packages/api/src/schema-validator.test.ts` 末尾追加：

```typescript
import { feedAIComposeSchema } from "./schemas";

describe("feedAIComposeSchema", () => {
  it("accepts a minimal request", () => {
    const issues = validateSchema(feedAIComposeSchema, {
      topic: "聊聊本地优先软件",
      assets: [],
    });
    expect(issues).toEqual([]);
  });

  it("accepts assets with notes and optional fields", () => {
    const issues = validateSchema(feedAIComposeSchema, {
      topic: "聊聊本地优先软件",
      assets: [{ id: "abc-123", note: "架构示意图" }],
      length: "long",
      style: "冷静克制",
      listed: false,
    });
    expect(issues).toEqual([]);
  });

  it("rejects an empty topic", () => {
    const issues = validateSchema(feedAIComposeSchema, { topic: "", assets: [] });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe("topic");
  });

  it("rejects an asset without an id", () => {
    const issues = validateSchema(feedAIComposeSchema, {
      topic: "选题",
      assets: [{ note: "缺少 id" }],
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});
```

> 注意：该文件顶部已有 `validateSchema` 的 import。若 `describe`/`expect`/`it` 尚未从 `bun:test` 导入，一并补上。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/api/src/schema-validator.test.ts`
Expected: FAIL，报 `feedAIComposeSchema` 不存在（`SyntaxError: export 'feedAIComposeSchema' not found`）

- [ ] **Step 3: 在 `packages/api/src/types.ts` 追加类型**

追加到 `AIConfig` 接口之后：

```typescript
export type ComposeLength = "short" | "medium" | "long";

export interface AIWriterConfig {
  enabled: boolean;
  provider: string;
  model: string;
  api_key: string;
  api_url: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string;
}

export interface ComposeAssetInput {
  id: string;
  note: string;
}

export interface CreateAIComposeRequest {
  topic: string;
  assets: ComposeAssetInput[];
  length?: ComposeLength;
  style?: string;
  listed?: boolean;
}

export type AIComposeStatus =
  | "idle"
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export interface AIComposeStatusResponse {
  status: AIComposeStatus;
  error: string;
}

export interface CreateAIComposeResponse {
  id: number;
  status: AIComposeStatus;
}
```

- [ ] **Step 4: 在 `packages/api/src/schemas.ts` 追加 schema**

追加到 `feedSetTopSchema` 之后：

```typescript
export const feedAIComposeSchema = t.Object({
  topic: t.String({ minLength: 1 }),
  assets: t.Array(
    t.Object({
      id: t.String({ minLength: 1 }),
      note: t.String(),
    }),
  ),
  length: t.String({ optional: true }),
  style: t.String({ optional: true }),
  listed: t.Boolean({ optional: true }),
});
```

> `t` 没有 `Union`/`Literal` 构造器（见 `packages/api/src/schema-validator.ts:17-35`），因此 `length` 在 schema 层只校验为字符串，取值收窄在路由处理器里做（Task 8）。

- [ ] **Step 5: 在 `packages/config/src/index.ts` 追加常量**

顶部 import 改为：

```typescript
import type { AIConfig, AIWriterConfig } from "@rin/api";
```

追加到 `DEFAULT_AI_CONFIG` 之后：

```typescript
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
] as const;

export const AI_WRITER_CONFIG_KEYS = AI_WRITER_CONFIG_FIELDS.map(
  (field) => `${AI_WRITER_CONFIG_PREFIX}${field}`,
);

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
};
```

并把 `SENSITIVE_SERVER_CONFIG_FIELDS`（`packages/config/src/index.ts:56`）改为：

```typescript
export const SENSITIVE_SERVER_CONFIG_FIELDS = [
  `${AI_CONFIG_PREFIX}api_key`,
  `${AI_WRITER_CONFIG_PREFIX}api_key`,
  ANALYTICS_SALT_SEED_KEY,
] as const;
```

> `AI_WRITER_CONFIG_PREFIX` 的声明必须放在 `SENSITIVE_SERVER_CONFIG_FIELDS` 之前，否则 TDZ 报错。把上面整块常量插到 `AI_CONFIG_KEYS` 之后、`ANALYTICS_SALT_SEED_KEY` 之前即可，`DEFAULT_AI_WRITER_CONFIG` 可留在 `DEFAULT_AI_CONFIG` 旁边。

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test packages/api/src/schema-validator.test.ts && bun run check`
Expected: PASS，类型检查无错

- [ ] **Step 7: 提交**

```bash
git add packages/api/src/types.ts packages/api/src/schemas.ts packages/api/src/schema-validator.test.ts packages/config/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): add AI article composer contracts and ai_writer config keys

Declares the request/response types, the validation schema and the
ai_writer.* namespace whose blank values inherit from ai_summary.*.
Registers ai_writer.api_key as a sensitive server config field.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `ai.ts` 参数化与统一入口

把写死的 `max_tokens: 500` / `temperature: 0.3` 提成参数，并把「worker-ai 还是外部 API」的分支收口。**既有测试一行不改**，用作回归证明。

**Files:**
- Modify: `server/src/utils/ai.ts:96-146`（`executeWorkerAI` 与 `executeExternalAI`）
- Test: `server/src/utils/__tests__/ai.test.ts`（追加，不修改既有用例）

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type AIGenerationOptions = { maxTokens?: number; temperature?: number }`
  - `export async function generateAIText(env: Env, config: { provider: string; model: string; api_key: string; api_url: string }, messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, options?: AIGenerationOptions): Promise<string | null>`

- [ ] **Step 1: 写失败的测试**

在 `server/src/utils/__tests__/ai.test.ts` 末尾追加（**不要改动文件中已有的用例**）：

```typescript
import { afterEach, describe, expect, it } from "bun:test";
import { generateAIText } from "../ai";

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/utils/__tests__/ai.test.ts`
Expected: 新增的 3 个用例 FAIL（`generateAIText` 不存在），**既有用例仍然 PASS**

- [ ] **Step 3: 改造 `server/src/utils/ai.ts`**

在 `WORKER_AI_MODELS` 声明之后追加类型：

```typescript
export type AIGenerationOptions = {
    maxTokens?: number;
    temperature?: number;
};

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_TEMPERATURE = 0.3;
```

`executeWorkerAI` 改为：

```typescript
async function executeWorkerAI(
    env: Env,
    modelId: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: AIGenerationOptions,
): Promise<string | null> {
    if (!env.AI || typeof env.AI.run !== "function") {
        throw new Error("Workers AI binding is not configured");
    }

    const response = await env.AI.run(modelId as any, {
        messages,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
    } as any);

    return extractAIText(response);
}
```

`executeExternalAI` 的签名与 body 改为：

```typescript
async function executeExternalAI(
    config: {
        provider: string;
        model: string;
        api_key: string;
        api_url: string;
    },
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: AIGenerationOptions,
): Promise<string | null> {
```

```typescript
        body: JSON.stringify({
            model: model,
            messages,
            max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
        }),
```

在 `executeExternalAI` 之后新增统一入口：

```typescript
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
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: AIGenerationOptions,
): Promise<string | null> {
    if (config.provider === 'worker-ai') {
        return executeWorkerAI(env, getWorkerAIModelId(config.model), messages, options);
    }

    return executeExternalAI(config, messages, options);
}
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `bun run test:server && bun run check`
Expected: 全部 PASS。既有的 `ai.test.ts` 与 `ai-summary.test.ts` 未经修改即通过 —— 这是参数化未回归摘要链路的证据。

- [ ] **Step 5: 提交**

```bash
git add server/src/utils/ai.ts server/src/utils/__tests__/ai.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): parameterize generation limits and add a unified text entry point

max_tokens and temperature were pinned at the 200-word summary tuning,
which truncates anything longer. Both become options that default to the
old values, so the summary path is unchanged, and generateAIText folds
the worker-ai/external branch that had been copied twice.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `ai_writer.*` 配置读写与继承语义

**Files:**
- Modify: `server/src/utils/db-config.ts`（在 `getAIConfigForFrontend` 之后追加）
- Test: `server/src/utils/__tests__/db-config-ai-writer.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `AI_WRITER_CONFIG_PREFIX`、`AI_WRITER_CONFIG_FIELDS`、`DEFAULT_AI_WRITER_CONFIG`、`AIWriterConfig`
- Produces:
  - `export async function getAIWriterConfig(config: ConfigReader): Promise<AIWriterConfig>`
  - `export async function setAIWriterConfig(config: ConfigWriter, updates: Partial<AIWriterConfig>): Promise<void>`
  - `export async function getAIWriterConfigForFrontend(config: ConfigReader): Promise<AIWriterConfig & { api_key_set: boolean }>`

- [ ] **Step 1: 写失败的测试**

创建 `server/src/utils/__tests__/db-config-ai-writer.test.ts`：

```typescript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/utils/__tests__/db-config-ai-writer.test.ts`
Expected: FAIL，`getAIWriterConfig` 不存在

- [ ] **Step 3: 实现**

在 `server/src/utils/db-config.ts` 顶部补充 import：

```typescript
import type { AIConfig, AIWriterConfig } from "@rin/api";
import {
    AI_CONFIG_PREFIX,
    AI_WRITER_CONFIG_FIELDS,
    AI_WRITER_CONFIG_PREFIX,
    DEFAULT_AI_CONFIG,
    DEFAULT_AI_WRITER_CONFIG,
} from "@rin/config";
```

在 `getAIConfigForFrontend` 之后追加：

```typescript
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
        if (field === "api_key" && typeof value === "string" && value.trim() === "") {
            continue;
        }

        await config.set(AI_WRITER_CONFIG_PREFIX + field, value, false);
    }

    await config.save();
}

export async function getAIWriterConfigForFrontend(
    config: ConfigReader,
): Promise<AIWriterConfig & { api_key_set: boolean }> {
    const writerConfig = await getAIWriterConfig(config);
    return {
        ...writerConfig,
        api_key: "",
        api_key_set: writerConfig.api_key.length > 0,
    };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/src/utils/__tests__/db-config-ai-writer.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/utils/db-config.ts server/src/utils/__tests__/db-config-ai-writer.test.ts
git commit -m "$(cat <<'EOF'
feat(config): read and write the ai_writer namespace with inheritance

Blank provider/model/api_key/api_url fall back to their ai_summary
counterparts, so picking a stronger writing model does not mean
re-entering the key and URL. Blank api_key on write is skipped, matching
setAIConfig, so a re-saved form cannot erase the stored key.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 生成内核纯函数（本计划最重的一块测试）

prompt 组装、front-matter 解析、格式闸门、素材占位符渲染。**不依赖 `env`、`db`、网络**，因此一个 mock 都不需要。

**Files:**
- Create: `server/src/utils/ai-compose.ts`
- Test: `server/src/utils/__tests__/ai-compose.test.ts`

**Interfaces:**
- Consumes: `MediaType`（来自 `@rin/api`）、`ComposeLength`（Task 1）
- Produces:
  - `COMPOSE_LENGTH_RANGES: Record<ComposeLength, { min: number; max: number }>`
  - `DEFAULT_COMPOSE_SYSTEM_PROMPT: string`
  - `type ComposeAsset = { id: string; type: MediaType; provider: "r2" | "stream"; note: string }`
  - `type ComposedArticle = { title: string; summary: string; tags: string[]; content: string }`
  - `type ComposeGateResult = { ok: true } | { ok: false; reason: string }`
  - `function buildComposeUserMessage(input: { topic: string; assets: ComposeAsset[]; length: ComposeLength; style?: string }): string`
  - `function parseComposedArticle(raw: string): ComposedArticle`
  - `function checkComposeGate(article: ComposedArticle): ComposeGateResult`
  - `function renderMediaPlaceholders(content: string, assets: ComposeAsset[]): string`
  - `function composeMaxTokensFloor(length: ComposeLength): number`

- [ ] **Step 1: 写失败的测试**

创建 `server/src/utils/__tests__/ai-compose.test.ts`：

```typescript
import { describe, expect, it } from "bun:test";
import {
  buildComposeUserMessage,
  checkComposeGate,
  composeMaxTokensFloor,
  parseComposedArticle,
  renderMediaPlaceholders,
  type ComposeAsset,
} from "../ai-compose";

const imageAsset: ComposeAsset = {
  id: "img-1",
  type: "image",
  provider: "r2",
  note: "架构示意图",
};

const videoAsset: ComposeAsset = {
  id: "vid-1",
  type: "video",
  provider: "stream",
  note: "演示录屏",
};

describe("buildComposeUserMessage", () => {
  it("includes the topic and the requested word range", () => {
    const message = buildComposeUserMessage({
      topic: "聊聊本地优先软件",
      assets: [],
      length: "medium",
    });

    expect(message).toContain("聊聊本地优先软件");
    expect(message).toContain("1200");
    expect(message).toContain("2000");
  });

  it("numbers the assets from 1 and shows each note", () => {
    const message = buildComposeUserMessage({
      topic: "选题",
      assets: [imageAsset, videoAsset],
      length: "short",
    });

    expect(message).toContain("[[media:1]]");
    expect(message).toContain("架构示意图");
    expect(message).toContain("[[media:2]]");
    expect(message).toContain("演示录屏");
  });

  it("never leaks the real asset id into the prompt", () => {
    const message = buildComposeUserMessage({
      topic: "选题",
      assets: [imageAsset],
      length: "short",
    });

    expect(message).not.toContain("img-1");
  });

  it("includes the style when given and omits the section when not", () => {
    const withStyle = buildComposeUserMessage({
      topic: "选题",
      assets: [],
      length: "short",
      style: "冷静克制",
    });
    const withoutStyle = buildComposeUserMessage({
      topic: "选题",
      assets: [],
      length: "short",
    });

    expect(withStyle).toContain("冷静克制");
    expect(withoutStyle).not.toContain("风格");
  });
});

describe("parseComposedArticle", () => {
  it("parses front-matter and body", () => {
    const article = parseComposedArticle(
      ["---", "title: 本地优先软件", "summary: 一句话摘要", "tags: 软件, 架构", "---", "", "正文第一段。"].join("\n"),
    );

    expect(article.title).toBe("本地优先软件");
    expect(article.summary).toBe("一句话摘要");
    expect(article.tags).toEqual(["软件", "架构"]);
    expect(article.content).toBe("正文第一段。");
  });

  it("splits tags on ASCII commas, full-width commas and ideographic commas", () => {
    const article = parseComposedArticle(
      ["---", "title: T", "tags: a, b，c、d", "---", "", "正文"].join("\n"),
    );

    expect(article.tags).toEqual(["a", "b", "c", "d"]);
  });

  it("drops a bracketed tag list rather than keeping the brackets", () => {
    const article = parseComposedArticle(
      ["---", "title: T", "tags: [a, b]", "---", "", "正文"].join("\n"),
    );

    expect(article.tags).toEqual(["a", "b"]);
  });

  it("ignores unknown front-matter keys", () => {
    const article = parseComposedArticle(
      ["---", "title: T", "author: 模型", "---", "", "正文"].join("\n"),
    );

    expect(article.title).toBe("T");
    expect(article.content).toBe("正文");
  });

  it("falls back to the first h1 when there is no front-matter", () => {
    const article = parseComposedArticle("# 标题在这里\n\n正文第一段。");

    expect(article.title).toBe("标题在这里");
    expect(article.content).toBe("正文第一段。");
    expect(article.summary).toBe("");
    expect(article.tags).toEqual([]);
  });

  it("leaves the title empty when neither front-matter nor an h1 exists", () => {
    const article = parseComposedArticle("就是一段没有标题的正文。");

    expect(article.title).toBe("");
    expect(article.content).toBe("就是一段没有标题的正文。");
  });

  it("strips a fenced code wrapper the model may have added", () => {
    const article = parseComposedArticle(
      ["```markdown", "---", "title: T", "---", "", "正文", "```"].join("\n"),
    );

    expect(article.title).toBe("T");
    expect(article.content).toBe("正文");
  });

  it("tolerates quoted front-matter values", () => {
    const article = parseComposedArticle(
      ["---", 'title: "带引号的标题"', "---", "", "正文"].join("\n"),
    );

    expect(article.title).toBe("带引号的标题");
  });
});

describe("checkComposeGate", () => {
  const body = "正".repeat(200);

  it("passes a well-formed article", () => {
    expect(checkComposeGate({ title: "T", summary: "", tags: [], content: body })).toEqual({ ok: true });
  });

  it("rejects an empty title", () => {
    const result = checkComposeGate({ title: "  ", summary: "", tags: [], content: body });
    expect(result.ok).toBe(false);
  });

  it("rejects a body shorter than 100 characters", () => {
    const result = checkComposeGate({ title: "T", summary: "", tags: [], content: "太短了" });
    expect(result.ok).toBe(false);
  });

  it("measures the body with placeholders removed", () => {
    const padded = `${"[[media:1]]".repeat(20)}短`;
    const result = checkComposeGate({ title: "T", summary: "", tags: [], content: padded });
    expect(result.ok).toBe(false);
  });

  it("gives a reason that can be stored in ai_compose_error", () => {
    const result = checkComposeGate({ title: "", summary: "", tags: [], content: body });
    if (result.ok) throw new Error("expected the gate to reject");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("renderMediaPlaceholders", () => {
  it("renders an image placeholder as a markdown image using its note as alt text", () => {
    const out = renderMediaPlaceholders("前文\n\n[[media:1]]\n\n后文", [imageAsset]);

    expect(out).toContain("![架构示意图](/api/media/img-1/playback)");
  });

  it("renders a video placeholder as the editor's media markup", () => {
    const out = renderMediaPlaceholders("[[media:1]]", [videoAsset]);

    expect(out).toContain('<video data-rin-media-id="vid-1"');
    expect(out).toContain('data-rin-media-provider="stream"');
    expect(out).toContain('title="演示录屏"');
    expect(out).toContain("</video>");
  });

  it("omits the provider attribute for r2 assets", () => {
    const r2Video: ComposeAsset = { ...videoAsset, provider: "r2" };
    const out = renderMediaPlaceholders("[[media:1]]", [r2Video]);

    expect(out).not.toContain("data-rin-media-provider");
  });

  it("strips unknown placeholder numbers instead of leaving them in the body", () => {
    const out = renderMediaPlaceholders("前文 [[media:9]] 后文", [imageAsset]);

    expect(out).not.toContain("[[media:9]]");
    expect(out).toContain("前文");
    expect(out).toContain("后文");
  });

  it("appends assets the model never referenced", () => {
    const out = renderMediaPlaceholders("只引用了第一个 [[media:1]]", [imageAsset, videoAsset]);

    expect(out).toContain("img-1");
    expect(out).toContain("vid-1");
  });

  it("renders a repeated placeholder at every occurrence", () => {
    const out = renderMediaPlaceholders("[[media:1]] 中间 [[media:1]]", [imageAsset]);

    expect(out.match(/img-1/g)?.length).toBe(2);
  });

  it("does not append anything when every asset was used", () => {
    const out = renderMediaPlaceholders("[[media:1]][[media:2]]", [imageAsset, videoAsset]);

    expect(out.match(/img-1/g)?.length).toBe(1);
    expect(out.match(/vid-1/g)?.length).toBe(1);
  });

  it("sanitizes quotes and angle brackets in a note used as an attribute", () => {
    const nasty: ComposeAsset = { ...videoAsset, note: 'a"b<c>d' };
    const out = renderMediaPlaceholders("[[media:1]]", [nasty]);

    expect(out).not.toContain('a"b');
    expect(out).toContain('title="abcd"');
  });

  it("sanitizes brackets in a note used as image alt text", () => {
    const nasty: ComposeAsset = { ...imageAsset, note: "a[b]c" };
    const out = renderMediaPlaceholders("[[media:1]]", [nasty]);

    expect(out).toContain("![abc](/api/media/img-1/playback)");
  });

  it("returns the body unchanged when there are no assets", () => {
    expect(renderMediaPlaceholders("纯文本正文", [])).toBe("纯文本正文");
  });
});

describe("composeMaxTokensFloor", () => {
  it("scales with the requested length", () => {
    expect(composeMaxTokensFloor("short")).toBeLessThan(composeMaxTokensFloor("long"));
  });

  it("leaves room for the longest requested article", () => {
    expect(composeMaxTokensFloor("long")).toBeGreaterThanOrEqual(8000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/utils/__tests__/ai-compose.test.ts`
Expected: FAIL，模块 `../ai-compose` 不存在

- [ ] **Step 3: 实现 `server/src/utils/ai-compose.ts`**

```typescript
import type { ComposeLength, MediaType } from "@rin/api";

export type ComposeAsset = {
    id: string;
    type: MediaType;
    provider: "r2" | "stream";
    note: string;
};

export type ComposedArticle = {
    title: string;
    summary: string;
    tags: string[];
    content: string;
};

export type ComposeGateResult = { ok: true } | { ok: false; reason: string };

/** Chinese-character ranges quoted to the model; not enforced by the gate. */
export const COMPOSE_LENGTH_RANGES: Record<ComposeLength, { min: number; max: number }> = {
    short: { min: 600, max: 1000 },
    medium: { min: 1200, max: 2000 },
    long: { min: 2500, max: 4000 },
};

/** Roughly two tokens per Chinese character, so a long article is not truncated. */
const TOKENS_PER_CHARACTER = 2;

const MIN_BODY_LENGTH = 100;

const PLACEHOLDER_PATTERN = /\[\[media:(\d+)\]\]/g;

export const DEFAULT_COMPOSE_SYSTEM_PROMPT = [
    "你是一位中文博客作者。请根据用户给出的选题与素材写出一篇完整的 Markdown 文章。",
    "",
    "输出格式要求（必须严格遵守）：",
    "1. 以一段 front-matter 开头，用三个连字符包围，其中包含 title、summary、tags 三个字段。",
    "2. front-matter 之后空一行，接正文 Markdown。",
    "3. 正文中不要再重复一级标题。",
    "4. 只输出文章本身，不要输出任何解释、前言或代码块包裹。",
    "",
    "示例：",
    "---",
    "title: 文章标题",
    "summary: 一句话摘要",
    "tags: 标签一, 标签二",
    "---",
    "",
    "正文第一段……",
].join("\n");

export function composeMaxTokensFloor(length: ComposeLength): number {
    return COMPOSE_LENGTH_RANGES[length].max * TOKENS_PER_CHARACTER;
}

export function buildComposeUserMessage(input: {
    topic: string;
    assets: ComposeAsset[];
    length: ComposeLength;
    style?: string;
}): string {
    const { topic, assets, length, style } = input;
    const range = COMPOSE_LENGTH_RANGES[length];

    const sections: string[] = [
        `选题：${topic}`,
        `篇幅：正文约 ${range.min} 到 ${range.max} 个中文字符。`,
    ];

    if (style && style.trim().length > 0) {
        sections.push(`风格：${style.trim()}`);
    }

    if (assets.length > 0) {
        const lines = assets.map((asset, index) => {
            const kind = asset.type === "image" ? "图片" : asset.type === "video" ? "视频" : "音频";
            const note = asset.note.trim() || "（无说明）";
            return `${index + 1}. ${kind} —— ${note}`;
        });

        sections.push(
            [
                "素材清单：",
                ...lines,
                "",
                "请在正文中合适的位置插入素材，写法是 [[media:编号]]，例如 [[media:1]]。",
                "编号只能来自上面的清单。不要自行编写图片链接或 HTML 标签，系统会把占位符替换为正确的引用。",
                "每个素材至少引用一次。",
            ].join("\n"),
        );
    }

    return sections.join("\n\n");
}

/** The model sometimes wraps the whole answer in a fenced block. */
function stripCodeFence(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("```")) {
        return trimmed;
    }

    const lines = trimmed.split("\n");
    if (lines.length < 2) {
        return trimmed;
    }

    lines.shift();
    if (lines[lines.length - 1]?.trim().startsWith("```")) {
        lines.pop();
    }

    return lines.join("\n").trim();
}

function unquote(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1).trim();
        }
    }
    return trimmed;
}

function parseTags(value: string): string[] {
    return unquote(value)
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(/[,，、]/)
        .map((tag) => unquote(tag))
        .filter((tag) => tag.length > 0);
}

export function parseComposedArticle(raw: string): ComposedArticle {
    const text = stripCodeFence(raw);
    const article: ComposedArticle = { title: "", summary: "", tags: [], content: "" };

    const lines = text.split("\n");

    if (lines[0]?.trim() === "---") {
        const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

        if (closing > 0) {
            for (const line of lines.slice(1, closing)) {
                const separator = line.indexOf(":");
                if (separator <= 0) continue;

                const key = line.slice(0, separator).trim().toLowerCase();
                const value = line.slice(separator + 1);

                if (key === "title") article.title = unquote(value);
                else if (key === "summary") article.summary = unquote(value);
                else if (key === "tags") article.tags = parseTags(value);
            }

            article.content = lines.slice(closing + 1).join("\n").trim();
            return article;
        }
    }

    // No usable front-matter: fall back to the first h1, if any.
    const headingIndex = lines.findIndex((line) => /^#\s+/.test(line.trim()));
    if (headingIndex >= 0) {
        article.title = lines[headingIndex].trim().replace(/^#\s+/, "").trim();
        article.content = [...lines.slice(0, headingIndex), ...lines.slice(headingIndex + 1)]
            .join("\n")
            .trim();
        return article;
    }

    article.content = text.trim();
    return article;
}

/**
 * Only rejects output that is plainly broken. Quality is explicitly not judged —
 * the spec's publish-without-review decision rests on this being the sole gate.
 * Runs before placeholders are rendered so the length check measures prose.
 */
export function checkComposeGate(article: ComposedArticle): ComposeGateResult {
    if (article.title.trim().length === 0) {
        return { ok: false, reason: "AI 返回的内容里没有解析出标题" };
    }

    const prose = article.content.replace(PLACEHOLDER_PATTERN, "").trim();
    if (prose.length < MIN_BODY_LENGTH) {
        return {
            ok: false,
            reason: `AI 返回的正文过短（${prose.length} 字符，至少需要 ${MIN_BODY_LENGTH} 字符）`,
        };
    }

    return { ok: true };
}

function imageMarkup(asset: ComposeAsset): string {
    const alt = asset.note.replace(/[[\]]/g, "").trim();
    return `![${alt}](/api/media/${encodeURIComponent(asset.id)}/playback)`;
}

/** Mirrors client/src/components/media-embed.tsx buildMediaMarkup. */
function playableMarkup(asset: ComposeAsset): string {
    const tag = asset.type === "audio" ? "audio" : "video";
    const safeTitle = asset.note.replace(/["<>]/g, "").trim();
    const titleAttribute = safeTitle ? ` title="${safeTitle}"` : "";
    const providerAttribute =
        asset.provider !== "r2" ? ` data-rin-media-provider="${asset.provider}"` : "";
    return `<${tag} data-rin-media-id="${asset.id}"${providerAttribute}${titleAttribute} controls></${tag}>`;
}

function assetMarkup(asset: ComposeAsset): string {
    return asset.type === "image" ? imageMarkup(asset) : playableMarkup(asset);
}

export function renderMediaPlaceholders(content: string, assets: ComposeAsset[]): string {
    if (assets.length === 0) {
        return content;
    }

    const used = new Set<number>();

    const rendered = content.replace(PLACEHOLDER_PATTERN, (_match, rawIndex: string) => {
        const index = Number.parseInt(rawIndex, 10) - 1;
        const asset = assets[index];
        if (!asset) {
            // The model invented a number we never offered: drop it rather than
            // leaving bracket noise in a published article.
            return "";
        }

        used.add(index);
        return assetMarkup(asset);
    });

    const unused = assets.filter((_asset, index) => !used.has(index));
    if (unused.length === 0) {
        return rendered;
    }

    // The admin deliberately supplied these; appending beats dropping silently.
    return [rendered.trim(), ...unused.map((asset) => assetMarkup(asset))].join("\n\n");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/src/utils/__tests__/ai-compose.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/utils/ai-compose.ts server/src/utils/__tests__/ai-compose.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): add the article composer kernel as dependency-free helpers

Prompt assembly, front-matter parsing, the format gate and media
placeholder rendering. The model writes [[media:N]] and the server
substitutes the real markup, so a wrong character in a URL or an HTML
attribute can never break asset binding.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `feeds` 表新增两列

**Files:**
- Modify: `server/src/db/schema.ts:204`（`feeds` 表定义，`ai_summary_error` 之后）
- Create: `server/sql/0019.sql`

**Interfaces:**
- Consumes: 无
- Produces: `feeds.ai_compose_status`、`feeds.ai_compose_error` 两列

> **迁移机制说明（执行前已实证，不要按直觉改用 drizzle-kit）**
>
> 本仓库真正生效的迁移是 `server/sql/` 下的编号 SQL 文件：`cli/src/tasks/db-migrate-local.ts` 读取 `server/sql/*.sql`，用 `wrangler d1 execute` 逐个施加，并以数据库 `info` 表里的 `migration_version` 行记录进度。
>
> `bun run db:generate`（drizzle-kit）产出的 `server/drizzle/` 目录被 `server/.gitignore:6` 忽略，**不入库、也不被迁移器读取**，因此本任务不使用它。
>
> `bun run db:migrate` 在本 worktree 里跑不了（`wrangler.toml` 被 gitignore，由 `scripts/ensure-wrangler-toml.ts` 生成），且会触碰共享的本地 D1 状态。真实迁移由 Task 13 的端到端验证覆盖。
>
> 同形先例：`server/sql/0009.sql` 就是用这个方式给 `feeds` 加上三个 `ai_summary_*` 列的。

- [ ] **Step 1: 修改 schema**

在 `server/src/db/schema.ts` 的 `feeds` 表中，`ai_summary_error` 一行之后插入：

```typescript
    ai_compose_status: text("ai_compose_status").default("idle").notNull(),
    ai_compose_error: text("ai_compose_error").default("").notNull(),
```

- [ ] **Step 2: 确认下一个迁移编号**

Run: `ls server/sql/ | sort -V | tail -1`
Expected: `0018.sql` —— 因此新文件是 `0019.sql`，版本号是 `19`。若实际输出不是 `0018.sql`，以实际最大编号加一为准，并相应调整版本号。

- [ ] **Step 3: 新建 `server/sql/0019.sql`**

内容逐字如下（格式对照 `server/sql/0018.sql` 与 `server/sql/0009.sql`）：

```sql
ALTER TABLE `feeds` ADD COLUMN `ai_compose_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feeds` ADD COLUMN `ai_compose_error` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `info` SET `value` = '19' WHERE `key` = 'migration_version';
```

三点必须照做：

1. `--> statement-breakpoint` 是本仓库所有迁移文件的语句分隔符，一条都不能少。
2. 最后那条 `UPDATE info` 是迁移器判断进度的唯一依据，漏掉会导致这个迁移被反复重放。
3. 列定义必须与 Step 1 的 schema 逐字对应：`text DEFAULT 'idle' NOT NULL` 对 `text("ai_compose_status").default("idle").notNull()`，`text DEFAULT '' NOT NULL` 对 `.default("")`。

- [ ] **Step 4: 核对与先例一致**

Run: `cat server/sql/0009.sql`
Expected: 你写的两条 `ALTER TABLE` 与其中 `ai_summary_status` / `ai_summary_error` 两行形状完全一致（只有列名不同）。不一致就改到一致。

- [ ] **Step 5: 类型检查**

Run: `bun run check`
Expected: 6/6 通过

- [ ] **Step 6: 提交**

```bash
git add server/src/db/schema.ts server/sql/0019.sql
git commit -m "$(cat <<'EOF'
feat(db): track AI compose status on feeds

Two columns mirroring the existing ai_summary_* trio, added the same way
0009.sql added those. The composed article is the content column itself,
so no third column is needed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 队列任务类型改为 union

`QueueTask` 目前是单一类型，`isQueueTask` 硬编码了唯一的 type。这一步把它扩成可辨识联合。

**Files:**
- Modify: `server/src/queue/tasks.ts`（整文件重写，内容见 Step 3）
- Test: `server/src/queue/__tests__/tasks.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `FEED_AI_COMPOSE_TASK: "feed.ai-compose.generate"`
  - `type FeedAIComposeStatus = "idle" | "pending" | "processing" | "completed" | "failed"`
  - `interface FeedAIComposeTaskPayload { feedId: number; expectedUpdatedAtUnix: number; topic: string; assets: Array<{ id: string; note: string }>; length: ComposeLength; style?: string; listed: boolean }`
  - `function createFeedAIComposeTask(payload: FeedAIComposeTaskPayload): FeedAIComposeTask`
  - `type QueueTask = FeedAISummaryTask | FeedAIComposeTask`

- [ ] **Step 1: 写失败的测试**

创建 `server/src/queue/__tests__/tasks.test.ts`：

```typescript
import { describe, expect, it } from "bun:test";
import {
  createFeedAIComposeTask,
  createFeedAISummaryTask,
  FEED_AI_COMPOSE_TASK,
  FEED_AI_SUMMARY_TASK,
  isQueueTask,
} from "../tasks";

const composePayload = {
  feedId: 7,
  expectedUpdatedAtUnix: 1_700_000_000,
  topic: "聊聊本地优先软件",
  assets: [{ id: "img-1", note: "架构图" }],
  length: "medium" as const,
  listed: true,
};

describe("isQueueTask", () => {
  it("still accepts summary tasks", () => {
    expect(isQueueTask(createFeedAISummaryTask({ feedId: 1, expectedUpdatedAtUnix: 123 }))).toBe(true);
  });

  it("accepts compose tasks", () => {
    expect(isQueueTask(createFeedAIComposeTask(composePayload))).toBe(true);
  });

  it("rejects an unknown task type", () => {
    expect(isQueueTask({ type: "feed.unknown", payload: composePayload })).toBe(false);
  });

  it("rejects a compose task missing its topic", () => {
    const { topic, ...rest } = composePayload;
    expect(isQueueTask({ type: FEED_AI_COMPOSE_TASK, payload: rest })).toBe(false);
  });

  it("rejects a compose task whose assets are not an array", () => {
    expect(
      isQueueTask({ type: FEED_AI_COMPOSE_TASK, payload: { ...composePayload, assets: "img-1" } }),
    ).toBe(false);
  });

  it("rejects a summary payload sent under the compose type", () => {
    expect(
      isQueueTask({ type: FEED_AI_COMPOSE_TASK, payload: { feedId: 1, expectedUpdatedAtUnix: 1 } }),
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isQueueTask(null)).toBe(false);
    expect(isQueueTask("feed.ai-summary.generate")).toBe(false);
  });
});

describe("createFeedAIComposeTask", () => {
  it("tags the payload with the compose task type", () => {
    const task = createFeedAIComposeTask(composePayload);

    expect(task.type).toBe(FEED_AI_COMPOSE_TASK);
    expect(task.payload.topic).toBe("聊聊本地优先软件");
  });

  it("keeps the summary task type distinct", () => {
    expect(FEED_AI_COMPOSE_TASK).not.toBe(FEED_AI_SUMMARY_TASK);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/queue/__tests__/tasks.test.ts`
Expected: FAIL，`createFeedAIComposeTask` 不存在

- [ ] **Step 3: 重写 `server/src/queue/tasks.ts`**

```typescript
import type { ComposeLength } from "@rin/api";

export const FEED_AI_SUMMARY_TASK = "feed.ai-summary.generate" as const;
export const FEED_AI_COMPOSE_TASK = "feed.ai-compose.generate" as const;

export type FeedAISummaryStatus =
  | "idle"
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export type FeedAIComposeStatus = FeedAISummaryStatus;

export interface FeedAISummaryTaskPayload {
  feedId: number;
  expectedUpdatedAt?: string;
  expectedUpdatedAtUnix?: number;
}

export interface FeedAISummaryTask {
  type: typeof FEED_AI_SUMMARY_TASK;
  payload: FeedAISummaryTaskPayload;
}

export interface FeedAIComposeTaskPayload {
  feedId: number;
  expectedUpdatedAtUnix: number;
  topic: string;
  assets: Array<{ id: string; note: string }>;
  length: ComposeLength;
  style?: string;
  listed: boolean;
}

export interface FeedAIComposeTask {
  type: typeof FEED_AI_COMPOSE_TASK;
  payload: FeedAIComposeTaskPayload;
}

export type QueueTask = FeedAISummaryTask | FeedAIComposeTask;

export function createFeedAISummaryTask(
  payload: FeedAISummaryTaskPayload,
): FeedAISummaryTask {
  return {
    type: FEED_AI_SUMMARY_TASK,
    payload,
  };
}

export function createFeedAIComposeTask(
  payload: FeedAIComposeTaskPayload,
): FeedAIComposeTask {
  return {
    type: FEED_AI_COMPOSE_TASK,
    payload,
  };
}

function isSummaryPayload(value: unknown): value is FeedAISummaryTaskPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<FeedAISummaryTaskPayload>;
  return (
    typeof payload.feedId === "number" &&
    (
      typeof payload.expectedUpdatedAtUnix === "number" ||
      typeof payload.expectedUpdatedAt === "string"
    )
  );
}

function isComposePayload(value: unknown): value is FeedAIComposeTaskPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<FeedAIComposeTaskPayload>;
  return (
    typeof payload.feedId === "number" &&
    typeof payload.expectedUpdatedAtUnix === "number" &&
    typeof payload.topic === "string" &&
    typeof payload.listed === "boolean" &&
    Array.isArray(payload.assets)
  );
}

export function isQueueTask(value: unknown): value is QueueTask {
  if (!value || typeof value !== "object") {
    return false;
  }

  const task = value as Partial<QueueTask>;

  if (task.type === FEED_AI_SUMMARY_TASK) {
    return isSummaryPayload(task.payload);
  }

  if (task.type === FEED_AI_COMPOSE_TASK) {
    return isComposePayload(task.payload);
  }

  return false;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test:server && bun run check`
Expected: PASS，既有的队列相关测试不受影响

- [ ] **Step 5: 提交**

```bash
git add server/src/queue/tasks.ts server/src/queue/__tests__/tasks.test.ts
git commit -m "$(cat <<'EOF'
feat(queue): turn QueueTask into a discriminated union

Adds the compose task alongside the summary one, with per-type payload
validation so a summary payload cannot arrive under the compose type.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `feed-ai-compose` 服务与队列消费

入队、消费、发布。消费逻辑中可独立测试的部分（状态推进的决策）抽成纯函数 `decideComposeOutcome`，与仓库既有做法一致 —— `feed-ai-summary.test.ts` 也只测纯函数。

**Files:**
- Create: `server/src/services/feed-ai-compose.ts`
- Create: `server/src/services/__tests__/feed-ai-compose.test.ts`
- Modify: `server/src/runtime/queue-handler.ts`

**Interfaces:**
- Consumes: Task 2 的 `generateAIText`/`AIGenerationOptions`；Task 3 的 `getAIWriterConfig`；Task 4 的全部导出；Task 6 的 `createFeedAIComposeTask`/`FEED_AI_COMPOSE_TASK`/`FeedAIComposeTaskPayload`
- Produces:
  - `function normalizeComposeLength(value: unknown): ComposeLength`
  - `function decideComposeOutcome(input: { raw: string | null; error?: string }): ComposeOutcome`
  - `type ComposeOutcome = { kind: "failed"; error: string } | { kind: "published"; article: ComposedArticle }`
  - `async function enqueueFeedAICompose(env: Env, payload: FeedAIComposeTaskPayload): Promise<{ ok: true } | { ok: false; error: string }>`
  - `async function loadComposeAssets(db: DB, requested: Array<{ id: string; note: string }>): Promise<{ ok: true; assets: ComposeAsset[] } | { ok: false; missing: string[] }>`
  - `async function processFeedAIComposeTask(env, db, cache, serverConfig, payload, clearFeedCache): Promise<void>`
  - `function registerFeedAIComposeRoutes(app): void`（路由体在 Task 8 接上）

- [ ] **Step 1: 写失败的测试**

创建 `server/src/services/__tests__/feed-ai-compose.test.ts`：

```typescript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/services/__tests__/feed-ai-compose.test.ts`
Expected: FAIL，模块 `../feed-ai-compose` 不存在

- [ ] **Step 3: 实现 `server/src/services/feed-ai-compose.ts`**

```typescript
import type { ComposeLength } from "@rin/api";
import { eq, inArray } from "drizzle-orm";
import type { CacheImpl, DB } from "../core/hono-types";
import { feeds, mediaAssets } from "../db/schema";
import {
    createFeedAIComposeTask,
    createTaskQueue,
    type FeedAIComposeStatus,
    type FeedAIComposeTaskPayload,
} from "../queue";
import { generateAIText, stripReasoningTags } from "../utils/ai";
import {
    buildComposeUserMessage,
    checkComposeGate,
    composeMaxTokensFloor,
    DEFAULT_COMPOSE_SYSTEM_PROMPT,
    parseComposedArticle,
    renderMediaPlaceholders,
    type ComposeAsset,
    type ComposedArticle,
} from "../utils/ai-compose";
import { getAIWriterConfig } from "../utils/db-config";
import { syncFeedAISummaryQueueState } from "./feed-ai-summary";
import { syncMediaForFeed } from "./media";
import { bindTagToPost } from "./tag";

type ConfigReader = {
    get(key: string): Promise<unknown>;
};

export type ComposeOutcome =
    | { kind: "failed"; error: string }
    | { kind: "published"; article: ComposedArticle };

const COMPOSE_LENGTHS: ComposeLength[] = ["short", "medium", "long"];

export function normalizeComposeLength(value: unknown): ComposeLength {
    return COMPOSE_LENGTHS.includes(value as ComposeLength) ? (value as ComposeLength) : "medium";
}

function buildStatusUpdate(
    status: FeedAIComposeStatus,
    overrides?: Partial<{ ai_compose_error: string }>,
) {
    return {
        ai_compose_status: status,
        ai_compose_error: "",
        ...overrides,
    };
}

/**
 * The whole decision of "publish or stop at draft", isolated from IO so it can
 * be tested without a database or a provider.
 */
export function decideComposeOutcome(input: { raw: string | null; error?: string }): ComposeOutcome {
    if (input.error) {
        return { kind: "failed", error: input.error };
    }

    if (!input.raw || !input.raw.trim()) {
        return { kind: "failed", error: "AI 返回了空响应" };
    }

    const cleaned = stripReasoningTags(input.raw);
    if (!cleaned.trim()) {
        return { kind: "failed", error: "AI 响应中只有推理内容，没有正文" };
    }

    const article = parseComposedArticle(cleaned);
    const gate = checkComposeGate(article);
    if (!gate.ok) {
        return { kind: "failed", error: gate.reason };
    }

    return { kind: "published", article };
}

export async function enqueueFeedAICompose(
    env: Env,
    payload: FeedAIComposeTaskPayload,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await createTaskQueue(env).send(createFeedAIComposeTask(payload));
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Looks assets up so the renderer knows each one's type and provider. */
export async function loadComposeAssets(
    db: DB,
    requested: Array<{ id: string; note: string }>,
): Promise<{ ok: true; assets: ComposeAsset[] } | { ok: false; missing: string[] }> {
    if (requested.length === 0) {
        return { ok: true, assets: [] };
    }

    const rows = await db.query.mediaAssets.findMany({
        where: inArray(mediaAssets.id, requested.map((asset) => asset.id)),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    const missing = requested.filter((asset) => !byId.has(asset.id)).map((asset) => asset.id);
    if (missing.length > 0) {
        return { ok: false, missing };
    }

    return {
        ok: true,
        // Preserve the order the admin chose: it is the order the model is shown.
        assets: requested.map((asset) => {
            const row = byId.get(asset.id)!;
            return {
                id: row.id,
                type: row.type as ComposeAsset["type"],
                provider: row.provider as ComposeAsset["provider"],
                note: asset.note,
            };
        }),
    };
}

export async function processFeedAIComposeTask(
    env: Env,
    db: DB,
    cache: CacheImpl,
    serverConfig: ConfigReader,
    payload: FeedAIComposeTaskPayload,
    clearFeedCache: (
        cache: CacheImpl,
        id: number,
        alias: string | null,
        newAlias: string | null,
    ) => Promise<void>,
) {
    const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, payload.feedId) });

    if (!feed) {
        return;
    }

    // A manual edit during generation means the admin took over; do not overwrite.
    if (Math.floor(feed.updatedAt.getTime() / 1000) !== payload.expectedUpdatedAtUnix) {
        return;
    }

    const writerConfig = await getAIWriterConfig(serverConfig);
    if (!writerConfig.enabled) {
        await db
            .update(feeds)
            .set(buildStatusUpdate("failed", { ai_compose_error: "AI 写作功能未启用" }))
            .where(eq(feeds.id, feed.id));
        return;
    }

    await db.update(feeds).set(buildStatusUpdate("processing")).where(eq(feeds.id, feed.id));

    const assetResult = await loadComposeAssets(db, payload.assets);
    if (!assetResult.ok) {
        await db
            .update(feeds)
            .set(
                buildStatusUpdate("failed", {
                    ai_compose_error: `素材不存在：${assetResult.missing.join(", ")}`,
                }),
            )
            .where(eq(feeds.id, feed.id));
        return;
    }

    const length = normalizeComposeLength(payload.length);
    const messages = [
        {
            role: "system" as const,
            content: writerConfig.system_prompt.trim() || DEFAULT_COMPOSE_SYSTEM_PROMPT,
        },
        {
            role: "user" as const,
            content: buildComposeUserMessage({
                topic: payload.topic,
                assets: assetResult.assets,
                length,
                style: payload.style,
            }),
        },
    ];

    let raw: string | null = null;
    let requestError: string | undefined;

    try {
        raw = await generateAIText(env, writerConfig, messages, {
            // Never let a configured ceiling truncate the length that was asked for.
            maxTokens: Math.max(writerConfig.max_tokens, composeMaxTokensFloor(length)),
            temperature: writerConfig.temperature,
        });
    } catch (error) {
        console.error("[AI Compose] Generation failed:", error);
        requestError = error instanceof Error ? error.message : String(error);
    }

    const outcome = decideComposeOutcome({ raw, error: requestError });

    if (outcome.kind === "failed") {
        await db
            .update(feeds)
            .set(buildStatusUpdate("failed", { ai_compose_error: outcome.error }))
            .where(eq(feeds.id, feed.id));
        await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
        return;
    }

    const content = renderMediaPlaceholders(outcome.article.content, assetResult.assets);
    const publishedAt = new Date();

    await db
        .update(feeds)
        .set({
            title: outcome.article.title,
            summary: outcome.article.summary,
            content,
            draft: 0,
            listed: payload.listed ? 1 : 0,
            updatedAt: publishedAt,
            ...buildStatusUpdate("completed"),
        })
        .where(eq(feeds.id, feed.id));

    await bindTagToPost(db, feed.id, outcome.article.tags);
    await syncMediaForFeed(db, feed.id, feed.uid, content);
    await syncFeedAISummaryQueueState(db, serverConfig, env, feed.id, {
        draft: false,
        updatedAt: publishedAt,
        resetSummary: true,
    });
    await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
}
```

> `registerFeedAIComposeRoutes` 在 Task 8 追加到本文件。

- [ ] **Step 4: 接上队列消费者**

修改 `server/src/runtime/queue-handler.ts`：

import 部分改为：

```typescript
import { isQueueTask, FEED_AI_COMPOSE_TASK, FEED_AI_SUMMARY_TASK } from "../queue";
import { processFeedAIComposeTask } from "../services/feed-ai-compose";
import { processFeedAISummaryTask } from "../services/feed-ai-summary";
```

在 `switch` 中 `FEED_AI_SUMMARY_TASK` 分支之后插入：

```typescript
      case FEED_AI_COMPOSE_TASK:
        await processFeedAIComposeTask(
          env,
          db,
          cache,
          serverConfig,
          body.payload,
          clearFeedCache,
        );
        message.ack();
        break;
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun run test:server && bun run check`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/services/feed-ai-compose.ts server/src/services/__tests__/feed-ai-compose.test.ts server/src/runtime/queue-handler.ts
git commit -m "$(cat <<'EOF'
feat(feed): generate and publish composed articles from the queue

The consumer refuses to overwrite a placeholder the admin edited during
generation, and anything the format gate rejects stops at draft with the
reason recorded, so a broken response never reaches the public site.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 路由 —— 创建端点、状态端点，并修掉详情接口的错误信息泄露

**Files:**
- Modify: `server/src/services/feed-ai-compose.ts`（追加 `registerFeedAIComposeRoutes`）
- Modify: `server/src/services/feed.ts:67`（`FeedService()` 内挂载一行）与 `server/src/services/feed.ts:287`（详情响应裁列）
- Test: `server/src/services/__tests__/feed-ai-compose-routes.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `feedAIComposeSchema`/`CreateAIComposeRequest`；Task 7 的 `enqueueFeedAICompose`/`loadComposeAssets`/`normalizeComposeLength`
- Produces:
  - `POST /api/feed/ai-compose` → `202 { id, status: "pending" }`
  - `GET /api/feed/:id/ai-compose-status` → `{ status, error }`

- [ ] **Step 1: 写失败的测试**

创建 `server/src/services/__tests__/feed-ai-compose-routes.test.ts`：

```typescript
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { registerFeedAIComposeRoutes } from "../feed-ai-compose";

type Row = Record<string, unknown>;

function buildApp(options: {
  admin: boolean;
  uid?: number;
  assets?: Row[];
  writerEnabled?: boolean;
  inserted?: { id: number; updatedAt: Date };
  feed?: Row | null;
  onSend?: (task: unknown) => void;
}) {
  const app = new Hono<any>();
  const inserted = options.inserted ?? { id: 42, updatedAt: new Date("2026-09-22T00:00:00.000Z") };

  const db = {
    query: {
      mediaAssets: { findMany: async () => options.assets ?? [] },
      feeds: { findFirst: async () => options.feed ?? null },
    },
    insert: () => ({
      values: () => ({ returning: async () => [inserted] }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("admin", options.admin);
    c.set("uid", options.uid ?? 1);
    c.set("env", {
      TASK_QUEUE: { send: async (task: unknown) => options.onSend?.(task) },
    });
    c.set("serverConfig", {
      get: async (key: string) =>
        key === "ai_writer.enabled" ? (options.writerEnabled ?? true) : undefined,
    });
    await next();
  });

  registerFeedAIComposeRoutes(app as any);
  return app;
}

const body = { topic: "聊聊本地优先软件", assets: [] };

describe("POST /ai-compose", () => {
  it("rejects a non-admin", async () => {
    const res = await buildApp({ admin: false }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(403);
  });

  it("rejects an empty topic", async () => {
    const res = await buildApp({ admin: true }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify({ topic: "", assets: [] }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown asset id", async () => {
    const res = await buildApp({ admin: true, assets: [] }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify({ topic: "选题", assets: [{ id: "nope", note: "" }] }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  it("refuses when the writer is disabled", async () => {
    const res = await buildApp({ admin: true, writerEnabled: false }).request("/ai-compose", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  it("queues the task and returns the placeholder id", async () => {
    const sent: unknown[] = [];
    const res = await buildApp({ admin: true, onSend: (task) => sent.push(task) }).request(
      "/ai-compose",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 42, status: "pending" });
    expect(sent.length).toBe(1);
  });

  it("normalizes an unrecognized length rather than failing", async () => {
    const sent: any[] = [];
    const res = await buildApp({ admin: true, onSend: (task) => sent.push(task) }).request(
      "/ai-compose",
      {
        method: "POST",
        body: JSON.stringify({ ...body, length: "enormous" }),
        headers: { "Content-Type": "application/json" },
      },
    );

    expect(res.status).toBe(202);
    expect(sent[0].payload.length).toBe("medium");
  });
});

describe("GET /:id/ai-compose-status", () => {
  it("rejects a non-admin", async () => {
    const res = await buildApp({ admin: false }).request("/42/ai-compose-status");
    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing feed", async () => {
    const res = await buildApp({ admin: true, feed: null }).request("/42/ai-compose-status");
    expect(res.status).toBe(404);
  });

  it("returns the stored status and error", async () => {
    const app = buildApp({
      admin: true,
      feed: { ai_compose_status: "failed", ai_compose_error: "AI 返回了空响应" },
    });

    const res = await app.request("/42/ai-compose-status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "failed", error: "AI 返回了空响应" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/services/__tests__/feed-ai-compose-routes.test.ts`
Expected: FAIL，`registerFeedAIComposeRoutes` 不存在

- [ ] **Step 3: 在 `feed-ai-compose.ts` 追加路由**

补充 import：

```typescript
import { feedAIComposeSchema } from "@rin/api";
import type { CreateAIComposeRequest } from "@rin/api";
import type { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { adminOnly, withJsonBody } from "../core/route-boundaries";
```

在文件末尾追加：

```typescript
export function registerFeedAIComposeRoutes(app: Hono<{ Variables: Variables }>) {
    app.post(
        "/ai-compose",
        adminOnly(
            withJsonBody<CreateAIComposeRequest>(feedAIComposeSchema, async (c, body) => {
                const db = c.get("db");
                const env = c.get("env");
                const uid = c.get("uid");
                const serverConfig = c.get("serverConfig");

                if (!uid) {
                    return c.text("User ID is required", 400);
                }

                const writerConfig = await getAIWriterConfig(serverConfig);
                if (!writerConfig.enabled) {
                    return c.text("AI writer is not enabled", 400);
                }

                const assetResult = await loadComposeAssets(db, body.assets);
                if (!assetResult.ok) {
                    return c.text(`Unknown media asset: ${assetResult.missing.join(", ")}`, 400);
                }

                const now = new Date();
                const listed = body.listed ?? true;

                const rows = await db
                    .insert(feeds)
                    .values({
                        title: body.topic,
                        content: "",
                        summary: "",
                        ai_summary: "",
                        ai_summary_status: "idle",
                        ai_summary_error: "",
                        ai_compose_status: "pending",
                        ai_compose_error: "",
                        uid,
                        alias: null,
                        listed: listed ? 1 : 0,
                        draft: 1,
                        createdAt: now,
                        updatedAt: now,
                    })
                    .returning({ id: feeds.id, updatedAt: feeds.updatedAt });

                const placeholder = rows[0];
                if (!placeholder) {
                    return c.text("Failed to create the placeholder article", 500);
                }

                const enqueued = await enqueueFeedAICompose(env, {
                    feedId: placeholder.id,
                    expectedUpdatedAtUnix: Math.floor(placeholder.updatedAt.getTime() / 1000),
                    topic: body.topic,
                    assets: body.assets,
                    length: normalizeComposeLength(body.length),
                    style: body.style,
                    listed,
                });

                if (!enqueued.ok) {
                    await db
                        .update(feeds)
                        .set(buildStatusUpdate("failed", { ai_compose_error: enqueued.error }))
                        .where(eq(feeds.id, placeholder.id));
                    return c.text(enqueued.error, 500);
                }

                return c.json({ id: placeholder.id, status: "pending" as const }, 202);
            }),
            { message: "Permission denied", status: 403 },
        ),
    );

    // Deliberately not folded into GET /feed/:id: that route is cached, so a
    // poller would keep reading a stale snapshot, and it returns the whole row
    // to every visitor.
    app.get(
        "/:id/ai-compose-status",
        adminOnly(
            async (c) => {
                const db = c.get("db");
                const id = Number.parseInt(c.req.param("id"), 10);

                if (!Number.isFinite(id)) {
                    return c.text("Invalid id", 400);
                }

                const feed = await db.query.feeds.findFirst({ where: eq(feeds.id, id) });
                if (!feed) {
                    return c.text("Not found", 404);
                }

                return c.json({
                    status: feed.ai_compose_status,
                    error: feed.ai_compose_error,
                });
            },
            { message: "Permission denied", status: 403 },
        ),
    );
}
```

- [ ] **Step 4: 在 `feed.ts` 挂载路由并裁掉错误字段**

在 `server/src/services/feed.ts` 顶部 import 区追加：

```typescript
import { registerFeedAIComposeRoutes } from "./feed-ai-compose";
```

在 `FeedService()` 函数体内、`app.post('/', ...)` 之前加一行：

```typescript
    registerFeedAIComposeRoutes(app);
```

> **必须在 `app.post('/:id', ...)`（`server/src/services/feed.ts:383`）之前注册**，否则 `POST /ai-compose` 会被那条路由当成「更新 id 为 ai-compose 的文章」吃掉。挂在 `FeedService()` 函数体最前面即可。
>
> （`GET /:id` 是另一个方法，捕不走 POST；`GET /:id/ai-compose-status` 是两段路径，与单段的 `GET /:id` 也不冲突。真正的风险只有 `app.post('/:id')` 一条。）

然后把详情路由末尾（`server/src/services/feed.ts:287`）的：

```typescript
        return c.json({ ...other, hashtags: hashtags_flatten, pv, uv });
```

改为：

```typescript
        // Provider error text can carry an API status line or a self-hosted
        // api_url, so it stays admin-only.
        const { ai_compose_error, ai_summary_error, ...publicFields } = other as Record<string, unknown>;
        const visible = admin ? other : publicFields;

        return c.json({ ...visible, hashtags: hashtags_flatten, pv, uv });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun run test:server && bun run check`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/services/feed-ai-compose.ts server/src/services/feed.ts server/src/services/__tests__/feed-ai-compose-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(feed): expose the AI compose endpoints

Status polling gets its own uncached admin-only route, because the feed
detail route is cached and would serve a stale snapshot forever.

Also stops the detail route from handing every visitor ai_summary_error
and ai_compose_error, which can carry an API status line or a
self-hosted api_url.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 前端 API 客户端方法

**Files:**
- Modify: `client/src/api/client.ts:306`（`FeedAPI` 类内追加两个方法）

**Interfaces:**
- Consumes: Task 1 的 `CreateAIComposeRequest`、`CreateAIComposeResponse`、`AIComposeStatusResponse`
- Produces:
  - `client.feed.aiCompose(body: CreateAIComposeRequest): Promise<ApiResponse<CreateAIComposeResponse>>`
  - `client.feed.aiComposeStatus(id: number): Promise<ApiResponse<AIComposeStatusResponse>>`

- [ ] **Step 1: 追加方法**

在 `client/src/api/client.ts` 顶部的类型 import 中加入 `AIComposeStatusResponse`、`CreateAIComposeRequest`、`CreateAIComposeResponse`（该文件已从 `@rin/api` 批量导入类型，按字母序插入）。

在 `class FeedAPI` 内追加：

```typescript
  // POST /api/feed/ai-compose
  async aiCompose(body: CreateAIComposeRequest): Promise<ApiResponse<CreateAIComposeResponse>> {
    return this.http.post<CreateAIComposeResponse>("/api/feed/ai-compose", body);
  }

  // GET /api/feed/:id/ai-compose-status
  async aiComposeStatus(id: number): Promise<ApiResponse<AIComposeStatusResponse>> {
    return this.http.get<AIComposeStatusResponse>(`/api/feed/${id}/ai-compose-status`);
  }
```

- [ ] **Step 2: 类型检查**

Run: `bun run check`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add client/src/api/client.ts
git commit -m "$(cat <<'EOF'
feat(client): add AI compose API methods

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 素材选择器组件

本模块前端的主要工作量。独立成组件是因为媒体库页面将来大概率复用。

**Files:**
- Create: `client/src/components/media-picker.tsx`
- Test: `client/src/components/__tests__/media-picker.test.ts`

**Interfaces:**
- Consumes: `client.media.list`（既有）、`MediaAsset`（`@rin/api`）
- Produces:
  - `type PickedAsset = { id: string; note: string }`
  - `function togglePickedAsset(picked: PickedAsset[], id: string): PickedAsset[]`
  - `function setPickedNote(picked: PickedAsset[], id: string, note: string): PickedAsset[]`
  - `function MediaPicker({ value, onChange, className }: { value: PickedAsset[]; onChange: (next: PickedAsset[]) => void; className?: string }): JSX.Element`

- [ ] **Step 1: 写失败的测试**

创建 `client/src/components/__tests__/media-picker.test.ts`（只测纯函数，不挂 DOM）：

```typescript
import { describe, expect, it } from "bun:test";
import { setPickedNote, togglePickedAsset, type PickedAsset } from "../media-picker";

describe("togglePickedAsset", () => {
  it("appends a newly picked asset with an empty note", () => {
    expect(togglePickedAsset([], "a")).toEqual([{ id: "a", note: "" }]);
  });

  it("removes an asset that was already picked", () => {
    expect(togglePickedAsset([{ id: "a", note: "n" }], "a")).toEqual([]);
  });

  it("keeps the order the admin picked in, since it is the order shown to the model", () => {
    const picked = togglePickedAsset(togglePickedAsset([], "a"), "b");
    expect(picked.map((asset) => asset.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const original: PickedAsset[] = [{ id: "a", note: "n" }];
    togglePickedAsset(original, "b");
    expect(original).toEqual([{ id: "a", note: "n" }]);
  });
});

describe("setPickedNote", () => {
  it("updates only the matching asset", () => {
    const picked: PickedAsset[] = [
      { id: "a", note: "" },
      { id: "b", note: "" },
    ];

    expect(setPickedNote(picked, "b", "说明")).toEqual([
      { id: "a", note: "" },
      { id: "b", note: "说明" },
    ]);
  });

  it("is a no-op for an unknown id", () => {
    const picked: PickedAsset[] = [{ id: "a", note: "" }];
    expect(setPickedNote(picked, "zzz", "说明")).toEqual(picked);
  });

  it("does not mutate the input array", () => {
    const original: PickedAsset[] = [{ id: "a", note: "" }];
    setPickedNote(original, "a", "说明");
    expect(original).toEqual([{ id: "a", note: "" }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test client/src/components/__tests__/media-picker.test.ts`
Expected: FAIL，模块 `../media-picker` 不存在

- [ ] **Step 3: 实现 `client/src/components/media-picker.tsx`**

```tsx
import type { MediaAsset } from "@rin/api";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";

export type PickedAsset = {
  id: string;
  note: string;
};

/** Pure so the ordering rule can be tested without mounting the component. */
export function togglePickedAsset(picked: PickedAsset[], id: string): PickedAsset[] {
  return picked.some((asset) => asset.id === id)
    ? picked.filter((asset) => asset.id !== id)
    // Append, never re-sort: this order is what the model is shown as [[media:N]].
    : [...picked, { id, note: "" }];
}

export function setPickedNote(picked: PickedAsset[], id: string, note: string): PickedAsset[] {
  return picked.map((asset) => (asset.id === id ? { ...asset, note } : asset));
}

export function MediaPicker({
  value,
  onChange,
  className,
}: {
  value: PickedAsset[];
  onChange: (next: PickedAsset[]) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    client.media
      .list({ page: 1, limit: 50 })
      .then(({ data, error: requestError }) => {
        if (cancelled) return;
        if (requestError) {
          setError(String(requestError.value ?? t("media.load_failed")));
        } else {
          setAssets(data?.data ?? []);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const pickedIndex = new Map(value.map((asset, index) => [asset.id, index]));

  if (loading) {
    return (
      <div className={`flex justify-center py-6 ${className ?? ""}`}>
        <ReactLoading type="spin" height={24} width={24} />
      </div>
    );
  }

  if (error) {
    return <p className={`py-4 text-sm text-red-500 ${className ?? ""}`}>{error}</p>;
  }

  if (assets.length === 0) {
    return (
      <p className={`py-4 text-sm t-secondary ${className ?? ""}`}>
        {t("ai_compose.assets.empty")}
      </p>
    );
  }

  return (
    <div className={className}>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {assets.map((asset) => {
          const order = pickedIndex.get(asset.id);
          const picked = order !== undefined;

          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => onChange(togglePickedAsset(value, asset.id))}
              aria-pressed={picked}
              className={`relative aspect-square overflow-hidden rounded-xl border transition-colors ${
                picked
                  ? "border-theme ring-2 ring-theme"
                  : "border-black/10 hover:border-theme/50 dark:border-white/10"
              }`}
            >
              {asset.type === "image" ? (
                <img
                  src={asset.playbackUrl}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-secondary text-2xl">
                  <i
                    className={asset.type === "video" ? "ri-film-line" : "ri-volume-up-line"}
                    aria-hidden="true"
                  />
                </span>
              )}
              {picked && (
                <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-theme text-xs font-medium text-white">
                  {order + 1}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {value.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-xs t-secondary">{t("ai_compose.assets.note_hint")}</p>
          {value.map((picked, index) => (
            <div key={picked.id} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-sm t-secondary">{index + 1}.</span>
              <input
                type="text"
                value={picked.note}
                onChange={(event) => onChange(setPickedNote(value, picked.id, event.target.value))}
                placeholder={t("ai_compose.assets.note_placeholder")}
                className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-theme dark:border-white/10"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

> 上面的调用已对照 `client/src/api/client.ts:518` 核实无误：`list(params?: { page?: number; limit?: number }): Promise<ApiResponse<MediaLibraryResponse>>`，而 `MediaLibraryResponse.data` 是 `MediaAsset[]`。**照写即可，不要改动 `MediaAPI`。**

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test client/src/components/__tests__/media-picker.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add client/src/components/media-picker.tsx client/src/components/__tests__/media-picker.test.ts
git commit -m "$(cat <<'EOF'
feat(client): add a media picker for AI article composition

Pick order is preserved rather than sorted, because it becomes the
[[media:N]] numbering the model is shown.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: 写作页生成面板与状态轮询

**Files:**
- Create: `client/src/page/writing-ai-compose.tsx`
- Create: `client/src/page/__tests__/writing-ai-compose.test.ts`
- Modify: `client/src/page/writing.tsx:330`（渲染区插入面板）

**Interfaces:**
- Consumes: Task 9 的 `client.feed.aiCompose`/`aiComposeStatus`；Task 10 的 `MediaPicker`/`PickedAsset`
- Produces:
  - `const COMPOSE_POLL_INTERVAL_MS = 3000`
  - `const COMPOSE_POLL_TIMEOUT_MS = 300000`
  - `function nextPollDecision(input: { status: string; elapsedMs: number }): "continue" | "done" | "failed" | "timeout"`
  - `function AIComposePanel(): JSX.Element`

- [ ] **Step 1: 写失败的测试**

创建 `client/src/page/__tests__/writing-ai-compose.test.ts`：

```typescript
import { describe, expect, it } from "bun:test";
import {
  COMPOSE_POLL_INTERVAL_MS,
  COMPOSE_POLL_TIMEOUT_MS,
  nextPollDecision,
} from "../writing-ai-compose";

describe("nextPollDecision", () => {
  it("keeps polling while the task is queued or running", () => {
    expect(nextPollDecision({ status: "pending", elapsedMs: 1000 })).toBe("continue");
    expect(nextPollDecision({ status: "processing", elapsedMs: 1000 })).toBe("continue");
  });

  it("stops on completion", () => {
    expect(nextPollDecision({ status: "completed", elapsedMs: 1000 })).toBe("done");
  });

  it("stops on failure", () => {
    expect(nextPollDecision({ status: "failed", elapsedMs: 1000 })).toBe("failed");
  });

  it("reports a timeout rather than a failure once the budget is spent", () => {
    expect(nextPollDecision({ status: "processing", elapsedMs: COMPOSE_POLL_TIMEOUT_MS + 1 })).toBe(
      "timeout",
    );
  });

  it("prefers a terminal status over a timeout", () => {
    expect(nextPollDecision({ status: "completed", elapsedMs: COMPOSE_POLL_TIMEOUT_MS + 1 })).toBe(
      "done",
    );
    expect(nextPollDecision({ status: "failed", elapsedMs: COMPOSE_POLL_TIMEOUT_MS + 1 })).toBe(
      "failed",
    );
  });

  it("keeps polling on an unexpected status instead of giving up", () => {
    expect(nextPollDecision({ status: "idle", elapsedMs: 1000 })).toBe("continue");
  });

  it("polls often enough to feel live but not busily", () => {
    expect(COMPOSE_POLL_INTERVAL_MS).toBe(3000);
    expect(COMPOSE_POLL_TIMEOUT_MS).toBe(300000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test client/src/page/__tests__/writing-ai-compose.test.ts`
Expected: FAIL，模块 `../writing-ai-compose` 不存在

- [ ] **Step 3: 实现 `client/src/page/writing-ai-compose.tsx`**

```tsx
import type { ComposeLength } from "@rin/api";
import { FlatPanel } from "@rin/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactLoading from "react-loading";
import { client } from "../app/runtime";
import { useAlert } from "../components/dialog";
import { MediaPicker, type PickedAsset } from "../components/media-picker";

export const COMPOSE_POLL_INTERVAL_MS = 3000;
export const COMPOSE_POLL_TIMEOUT_MS = 300000;

/** Pure so the timeout-is-not-a-failure rule can be tested directly. */
export function nextPollDecision(input: { status: string; elapsedMs: number }):
  | "continue"
  | "done"
  | "failed"
  | "timeout" {
  if (input.status === "completed") return "done";
  if (input.status === "failed") return "failed";
  if (input.elapsedMs > COMPOSE_POLL_TIMEOUT_MS) return "timeout";
  return "continue";
}

const LENGTHS: ComposeLength[] = ["short", "medium", "long"];

export function AIComposePanel() {
  const { t } = useTranslation();
  const { showAlert, AlertUI } = useAlert();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [length, setLength] = useState<ComposeLength>("medium");
  const [assets, setAssets] = useState<PickedAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const cancelled = useRef(false);

  async function poll(id: number) {
    const startedAt = Date.now();

    while (!cancelled.current) {
      await new Promise((resolve) => setTimeout(resolve, COMPOSE_POLL_INTERVAL_MS));

      const { data, error } = await client.feed.aiComposeStatus(id);
      if (error) {
        setBusy(false);
        showAlert(String(error.value ?? t("ai_compose.status_failed")));
        return;
      }

      const decision = nextPollDecision({
        status: data?.status ?? "pending",
        elapsedMs: Date.now() - startedAt,
      });

      setPhase(data?.status ?? "pending");

      if (decision === "done") {
        setBusy(false);
        window.location.href = `/feed/${id}`;
        return;
      }

      if (decision === "failed") {
        setBusy(false);
        showAlert(
          `${data?.error || t("ai_compose.failed")}\n\n${t("ai_compose.failed_draft_hint")}`,
          () => {
            window.location.href = `/writing/${id}`;
          },
        );
        return;
      }

      if (decision === "timeout") {
        setBusy(false);
        showAlert(t("ai_compose.timeout"));
        return;
      }
    }
  }

  async function submit() {
    if (busy) return;

    if (!topic.trim()) {
      showAlert(t("ai_compose.topic_empty"));
      return;
    }

    setBusy(true);
    setPhase("pending");
    cancelled.current = false;

    const { data, error } = await client.feed.aiCompose({
      topic: topic.trim(),
      assets,
      length,
      style: style.trim() || undefined,
    });

    if (error || !data) {
      setBusy(false);
      showAlert(String(error?.value ?? t("ai_compose.failed")));
      return;
    }

    void poll(data.id);
  }

  return (
    <FlatPanel className="p-4 sm:p-5 md:p-6">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-theme/70">
            {t("ai_compose.title")}
          </p>
          <p className="mt-2 text-sm t-secondary">{t("ai_compose.desc")}</p>
        </div>
        <i className={open ? "ri-arrow-up-s-line ri-lg" : "ri-arrow-down-s-line ri-lg"} aria-hidden="true" />
      </button>

      {open && (
        <div className="mt-5 flex flex-col gap-4">
          <input
            type="text"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder={t("ai_compose.topic_placeholder")}
            className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-theme dark:border-white/10"
          />

          <div className="flex flex-wrap items-center gap-2">
            {LENGTHS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLength(option)}
                className={`rounded-xl px-3 py-2 text-sm transition-colors ${
                  length === option ? "bg-theme text-white" : "bg-secondary t-secondary"
                }`}
              >
                {t(`ai_compose.length.${option}`)}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            placeholder={t("ai_compose.style_placeholder")}
            className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-theme dark:border-white/10"
          />

          <MediaPicker value={assets} onChange={setAssets} />

          <p className="text-xs t-secondary">{t("ai_compose.publish_warning")}</p>

          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-theme px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-theme-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <ReactLoading type="spin" height={16} width={16} />}
            <span>{busy ? t(`ai_compose.phase.${phase || "pending"}`) : t("ai_compose.submit")}</span>
          </button>
        </div>
      )}

      <AlertUI />
    </FlatPanel>
  );
}
```

- [ ] **Step 4: 挂到写作页**

在 `client/src/page/writing.tsx` 的 import 区追加：

```typescript
import { AIComposePanel } from './writing-ai-compose';
```

在返回的 JSX 中，`{MetaInput({ className: "p-4 sm:p-5 md:p-6" })}` **之前**插入一行：

```tsx
        {id === undefined && <AIComposePanel />}
```

> 只在新建文章时显示：编辑既有文章时这个面板没有意义。

- [ ] **Step 5: 运行测试确认通过**

Run: `bun run test:client && bun run check`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add client/src/page/writing-ai-compose.tsx client/src/page/__tests__/writing-ai-compose.test.ts client/src/page/writing.tsx
git commit -m "$(cat <<'EOF'
feat(client): add the AI compose panel to the writing page

A polling timeout reports that generation is still running rather than
claiming failure, since the queue consumer has a far longer budget than
the poller does.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: 设置页 `ai_writer` 配置与全部 i18n 文案

**Files:**
- Create: `client/src/page/settings-ai-writer.tsx`
- Modify: `client/src/page/settings.tsx`（渲染新卡片、接入保存）
- Modify: `client/public/locales/{zh-CN,zh-TW,en,ja}/translation.json`
- Modify: `server/src/services/config.ts`（把 `ai_writer.*` 纳入服务端配置的读写白名单）

**Interfaces:**
- Consumes: Task 1 的 `AI_WRITER_CONFIG_KEYS`；Task 3 的 `getAIWriterConfigForFrontend`/`setAIWriterConfig`
- Produces: `function AIWriterSettings({ value, onChange }): JSX.Element`

- [ ] **Step 1: 确认既有配置读写路径**

Run: `grep -n "AI_CONFIG_KEYS\|SENSITIVE_SERVER_CONFIG_FIELDS\|getAIConfigForFrontend\|setAIConfig" server/src/services/config.ts`
Expected: 输出 `ai_summary.*` 在服务端配置端点中被读写与脱敏的具体位置。**按照完全相同的方式**接入 `ai_writer.*` —— 不要另建端点。

- [ ] **Step 2: 按上一步的结果接入 `ai_writer.*`**

在 `server/src/services/config.ts` 中，凡出现 `AI_CONFIG_KEYS` 的读写白名单处，一并加入 `AI_WRITER_CONFIG_KEYS`；凡调用 `getAIConfigForFrontend`/`setAIConfig` 处，按同一形状补上 `getAIWriterConfigForFrontend`/`setAIWriterConfig`。

- [ ] **Step 3: 补全四个语言的文案**

以下键需要加到 `client/public/locales/zh-CN/translation.json`、`zh-TW`、`en`、`ja` 四个文件（zh-CN 值如下，其余语言相应翻译）：

```json
{
  "ai_compose": {
    "title": "AI 写文章",
    "desc": "给一句话选题和素材，生成整篇文章并直接发布",
    "topic_placeholder": "一句话说明想写什么",
    "topic_empty": "请先填写选题",
    "style_placeholder": "风格（可选），例如：冷静克制、口语化",
    "submit": "生成并发布",
    "publish_warning": "生成成功后会直接公开发布，不经人工审阅。",
    "failed": "生成失败",
    "failed_draft_hint": "这篇稿子已保留为草稿，可以进去手动修改。",
    "status_failed": "查询生成状态失败",
    "timeout": "仍在生成中，稍后到文章列表查看。",
    "length": { "short": "短", "medium": "中", "long": "长" },
    "phase": { "pending": "排队中…", "processing": "生成中…" },
    "assets": {
      "empty": "媒体库里还没有素材",
      "note_hint": "给每个素材写一句说明，模型据此决定把它放在哪里。",
      "note_placeholder": "这个素材是什么"
    }
  },
  "settings": {
    "ai_writer": {
      "title": "AI 写作设置",
      "enable": { "title": "启用 AI 写作", "desc": "允许通过选题和素材生成整篇文章" },
      "inherit_hint": "供应商、模型、API Key、API URL 留空则继承 AI 总结设置。",
      "provider": { "title": "AI 供应商", "desc": "留空继承 AI 总结设置" },
      "model": { "title": "模型", "desc": "留空继承 AI 总结设置；写文章建议用更强的模型" },
      "api_key": { "title": "API Key", "desc": "留空继承 AI 总结设置", "set": "已设置", "placeholder_set": "输入新密钥以更新" },
      "api_url": { "title": "API URL", "desc": "留空继承 AI 总结设置" },
      "temperature": { "title": "Temperature", "desc": "越高越发散，默认 0.8" },
      "max_tokens": { "title": "Max Tokens", "desc": "单次生成的上限，默认 4000" },
      "system_prompt": { "title": "系统提示词", "desc": "留空则使用内置的中文写作提示词" }
    }
  }
}
```

> `settings.ai_writer` 要合并进已有的 `settings` 对象，不要覆盖它。`ai_compose` 是顶层新键。

- [ ] **Step 4: 实现设置卡片**

创建 `client/src/page/settings-ai-writer.tsx`，**照搬 `client/src/page/settings-ai.tsx` 的结构**（`SettingsCard` / `SettingsCardHeader` / `SettingsCardBody` / `SettingsCardRow` + `Switch`），字段为：enabled、provider、model、api_key、api_url、temperature、max_tokens、system_prompt。

要点：
- 在卡片头部下方显著展示 `settings.ai_writer.inherit_hint`
- `api_key` 已设置时显示 `settings.ai_writer.api_key.set` 徽标，输入框 placeholder 用 `placeholder_set`
- `temperature`、`max_tokens` 用 `type="number"`
- `system_prompt` 用 `<textarea>`
- **不要**复制 `settings-ai.tsx` 里的「测试模型」按钮 —— 该按钮打的是 `/api/config/test-ai`，测的是 `ai_summary` 配置，放在这里会误导

然后在 `client/src/page/settings.tsx` 中，紧接 `AISummarySettings` 之后渲染 `AIWriterSettings`，并把它的字段接入该页既有的「脏值收集 + 保存」机制（与 `AISummarySettings` 完全同一套，不要另写保存逻辑）。

- [ ] **Step 5: 运行全部测试与类型检查**

Run: `bun run test && bun run check`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add client/src/page/settings-ai-writer.tsx client/src/page/settings.tsx client/public/locales server/src/services/config.ts
git commit -m "$(cat <<'EOF'
feat(settings): add the AI writer configuration card

Blank credential fields inherit from the summary settings, which the
card states up front so an empty field does not read as broken.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: 端到端手工验证

自动化测试覆盖不到「队列真的被消费了」这件事，需要跑一次真环境。

**Files:** 无改动（若发现问题，修复归入对应 Task 的后续提交）

- [ ] **Step 1: 启动带队列的本地开发环境**

Run: `bun run db:migrate && bun dev`
Expected: 客户端与 Worker 均启动；Worker 监听 11498

- [ ] **Step 2: 配置 AI 写作**

在设置页开启「AI 总结」并填入可用的 provider / model / API Key，再开启「AI 写作」，**其余字段留空**。保存。

Expected: 保存成功；刷新后 API Key 仍显示「已设置」（验证空串跳过写入的规则）

- [ ] **Step 3: 上传两个素材**

在媒体库上传一张图片和一个视频。

- [ ] **Step 4: 生成一篇文章**

在写作页展开「AI 写文章」，填选题、选中两个素材并各写一句说明、选「中」，点击生成。

Expected:
- 按钮立刻进入「排队中…」并在数秒内变为「生成中…」
- 完成后跳转到 `/feed/:id`
- 文章已公开发布（非草稿）
- 图片以 `![说明](/api/media/.../playback)` 渲染、视频以播放器渲染
- 正文中**没有**残留的 `[[media:N]]`
- 标签已绑定
- 媒体库中两个素材的「所属文章」已指向这篇

- [ ] **Step 5: 验证格式闸门**

把 `ai_writer.max_tokens` 临时改成 `16`，再生成一次。

Expected: 状态变为 `failed`；弹出的错误提示说明正文过短；该稿**停在草稿**未公开；点击提示可跳到 `/writing/:id`

改回 `4000`。

- [ ] **Step 6: 验证错误信息不外泄**

把 API Key 改成一个无效值，生成一次使其失败。然后**登出**，以访客身份请求该草稿对应的公开文章详情接口。

Run: `curl -s http://localhost:11498/api/feed/<某篇已发布文章的 id> | python3 -m json.tool | grep -i error`
Expected: **无输出** —— `ai_summary_error` 与 `ai_compose_error` 均不在访客响应中

把 API Key 改回有效值。

- [ ] **Step 7: 提交验证记录（若有修复）**

若上述任一步骤暴露问题，修复后提交；若全部通过，无需提交。

---

## 自查结论

对照 spec 逐节核查的结果，以及需要执行者知道的两点：

**Spec 覆盖**：§3 模块边界 → Task 1/4/7/8；§4 数据模型 → Task 5；§5 数据流 → Task 7；§6.1 输出契约 → Task 4；§6.2 素材占位符 → Task 4；§6.3 格式闸门 → Task 4 + Task 7；§7.1 状态端点与泄露修复 → Task 8；§7.2 创建端点 → Task 8；§8.1 配置继承 → Task 1 + Task 3；§8.2 `ai.ts` 参数化 → Task 2；§9 前端 → Task 9/10/11；§10 测试 → 分散于各 Task。无遗漏。

**两处需要执行者留意的实现顺序**：

1. Task 8 中 `registerFeedAIComposeRoutes(app)` **必须在 `app.get('/:id', ...)` 之前调用**，否则 `/ai-compose` 会被 `/:id` 抢先匹配。
2. Task 1 中 `AI_WRITER_CONFIG_PREFIX` 的声明**必须在 `SENSITIVE_SERVER_CONFIG_FIELDS` 之前**，否则 TDZ 报错。

**Task 12 有意保留了一处自由度**：设置页的保存机制需要照搬 `settings.tsx` 里 `AISummarySettings` 的既有做法，而那套机制的具体形状没有在本计划中逐行复制 —— 因为照搬既有模式比照着一份可能已经过时的抄本更可靠。Step 1 的 `grep` 就是为此设置的。
