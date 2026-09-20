# 访问统计（Visitor Analytics）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Rin 增加仅管理员可见的站点级访问统计看板，并把现有文章 PV/UV 采集从 D1 请求路径迁移到 Cloudflare Workers Analytics Engine。

**Architecture:** 访问发生时在 `ctx.waitUntil()` 中调用 AE `writeDataPoint()`（非阻塞、零 D1 写入）；AE 保留 3 个月原始明细；复用现有 `*/20 * * * *` cron 每日把 AE 数据经 SQL API 聚合进 D1 的 `analytics_daily` / `analytics_dim_daily` 两张表以永久保留；看板通过四个 `adminOnly` 端点读取，其中三个读 D1、一个读 AE 做近期下钻。

**Tech Stack:** Cloudflare Workers + Workers Analytics Engine + D1、Drizzle ORM、Hono 风格 Router、React 18 + Wouter + TailwindCSS + i18next、`bun:test`、Bun 包管理、Turbo。

**Spec:** `docs/superpowers/specs/2026-09-20-visitor-analytics-design.md`

## Global Constraints

- 测试一律使用 `bun:test`，不得引入其他测试运行器。服务端测试放在 `server/src/**/__tests__/*.test.ts`。
- 文件名 kebab-case；组件 PascalCase；函数 camelCase；类型/接口 PascalCase；数据库表列 snake_case。
- 导入顺序：外部依赖在前（字母序），内部导入在后（字母序）。
- AE 单个数据点上限：20 blobs、20 doubles、**1 index**；blobs 合计 ≤16 KB；index ≤96 字节；单次 Worker 调用最多 250 个数据点。
- AE 数据保留期固定 3 个月，不可配置。
- D1 聚合数据**永久保留，不做清理**。
- AE 数据集名称固定为 `rin_analytics`，binding 名称固定为 `ANALYTICS`。
- 迁移文件沿用手工编号：本次为 `server/sql/0016.sql`，结尾必须有 `UPDATE \`info\` SET \`value\` = '16' WHERE \`key\` = 'migration_version';`，语句之间用 `--> statement-breakpoint` 分隔。
- 新增前端文案必须同时补齐四个语言文件：`client/public/locales/{en,zh-CN,zh-TW,ja}/translation.json`。
- 不引入任何第三方图表库；图表用内联 SVG 实现。
- 所有新增共享类型放 `packages/api`；共享包不得反向依赖 `client/` 或 `server/` 的应用模块。
- `days` 参数只接受 `7` / `30` / `90`，其他值回退 `30`；`hours` 只接受 `1` / `24`，其他值回退 `24`；`limit` 上限 100。
- AE 或 token 不可用时一律优雅降级，禁止抛出 HTTP 500。
- 提交信息遵循 conventional commits（`feat:` / `fix:` / `test:` / `chore:` / `docs:`）。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `scripts/ensure-wrangler-toml.ts` | 新增 `buildWranglerAnalyticsConfig()`，并在两个 toml 产出中拼入 |
| `cli/src/tasks/deploy-cf.ts` | 同上，部署路径的 toml 生成器 |
| `server/src/custom-env.d.ts` | `Env.ANALYTICS` 类型 |
| `server/sql/0016.sql` | 建两张新表、`DROP TABLE visits`、推进 migration_version |
| `server/src/db/schema.ts` | 新增 `analyticsDaily` / `analyticsDimDaily`，删除 `visits` |
| `server/src/utils/analytics.ts` | **采集**：bot 识别、设备识别、referrer 归一化、指纹、数据点构造、`recordPageView` |
| `server/src/utils/analytics-query.ts` | **AE SQL API 客户端**：配置检查、请求、降级错误 |
| `server/src/services/analytics-rollup.ts` | **cron 聚合**：游标推进、AE→D1 落盘、回写 `visit_stats` |
| `server/src/services/analytics.ts` | **HTTP 端点**：四个 `adminOnly` 路由 + 参数解析 |
| `packages/api/src/types.ts` | 共享响应类型 |
| `client/src/api/client.ts` | `AnalyticsAPI` 子客户端 |
| `client/src/components/analytics-charts.tsx` | 内联 SVG 折线图与横向条形图 |
| `client/src/page/analytics.tsx` | 看板页面组装 |

采集、查询、聚合、路由拆成四个文件而非一个 `analytics.ts`：它们的变更原因互不相同（维度调整 / CF API 变化 / 聚合口径 / 接口契约），且聚合与路由各自需要独立的测试夹具。

---

### Task 1: Analytics Engine 绑定与环境类型

**Files:**
- Modify: `scripts/ensure-wrangler-toml.ts`
- Modify: `cli/src/tasks/deploy-cf.ts`
- Modify: `server/src/custom-env.d.ts:33-47`
- Test: `scripts/__tests__/ensure-wrangler-toml.test.ts`
- Test: `cli/src/tasks/deploy-cf.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `buildWranglerAnalyticsConfig(): string`（两个文件各一份，互不导入——两个生成器本就各自维护自己的 toml 片段函数，见现有的 `buildWranglerStreamConfig`）
  - `Env.ANALYTICS?: AnalyticsEngineDataset`

**背景（实现者必读）：** `wrangler.toml` 不是手写的，它由两个生成器产出。`cli/src/tasks/deploy-cf.ts:147-150` 的注释记录了一个已发生过的 bug：生成的 toml 若省略某个绑定块，Cloudflare 面板上配置的同名绑定会在部署时被抹掉（R2 和旧的 IP2REGION 都踩过）。因此本任务必须同时改两个文件，缺一不可。

与 `[stream]` 不同，AE 绑定**无条件输出**，不加 `shouldEnable*` 开关：它免费、无副作用，条件判断只会多一条出错路径。

- [ ] **Step 1: 写失败测试（scripts 侧）**

在 `scripts/__tests__/ensure-wrangler-toml.test.ts` 末尾追加：

```ts
describe("buildWranglerAnalyticsConfig", () => {
  it("emits the analytics engine dataset binding", () => {
    const block = buildWranglerAnalyticsConfig();
    expect(block).toContain("[[analytics_engine_datasets]]");
    expect(block).toContain('binding = "ANALYTICS"');
    expect(block).toContain('dataset = "rin_analytics"');
  });
});

describe("analytics binding is always persisted", () => {
  it("appears in the placeholder toml", () => {
    expect(buildPlaceholderToml()).toContain("[[analytics_engine_datasets]]");
  });

  it("appears in the env-built toml", () => {
    const toml = buildWranglerTomlFromEnv({ R2_BUCKET_NAME: "rin" });
    expect(toml).toContain("[[analytics_engine_datasets]]");
  });
});
```

同时把 `buildWranglerAnalyticsConfig` 加进该文件顶部的 import 列表。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test scripts/__tests__/ensure-wrangler-toml.test.ts`
Expected: FAIL，报 `buildWranglerAnalyticsConfig` 不是导出成员。

- [ ] **Step 3: 实现（scripts 侧）**

在 `scripts/ensure-wrangler-toml.ts` 的 `buildWranglerStreamConfig` 之后新增：

```ts
/**
 * Workers Analytics Engine binding. Emitted unconditionally: the dataset is
 * free, and omitting the block would wipe a panel-configured binding on deploy
 * — same class of bug as R2 / [stream] / former IP2REGION.
 */
export function buildWranglerAnalyticsConfig(): string {
  return `
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "rin_analytics"
`;
}
```

在 `buildPlaceholderToml()` 返回的模板字符串末尾（`[[queues.consumers]]` 块之后）追加：

```
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "rin_analytics"
```

在 `buildWranglerTomlFromEnv()` 中，仿照 `const streamBlock = ...` 新增一行：

```ts
  const analyticsBlock = buildWranglerAnalyticsConfig();
```

并在该函数返回的模板字符串里，紧跟 `${streamBlock}` 之后插入 `${analyticsBlock}`。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test scripts/__tests__/ensure-wrangler-toml.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试（cli 侧）**

在 `cli/src/tasks/deploy-cf.test.ts` 末尾追加，并把 `buildWranglerAnalyticsConfig` 加入顶部 import：

```ts
describe("buildWranglerAnalyticsConfig", () => {
  it("emits the analytics engine dataset binding", () => {
    const block = buildWranglerAnalyticsConfig();
    expect(block).toContain("[[analytics_engine_datasets]]");
    expect(block).toContain('binding = "ANALYTICS"');
    expect(block).toContain('dataset = "rin_analytics"');
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `bun test cli/src/tasks/deploy-cf.test.ts`
Expected: FAIL，报导出不存在。

- [ ] **Step 7: 实现（cli 侧）**

在 `cli/src/tasks/deploy-cf.ts` 的 `buildWranglerStreamConfig` 之后新增（注意这个文件用 `stripIndent`）：

```ts
/**
 * Workers Analytics Engine binding, emitted unconditionally. See the [stream]
 * comment above for why an omitted block is a deploy-time hazard.
 */
export function buildWranglerAnalyticsConfig() {
  return stripIndent(`
    [[analytics_engine_datasets]]
    binding = "ANALYTICS"
    dataset = "rin_analytics"
  `);
}
```

然后在 `runCloudflareDeploy` 内部拼装 toml 的位置（`[ai]` 块附近，约第 337-358 行）把该函数的返回值拼进去，与 `buildWranglerStreamConfig()` 的用法保持一致。

- [ ] **Step 8: 运行测试确认通过**

Run: `bun test cli/src/tasks/deploy-cf.test.ts`
Expected: PASS

- [ ] **Step 9: 补 Env 类型**

在 `server/src/custom-env.d.ts` 的 `interface Env` 中，`STREAM?: StreamBinding;` 之后新增：

```ts
    /** Workers Analytics Engine dataset for page-view ingestion. Optional so
     *  that a missing binding degrades to "no analytics" instead of throwing. */
    ANALYTICS?: AnalyticsEngineDataset;
```

- [ ] **Step 10: 类型检查**

Run: `bun run check`
Expected: 通过（`AnalyticsEngineDataset` 由 `@cloudflare/workers-types` 提供；若报未定义，改为在同文件内声明最小接口 `interface AnalyticsEngineDataset { writeDataPoint(event: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void }`）。

- [ ] **Step 11: 提交**

```bash
git add scripts/ensure-wrangler-toml.ts scripts/__tests__/ensure-wrangler-toml.test.ts cli/src/tasks/deploy-cf.ts cli/src/tasks/deploy-cf.test.ts server/src/custom-env.d.ts
git commit -m "feat: persist Analytics Engine binding in both wrangler generators"
```

---

### Task 2: 数据库迁移与 schema

**Files:**
- Create: `server/sql/0016.sql`
- Modify: `server/src/db/schema.ts:42-56`

**Interfaces:**
- Consumes: 无
- Produces:
  - `analyticsDaily` 表模型：`{ date: string; feedId: number; pv: number; uv: number }`
  - `analyticsDimDaily` 表模型：`{ date: string; dimType: string; dimValue: string; count: number }`
  - `visits` 表与其 Drizzle 定义被**删除**

**背景：** `visits` 表全仓库只有 INSERT、没有任何 SELECT，且是明文 IP 唯一的落盘点。`visit_stats` 保留（文章页的公开 pv/uv 仍读它），但其 `hll_data` 列从 Task 3 起停止更新。

- [ ] **Step 1: 写迁移文件**

创建 `server/sql/0016.sql`：

```sql
CREATE TABLE `analytics_daily` (
	`date` text NOT NULL,
	`feed_id` integer NOT NULL,
	`pv` integer DEFAULT 0 NOT NULL,
	`uv` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `feed_id`)
);
--> statement-breakpoint
CREATE TABLE `analytics_dim_daily` (
	`date` text NOT NULL,
	`dim_type` text NOT NULL,
	`dim_value` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `dim_type`, `dim_value`)
);
--> statement-breakpoint
CREATE INDEX `analytics_daily_date_idx` ON `analytics_daily` (`date`);
--> statement-breakpoint
CREATE INDEX `analytics_dim_daily_date_type_idx` ON `analytics_dim_daily` (`date`,`dim_type`);
--> statement-breakpoint
DROP TABLE IF EXISTS `visits`;
--> statement-breakpoint
UPDATE `info` SET `value` = '16' WHERE `key` = 'migration_version';
```

- [ ] **Step 2: 更新 Drizzle schema**

在 `server/src/db/schema.ts` 中**删除**整个 `export const visits = sqliteTable("visits", {...})` 定义（第 42-49 行），并在 `visitStats` 定义之后新增：

```ts
export const analyticsDaily = sqliteTable("analytics_daily", {
    date: text("date").notNull(),
    feedId: integer("feed_id").notNull(),
    pv: integer("pv").default(0).notNull(),
    uv: integer("uv").default(0).notNull(),
}, (table) => ({
    pk: primaryKey({ columns: [table.date, table.feedId] }),
    dateIdx: index("analytics_daily_date_idx").on(table.date),
}));

export const analyticsDimDaily = sqliteTable("analytics_dim_daily", {
    date: text("date").notNull(),
    dimType: text("dim_type").notNull(),
    dimValue: text("dim_value").notNull(),
    count: integer("count").default(0).notNull(),
}, (table) => ({
    pk: primaryKey({ columns: [table.date, table.dimType, table.dimValue] }),
    dateTypeIdx: index("analytics_dim_daily_date_type_idx").on(table.date, table.dimType),
}));
```

把 `primaryKey` 加入该文件顶部的 `drizzle-orm/sqlite-core` 导入：

```ts
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
```

- [ ] **Step 3: 清理 visits 的残留引用**

Run: `grep -rn "visits" server/src --include=*.ts`
Expected: 只剩 `server/src/services/feed.ts` 的 import 与两处使用。**本步骤先不改 feed.ts**（Task 3 会整段替换）——但必须确认没有其它文件引用 `visits`。若 grep 出现 feed.ts 之外的文件，把它们一并处理后再继续。

- [ ] **Step 4: 本地迁移并类型检查**

Run: `bun run db:migrate && bun run check`
Expected: 迁移成功；`check` 此时**预期在 `feed.ts` 报 `visits` 未定义**，这是正常的，Task 3 修复。若除此之外还有其它错误，先解决。

- [ ] **Step 5: 提交**

```bash
git add server/sql/0016.sql server/src/db/schema.ts
git commit -m "feat: add analytics rollup tables and drop write-only visits table"
```

---

### Task 3: 采集层 + 接入文章详情路由

**Files:**
- Create: `server/src/utils/analytics.ts`
- Modify: `server/src/services/feed.ts:261-305`（整段替换）、`server/src/services/feed.ts:12,21`（import）
- Test: `server/src/utils/__tests__/analytics.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Env.ANALYTICS`
- Produces:
  ```ts
  export type DeviceType = "mobile" | "desktop";
  export const ANALYTICS_SALT_SEED_KEY = "analytics.salt_seed";
  export interface PageViewDataPoint {
      indexes: [string];
      blobs: string[];
      doubles: [number];
  }
  export function isBotUserAgent(userAgent: string): boolean;
  export function detectDevice(userAgent: string): DeviceType;
  export function normalizeReferrer(referrer: string | null | undefined, selfHost: string): string;
  export function utcDateString(now: Date): string;
  export async function visitorFingerprint(input: {
      ip: string; userAgent: string; feedId: number; salt: string;
  }): Promise<string>;
  export function buildPageViewDataPoint(input: {
      feedId: number; title: string | null; path: string; referrerHost: string;
      country: string; city: string; device: DeviceType; fingerprint: string;
  }): PageViewDataPoint;
  export async function resolveDailySalt(
      serverConfig: { getOrDefault<T>(key: string, defaultValue: T): Promise<T>; set(key: string, value: unknown, save?: boolean): Promise<void> },
      date: string,
  ): Promise<string>;
  export async function recordPageView(c: AppContext, options: { feedId: number; title: string | null }): Promise<void>;
  ```

**设计说明（实现者必读）：** 纯函数（bot 识别、设备、referrer、指纹、数据点构造）与副作用函数（`recordPageView`）分离，测试只针对纯函数和降级分支，不需要模拟整个 Hono Context。

**指纹口径：** `SHA-256(ip + "|" + userAgent + "|" + feedId + "|" + salt)` 取前 16 位 hex。`salt` 由存于 `serverConfig` 的一次性随机种子与 UTC 日期派生，**每日轮换**，因此跨天无法关联同一访客，也无法反推 IP。副作用是月度 UV 只能取各日之和（高估的近似值），Task 7 的 UI 必须标注。

- [ ] **Step 1: 写失败测试**

创建 `server/src/utils/__tests__/analytics.test.ts`：

```ts
import { describe, expect, it } from "bun:test";
import {
    buildPageViewDataPoint,
    detectDevice,
    isBotUserAgent,
    normalizeReferrer,
    resolveDailySalt,
    utcDateString,
    visitorFingerprint,
} from "../analytics";

describe("isBotUserAgent", () => {
    it("detects common crawlers", () => {
        expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
        expect(isBotUserAgent("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(true);
        expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    });

    it("treats real browsers as non-bots", () => {
        expect(isBotUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120")).toBe(false);
    });

    it("treats an empty user agent as a bot", () => {
        expect(isBotUserAgent("")).toBe(true);
    });
});

describe("detectDevice", () => {
    it("classifies mobile user agents", () => {
        expect(detectDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148")).toBe("mobile");
        expect(detectDevice("Mozilla/5.0 (Linux; Android 14) Mobile Safari")).toBe("mobile");
    });

    it("defaults to desktop", () => {
        expect(detectDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120")).toBe("desktop");
    });
});

describe("normalizeReferrer", () => {
    it("keeps only the host", () => {
        expect(normalizeReferrer("https://www.google.com/search?q=rin", "blog.example.com")).toBe("www.google.com");
    });

    it("maps same-origin referrers to direct", () => {
        expect(normalizeReferrer("https://blog.example.com/feed/1", "blog.example.com")).toBe("direct");
    });

    it("maps missing or malformed referrers to direct", () => {
        expect(normalizeReferrer(null, "blog.example.com")).toBe("direct");
        expect(normalizeReferrer("", "blog.example.com")).toBe("direct");
        expect(normalizeReferrer("not a url", "blog.example.com")).toBe("direct");
    });
});

describe("utcDateString", () => {
    it("formats as UTC YYYY-MM-DD regardless of local offset", () => {
        expect(utcDateString(new Date("2026-09-20T23:59:59.000Z"))).toBe("2026-09-20");
        expect(utcDateString(new Date("2026-09-21T00:00:00.000Z"))).toBe("2026-09-21");
    });
});

describe("visitorFingerprint", () => {
    const base = { ip: "1.2.3.4", userAgent: "Chrome/120", feedId: 7 };

    it("is stable for the same input and salt", async () => {
        const a = await visitorFingerprint({ ...base, salt: "salt-a" });
        const b = await visitorFingerprint({ ...base, salt: "salt-a" });
        expect(a).toBe(b);
        expect(a).toHaveLength(16);
    });

    it("changes when the daily salt rotates", async () => {
        const day1 = await visitorFingerprint({ ...base, salt: "salt-a" });
        const day2 = await visitorFingerprint({ ...base, salt: "salt-b" });
        expect(day1).not.toBe(day2);
    });

    it("differs between visitors on the same day", async () => {
        const a = await visitorFingerprint({ ...base, salt: "salt-a" });
        const b = await visitorFingerprint({ ...base, ip: "5.6.7.8", salt: "salt-a" });
        expect(a).not.toBe(b);
    });

    it("does not contain the raw ip", async () => {
        const hash = await visitorFingerprint({ ...base, salt: "salt-a" });
        expect(hash).not.toContain("1.2.3.4");
    });
});

describe("resolveDailySalt", () => {
    function fakeConfig(initial: Record<string, unknown> = {}) {
        const store = new Map(Object.entries(initial));
        return {
            store,
            async getOrDefault<T>(key: string, defaultValue: T): Promise<T> {
                return (store.has(key) ? store.get(key) : defaultValue) as T;
            },
            async set(key: string, value: unknown) {
                store.set(key, value);
            },
        };
    }

    it("generates and persists a seed on first use", async () => {
        const config = fakeConfig();
        const salt = await resolveDailySalt(config, "2026-09-20");
        expect(salt.length).toBeGreaterThan(0);
        expect(config.store.get("analytics.salt_seed")).toBeTruthy();
    });

    it("derives different salts for different dates from one seed", async () => {
        const config = fakeConfig();
        const day1 = await resolveDailySalt(config, "2026-09-20");
        const seed = config.store.get("analytics.salt_seed");
        const day2 = await resolveDailySalt(config, "2026-09-21");
        expect(config.store.get("analytics.salt_seed")).toBe(seed);
        expect(day1).not.toBe(day2);
    });
});

describe("buildPageViewDataPoint", () => {
    const input = {
        feedId: 42,
        title: "Hello",
        path: "/feed/42",
        referrerHost: "www.google.com",
        country: "JP",
        city: "Tokyo",
        device: "mobile" as const,
        fingerprint: "abcdef0123456789",
    };

    it("uses feed id as the single index", () => {
        const point = buildPageViewDataPoint(input);
        expect(point.indexes).toEqual(["42"]);
        expect(point.indexes).toHaveLength(1);
    });

    it("places dimensions in the documented blob order", () => {
        const point = buildPageViewDataPoint(input);
        expect(point.blobs[0]).toBe("/feed/42");
        expect(point.blobs[1]).toBe("www.google.com");
        expect(point.blobs[2]).toBe("JP");
        expect(point.blobs[3]).toBe("Tokyo");
        expect(point.blobs[4]).toBe("mobile");
        expect(point.blobs[5]).toBe("abcdef0123456789");
        expect(point.blobs[6]).toBe("Hello");
    });

    it("counts one view", () => {
        expect(buildPageViewDataPoint(input).doubles).toEqual([1]);
    });

    it("keeps the index within the 96 byte limit", () => {
        const point = buildPageViewDataPoint({ ...input, feedId: Number.MAX_SAFE_INTEGER });
        expect(new TextEncoder().encode(point.indexes[0]).length).toBeLessThanOrEqual(96);
    });

    it("keeps total blob size within 16 KB", () => {
        const point = buildPageViewDataPoint({ ...input, title: "x".repeat(50_000) });
        const total = point.blobs.reduce((sum, b) => sum + new TextEncoder().encode(b).length, 0);
        expect(total).toBeLessThanOrEqual(16 * 1024);
    });

    it("tolerates a null title", () => {
        const point = buildPageViewDataPoint({ ...input, title: null });
        expect(point.blobs[6]).toBe("");
    });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/utils/__tests__/analytics.test.ts`
Expected: FAIL，模块 `../analytics` 不存在。

- [ ] **Step 3: 实现采集模块**

创建 `server/src/utils/analytics.ts`：

```ts
import type { AppContext } from "../core/hono-types";
import { getClientIp } from "./geo";

export type DeviceType = "mobile" | "desktop";

export const ANALYTICS_SALT_SEED_KEY = "analytics.salt_seed";

/** blob 总量上限 16 KB；标题是唯一可能超长的字段，单独截断。 */
const MAX_TITLE_BYTES = 256;

const BOT_PATTERNS = [
    "bot", "crawler", "spider", "slurp", "curl", "wget", "python-requests",
    "headlesschrome", "phantomjs", "monitor", "preview", "fetcher",
];

const MOBILE_PATTERNS = ["mobile", "android", "iphone", "ipod", "ipad", "windows phone"];

export interface PageViewDataPoint {
    indexes: [string];
    blobs: string[];
    doubles: [number];
}

/** 空 UA 视为 bot：真实浏览器一定会带 UA。 */
export function isBotUserAgent(userAgent: string): boolean {
    const ua = userAgent.trim().toLowerCase();
    if (!ua) {
        return true;
    }
    return BOT_PATTERNS.some((pattern) => ua.includes(pattern));
}

export function detectDevice(userAgent: string): DeviceType {
    const ua = userAgent.toLowerCase();
    return MOBILE_PATTERNS.some((pattern) => ua.includes(pattern)) ? "mobile" : "desktop";
}

/** 只保留来源 host；同源、缺失、非法一律记为 direct，不存完整 URL。 */
export function normalizeReferrer(referrer: string | null | undefined, selfHost: string): string {
    if (!referrer) {
        return "direct";
    }

    try {
        const host = new URL(referrer).host;
        if (!host || host === selfHost) {
            return "direct";
        }
        return host;
    } catch {
        return "direct";
    }
}

export function utcDateString(now: Date): string {
    return now.toISOString().slice(0, 10);
}

function truncateToBytes(value: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    if (encoder.encode(value).length <= maxBytes) {
        return value;
    }

    let result = value;
    while (result.length > 0 && encoder.encode(result).length > maxBytes) {
        result = result.slice(0, -1);
    }
    return result;
}

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

export async function visitorFingerprint(input: {
    ip: string;
    userAgent: string;
    feedId: number;
    salt: string;
}): Promise<string> {
    const hash = await sha256Hex(`${input.ip}|${input.userAgent}|${input.feedId}|${input.salt}`);
    return hash.slice(0, 16);
}

type SaltConfig = {
    getOrDefault<T>(key: string, defaultValue: T): Promise<T>;
    set(key: string, value: unknown, save?: boolean): Promise<void>;
};

/**
 * 每日轮换的盐：一次性随机种子持久化在 serverConfig，按 UTC 日期派生当日盐。
 * 跨天无法关联同一访客，也无法从存储值反推 IP。
 */
export async function resolveDailySalt(serverConfig: SaltConfig, date: string): Promise<string> {
    let seed = await serverConfig.getOrDefault<string>(ANALYTICS_SALT_SEED_KEY, "");

    if (!seed) {
        seed = crypto.randomUUID();
        await serverConfig.set(ANALYTICS_SALT_SEED_KEY, seed, true);
    }

    return sha256Hex(`${seed}|${date}`);
}

export function buildPageViewDataPoint(input: {
    feedId: number;
    title: string | null;
    path: string;
    referrerHost: string;
    country: string;
    city: string;
    device: DeviceType;
    fingerprint: string;
}): PageViewDataPoint {
    return {
        indexes: [String(input.feedId)],
        blobs: [
            input.path,
            input.referrerHost,
            input.country,
            input.city,
            input.device,
            input.fingerprint,
            truncateToBytes(input.title ?? "", MAX_TITLE_BYTES),
        ],
        doubles: [1],
    };
}

/**
 * 非阻塞记录一次文章浏览。任何缺失的前置条件（binding 未配置、bot、开关关闭）
 * 都静默跳过，绝不影响页面响应。
 */
export async function recordPageView(
    c: AppContext,
    options: { feedId: number; title: string | null },
): Promise<void> {
    const dataset = c.env.ANALYTICS;
    if (!dataset) {
        return;
    }

    const userAgent = c.req.header("user-agent") ?? "";
    if (isBotUserAgent(userAgent)) {
        return;
    }

    try {
        const serverConfig = c.get("serverConfig");
        const date = utcDateString(new Date());
        const salt = await resolveDailySalt(serverConfig, date);
        const ip = getClientIp(c.req.raw.headers);
        const cf = (c.req.raw as unknown as { cf?: Record<string, unknown> }).cf ?? {};

        const point = buildPageViewDataPoint({
            feedId: options.feedId,
            title: options.title,
            path: new URL(c.req.url).pathname,
            referrerHost: normalizeReferrer(c.req.header("referer"), new URL(c.req.url).host),
            country: typeof cf.country === "string" ? cf.country : "",
            city: typeof cf.city === "string" ? cf.city : "",
            device: detectDevice(userAgent),
            fingerprint: await visitorFingerprint({ ip, userAgent, feedId: options.feedId, salt }),
        });

        dataset.writeDataPoint(point);
    } catch (error) {
        console.warn("analytics: failed to record page view", error);
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/src/utils/__tests__/analytics.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 替换 feed.ts 中的同步统计逻辑**

在 `server/src/services/feed.ts` 中：

1. 把第 12 行的 `import { feeds, visits, visitStats } from "../db/schema";` 改为 `import { feeds, visitStats } from "../db/schema";`
2. 删除第 21 行的 `import { HyperLogLog } from "../utils/hyperloglog";`
3. 新增 `import { recordPageView } from "../utils/analytics";`（按字母序放在内部导入区）
4. 把原第 261-305 行的整段（从注释 `// update visits using HyperLogLog...` 到 `db.insert(visits).values(...)` 那一行结束）替换为：

```ts
        // Page views are recorded into Analytics Engine off the response path.
        // visit_stats stays as the durable per-feed counter, refreshed by the
        // daily rollup cron — this handler only reads it.
        const enableVisit = await profileAsync(c, 'feed_detail_counter_flag', () => clientConfig.getOrDefault('counter.enabled', true));
        let pv = 0;
        let uv = 0;

        if (enableVisit) {
            const stats = await profileAsync(c, 'feed_detail_stats_lookup', () => db.query.visitStats.findFirst({
                where: eq(visitStats.feedId, feed.id)
            }));

            pv = stats?.pv ?? 0;
            uv = stats?.uv ?? 0;

            c.executionCtx.waitUntil(recordPageView(c, { feedId: feed.id, title: feed.title }));
        }
```

**注意：** `visit_stats` 目前没有 `uv` 列（UV 原本是从 `hll_data` 算出来的）。本步骤需要给该表补一个 `uv` 列。把下面两条语句追加到 `server/sql/0016.sql` 的 `DROP TABLE` 之后、`UPDATE info` 之前：

```sql
ALTER TABLE `visit_stats` ADD COLUMN `uv` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
```

并在 `server/src/db/schema.ts` 的 `visitStats` 定义中，于 `pv` 之后新增 `uv: integer("uv").default(0).notNull(),`。

**历史 UV 回填：** 迁移后 `uv` 初始为 0，直到 cron 首次聚合。这是可接受的——`pv` 的历史累计值完整保留，`uv` 本来就是估算值。不写回填脚本（`hll_data` 的反序列化逻辑即将随 Task 3 停用，为一次性回填保留它不划算）。

- [ ] **Step 6: 重新迁移并跑全部服务端测试**

Run: `bun run db:migrate && bun run test:server`
Expected: 全部 PASS。`server/src/services/__tests__/feed.test.ts` 若断言了 `visits` 的写入或 HLL 行为，按新语义更新断言（pv/uv 来自 `visit_stats` 读取，不再有写入）。

- [ ] **Step 7: 类型检查**

Run: `bun run check`
Expected: PASS（Task 2 遗留的 `visits` 未定义错误此时应消失）

- [ ] **Step 8: 提交**

```bash
git add server/src/utils/analytics.ts server/src/utils/__tests__/analytics.test.ts server/src/services/feed.ts server/src/services/__tests__/feed.test.ts server/sql/0016.sql server/src/db/schema.ts
git commit -m "feat: record page views via Analytics Engine off the response path"
```

---

### Task 4: Analytics Engine SQL API 客户端

**Files:**
- Create: `server/src/utils/analytics-query.ts`
- Test: `server/src/utils/__tests__/analytics-query.test.ts`

**Interfaces:**
- Consumes: `Env.CLOUDFLARE_ACCOUNT_ID`、`Env.CLOUDFLARE_API_TOKEN`（`server/src/custom-env.d.ts:40-42`，Stream TUS 已在用）
- Produces:
  ```ts
  export const ANALYTICS_DATASET = "rin_analytics";
  export class AnalyticsUnavailableError extends Error {
      readonly reason: "unconfigured" | "request_failed";
  }
  export function isAnalyticsQueryConfigured(env: Env): boolean;
  export function analyticsSqlEndpoint(accountId: string): string;
  export async function queryAnalyticsEngine<T>(env: Env, sql: string): Promise<T[]>;
  ```

**背景：** AE **没有读取绑定**，查询必须 POST 到
`https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`，
认证头 `Authorization: Bearer <token>`，token 需 `Account | Account Analytics | Read` 权限。
响应体是 `{ meta, data, rows, rows_before_limit_at_least }`，结果行在 `data` 数组里。

- [ ] **Step 1: 写失败测试**

创建 `server/src/utils/__tests__/analytics-query.test.ts`：

```ts
import { afterEach, describe, expect, it } from "bun:test";
import {
    AnalyticsUnavailableError,
    analyticsSqlEndpoint,
    isAnalyticsQueryConfigured,
    queryAnalyticsEngine,
} from "../analytics-query";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function env(overrides: Record<string, unknown> = {}) {
    return {
        CLOUDFLARE_ACCOUNT_ID: "acct-123",
        CLOUDFLARE_API_TOKEN: "token-abc",
        ...overrides,
    } as unknown as Env;
}

describe("isAnalyticsQueryConfigured", () => {
    it("requires both account id and token", () => {
        expect(isAnalyticsQueryConfigured(env())).toBe(true);
        expect(isAnalyticsQueryConfigured(env({ CLOUDFLARE_API_TOKEN: "" }))).toBe(false);
        expect(isAnalyticsQueryConfigured(env({ CLOUDFLARE_ACCOUNT_ID: undefined }))).toBe(false);
        expect(isAnalyticsQueryConfigured(env({ CLOUDFLARE_ACCOUNT_ID: "   " }))).toBe(false);
    });
});

describe("analyticsSqlEndpoint", () => {
    it("builds the documented SQL API url", () => {
        expect(analyticsSqlEndpoint("acct-123")).toBe(
            "https://api.cloudflare.com/client/v4/accounts/acct-123/analytics_engine/sql",
        );
    });
});

describe("queryAnalyticsEngine", () => {
    it("throws an unconfigured error when the token is missing", async () => {
        const promise = queryAnalyticsEngine(env({ CLOUDFLARE_API_TOKEN: "" }), "SELECT 1");
        await expect(promise).rejects.toBeInstanceOf(AnalyticsUnavailableError);
        await promise.catch((error: AnalyticsUnavailableError) => {
            expect(error.reason).toBe("unconfigured");
        });
    });

    it("posts the sql with a bearer token and returns the data rows", async () => {
        let seenUrl = "";
        let seenInit: RequestInit | undefined;

        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            seenUrl = url;
            seenInit = init;
            return new Response(JSON.stringify({ data: [{ pv: 3 }], rows: 1 }), { status: 200 });
        }) as unknown as typeof fetch;

        const rows = await queryAnalyticsEngine<{ pv: number }>(env(), "SELECT 1");

        expect(rows).toEqual([{ pv: 3 }]);
        expect(seenUrl).toBe(analyticsSqlEndpoint("acct-123"));
        expect(seenInit?.method).toBe("POST");
        expect(seenInit?.body).toBe("SELECT 1");
        expect((seenInit?.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
    });

    it("throws a request_failed error on a non-200 response", async () => {
        globalThis.fetch = (async () =>
            new Response("Authentication error", { status: 403 })) as unknown as typeof fetch;

        const promise = queryAnalyticsEngine(env(), "SELECT 1");
        await expect(promise).rejects.toBeInstanceOf(AnalyticsUnavailableError);
        await promise.catch((error: AnalyticsUnavailableError) => {
            expect(error.reason).toBe("request_failed");
        });
    });

    it("throws a request_failed error when fetch itself rejects", async () => {
        globalThis.fetch = (async () => {
            throw new Error("network down");
        }) as unknown as typeof fetch;

        await expect(queryAnalyticsEngine(env(), "SELECT 1")).rejects.toBeInstanceOf(
            AnalyticsUnavailableError,
        );
    });

    it("returns an empty array when the response has no data field", async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ rows: 0 }), { status: 200 })) as unknown as typeof fetch;

        expect(await queryAnalyticsEngine(env(), "SELECT 1")).toEqual([]);
    });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/utils/__tests__/analytics-query.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `server/src/utils/analytics-query.ts`：

```ts
export const ANALYTICS_DATASET = "rin_analytics";

/**
 * Analytics Engine 不可用（未配置 / 请求失败）时抛出。
 * 调用方一律降级为 available:false，不得转成 HTTP 500。
 */
export class AnalyticsUnavailableError extends Error {
    readonly reason: "unconfigured" | "request_failed";

    constructor(reason: "unconfigured" | "request_failed", message: string) {
        super(message);
        this.name = "AnalyticsUnavailableError";
        this.reason = reason;
    }
}

export function isAnalyticsQueryConfigured(env: Env): boolean {
    return Boolean((env.CLOUDFLARE_ACCOUNT_ID || "").trim() && (env.CLOUDFLARE_API_TOKEN || "").trim());
}

export function analyticsSqlEndpoint(accountId: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
}

/**
 * AE 没有读取绑定，查询只能走 HTTP SQL API。
 * token 需要 `Account | Account Analytics | Read` 权限。
 */
export async function queryAnalyticsEngine<T>(env: Env, sql: string): Promise<T[]> {
    if (!isAnalyticsQueryConfigured(env)) {
        throw new AnalyticsUnavailableError(
            "unconfigured",
            "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required to query Analytics Engine",
        );
    }

    const accountId = (env.CLOUDFLARE_ACCOUNT_ID || "").trim();
    let response: Response;

    try {
        response = await fetch(analyticsSqlEndpoint(accountId), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${(env.CLOUDFLARE_API_TOKEN || "").trim()}`,
                "Content-Type": "text/plain",
            },
            body: sql,
        });
    } catch (error) {
        throw new AnalyticsUnavailableError("request_failed", `Analytics Engine request failed: ${error}`);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AnalyticsUnavailableError(
            "request_failed",
            `Analytics Engine returned ${response.status}: ${body.slice(0, 200)}`,
        );
    }

    const payload = (await response.json()) as { data?: T[] };
    return payload.data ?? [];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/src/utils/__tests__/analytics-query.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/utils/analytics-query.ts server/src/utils/__tests__/analytics-query.test.ts
git commit -m "feat: add Analytics Engine SQL API client with graceful degradation"
```

---

### Task 5: cron 每日聚合

**Files:**
- Create: `server/src/services/analytics-rollup.ts`
- Modify: `server/src/runtime/scheduled-handler.ts`
- Test: `server/src/services/__tests__/analytics-rollup.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `queryAnalyticsEngine` / `AnalyticsUnavailableError` / `ANALYTICS_DATASET`；Task 3 的 `utcDateString`；Task 2 的 `analyticsDaily` / `analyticsDimDaily`
- Produces:
  ```ts
  export const ANALYTICS_CURSOR_KEY = "analytics.last_rollup";
  export const ANALYTICS_WINDOW_DAYS = 90;
  export function addDays(date: string, days: number): string;
  export function analyticsWindowStart(today: string): string;
  export function pendingRollupDates(cursor: string | null, today: string, windowStart: string): string[];
  export function buildFeedRollupSql(date: string): string;
  export function buildDimensionRollupSql(date: string): string;
  export async function analyticsCrontab(
      env: Env, db: DB,
      serverConfig: { getOrDefault<T>(key: string, defaultValue: T): Promise<T>; set(key: string, value: unknown, save?: boolean): Promise<void> },
  ): Promise<void>;
  ```

**背景：** cron 每 20 分钟触发一次，但聚合只需每天做一次。用 `serverConfig` 里的 `analytics.last_rollup` 游标（UTC 日期字符串）判断有无待聚合日期；没有就立即返回。只聚合**已完结的日期**（不含今天），避免把半天数据写死。游标早于 AE 3 个月窗口时直接跳到窗口起点，不做无限重试。

- [ ] **Step 1: 写失败测试**

创建 `server/src/services/__tests__/analytics-rollup.test.ts`：

```ts
import { describe, expect, it } from "bun:test";
import {
    ANALYTICS_CURSOR_KEY,
    addDays,
    analyticsWindowStart,
    buildDimensionRollupSql,
    buildFeedRollupSql,
    pendingRollupDates,
} from "../analytics-rollup";

describe("addDays", () => {
    it("advances a date in UTC", () => {
        expect(addDays("2026-09-20", 1)).toBe("2026-09-21");
    });

    it("crosses month and year boundaries", () => {
        expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
        expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    });

    it("goes backwards with a negative offset", () => {
        expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    });
});

describe("analyticsWindowStart", () => {
    it("is 90 days before today", () => {
        expect(analyticsWindowStart("2026-09-20")).toBe(addDays("2026-09-20", -90));
    });
});

describe("pendingRollupDates", () => {
    const today = "2026-09-20";
    const windowStart = analyticsWindowStart(today);

    it("returns nothing when the cursor is already at yesterday", () => {
        expect(pendingRollupDates("2026-09-19", today, windowStart)).toEqual([]);
    });

    it("never includes today, since the day is not over", () => {
        const dates = pendingRollupDates("2026-09-17", today, windowStart);
        expect(dates).toEqual(["2026-09-18", "2026-09-19"]);
        expect(dates).not.toContain(today);
    });

    it("starts at the window start when there is no cursor", () => {
        const dates = pendingRollupDates(null, today, windowStart);
        expect(dates[0]).toBe(addDays(windowStart, 1));
        expect(dates.at(-1)).toBe("2026-09-19");
    });

    it("clamps a cursor older than the analytics engine window", () => {
        const dates = pendingRollupDates("2020-01-01", today, windowStart);
        expect(dates[0]).toBe(addDays(windowStart, 1));
        expect(dates.length).toBeLessThanOrEqual(90);
    });

    it("returns nothing when the cursor is in the future", () => {
        expect(pendingRollupDates("2026-09-25", today, windowStart)).toEqual([]);
    });
});

describe("buildFeedRollupSql", () => {
    it("aggregates pv and distinct uv per feed for one day", () => {
        const sql = buildFeedRollupSql("2026-09-20");
        expect(sql).toContain("rin_analytics");
        expect(sql).toContain("index1");
        expect(sql).toContain("COUNT(DISTINCT blob6)");
        expect(sql).toContain("'2026-09-20'");
        expect(sql).toContain("GROUP BY");
    });

    it("rejects a malformed date instead of interpolating it", () => {
        expect(() => buildFeedRollupSql("2026-09-20'; DROP TABLE x--")).toThrow();
    });
});

describe("buildDimensionRollupSql", () => {
    it("unions the three dimensions for one day", () => {
        const sql = buildDimensionRollupSql("2026-09-20");
        expect(sql).toContain("blob2");
        expect(sql).toContain("blob3");
        expect(sql).toContain("blob5");
        expect(sql).toContain("'2026-09-20'");
    });

    it("rejects a malformed date", () => {
        expect(() => buildDimensionRollupSql("nope")).toThrow();
    });
});

describe("ANALYTICS_CURSOR_KEY", () => {
    it("matches the key documented in the spec", () => {
        expect(ANALYTICS_CURSOR_KEY).toBe("analytics.last_rollup");
    });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/services/__tests__/analytics-rollup.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `server/src/services/analytics-rollup.ts`：

```ts
import { eq, sql } from "drizzle-orm";
import type { DB } from "../core/hono-types";
import { analyticsDaily, analyticsDimDaily, visitStats } from "../db/schema";
import {
    ANALYTICS_DATASET,
    AnalyticsUnavailableError,
    queryAnalyticsEngine,
} from "../utils/analytics-query";
import { utcDateString } from "../utils/analytics";

export const ANALYTICS_CURSOR_KEY = "analytics.last_rollup";

/** AE 保留 3 个月；90 天是可安全查询的窗口。 */
export const ANALYTICS_WINDOW_DAYS = 90;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type RollupConfig = {
    getOrDefault<T>(key: string, defaultValue: T): Promise<T>;
    set(key: string, value: unknown, save?: boolean): Promise<void>;
};

export function addDays(date: string, days: number): string {
    const base = new Date(`${date}T00:00:00.000Z`);
    base.setUTCDate(base.getUTCDate() + days);
    return utcDateString(base);
}

export function analyticsWindowStart(today: string): string {
    return addDays(today, -ANALYTICS_WINDOW_DAYS);
}

/**
 * 待聚合的已完结日期列表（不含今天）。
 * 游标早于 AE 窗口时直接跳到窗口起点，跳过的区间不再重试。
 */
export function pendingRollupDates(cursor: string | null, today: string, windowStart: string): string[] {
    const effectiveCursor = cursor && cursor > windowStart ? cursor : windowStart;
    const dates: string[] = [];

    let current = addDays(effectiveCursor, 1);
    while (current < today) {
        dates.push(current);
        current = addDays(current, 1);
    }

    return dates;
}

function assertDate(date: string): string {
    if (!DATE_PATTERN.test(date)) {
        throw new Error(`Refusing to build SQL with a malformed date: ${date}`);
    }
    return date;
}

export function buildFeedRollupSql(date: string): string {
    const day = assertDate(date);
    return `
        SELECT index1 AS feed_id,
               SUM(_sample_interval) AS pv,
               COUNT(DISTINCT blob6) AS uv
        FROM ${ANALYTICS_DATASET}
        WHERE toDate(timestamp) = toDate('${day}')
        GROUP BY index1
        FORMAT JSON
    `.trim();
}

export function buildDimensionRollupSql(date: string): string {
    const day = assertDate(date);
    const dimension = (column: string, type: string) => `
        SELECT '${type}' AS dim_type, ${column} AS dim_value, SUM(_sample_interval) AS count
        FROM ${ANALYTICS_DATASET}
        WHERE toDate(timestamp) = toDate('${day}')
        GROUP BY ${column}
    `.trim();

    return `
        ${dimension("blob2", "referrer")}
        UNION ALL
        ${dimension("blob3", "country")}
        UNION ALL
        ${dimension("blob5", "device")}
        FORMAT JSON
    `.trim();
}

interface FeedRollupRow {
    feed_id: string;
    pv: number;
    uv: number;
}

interface DimensionRollupRow {
    dim_type: string;
    dim_value: string;
    count: number;
}

async function rollupDate(env: Env, db: DB, date: string): Promise<void> {
    const feedRows = await queryAnalyticsEngine<FeedRollupRow>(env, buildFeedRollupSql(date));
    const dimRows = await queryAnalyticsEngine<DimensionRollupRow>(env, buildDimensionRollupSql(date));

    for (const row of feedRows) {
        const feedId = Number(row.feed_id);
        if (!Number.isSafeInteger(feedId) || feedId <= 0) {
            continue;
        }

        const pv = Number(row.pv) || 0;
        const uv = Number(row.uv) || 0;

        await db.insert(analyticsDaily)
            .values({ date, feedId, pv, uv })
            .onConflictDoUpdate({
                target: [analyticsDaily.date, analyticsDaily.feedId],
                set: { pv, uv },
            });

        // visit_stats 是文章页读取的持久计数器，由聚合结果重算，保证幂等。
        const totals = await db
            .select({
                pv: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)`,
                uv: sql<number>`COALESCE(SUM(${analyticsDaily.uv}), 0)`,
            })
            .from(analyticsDaily)
            .where(eq(analyticsDaily.feedId, feedId));

        const existing = await db.query.visitStats.findFirst({ where: eq(visitStats.feedId, feedId) });
        if (existing) {
            await db.update(visitStats)
                .set({ pv: totals[0]?.pv ?? 0, uv: totals[0]?.uv ?? 0, updatedAt: new Date() })
                .where(eq(visitStats.feedId, feedId));
        } else {
            await db.insert(visitStats).values({
                feedId,
                pv: totals[0]?.pv ?? 0,
                uv: totals[0]?.uv ?? 0,
                hllData: "",
            });
        }
    }

    for (const row of dimRows) {
        const dimValue = (row.dim_value || "").slice(0, 200);
        if (!dimValue) {
            continue;
        }

        const count = Number(row.count) || 0;
        await db.insert(analyticsDimDaily)
            .values({ date, dimType: row.dim_type, dimValue, count })
            .onConflictDoUpdate({
                target: [analyticsDimDaily.date, analyticsDimDaily.dimType, analyticsDimDaily.dimValue],
                set: { count },
            });
    }
}

/**
 * 每日聚合。cron 每 20 分钟调用，无待聚合日期时立即返回。
 * AE 不可用时记录告警并保持游标不动，下一轮重试。
 */
export async function analyticsCrontab(env: Env, db: DB, serverConfig: RollupConfig): Promise<void> {
    const today = utcDateString(new Date());
    const cursor = await serverConfig.getOrDefault<string>(ANALYTICS_CURSOR_KEY, "");
    const dates = pendingRollupDates(cursor || null, today, analyticsWindowStart(today));

    if (dates.length === 0) {
        return;
    }

    for (const date of dates) {
        try {
            await rollupDate(env, db, date);
            await serverConfig.set(ANALYTICS_CURSOR_KEY, date, true);
        } catch (error) {
            if (error instanceof AnalyticsUnavailableError) {
                console.warn(`analytics: rollup skipped for ${date} (${error.reason})`, error.message);
            } else {
                console.error(`analytics: rollup failed for ${date}`, error);
            }
            return;
        }
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/src/services/__tests__/analytics-rollup.test.ts`
Expected: PASS

- [ ] **Step 5: 接入 cron**

在 `server/src/runtime/scheduled-handler.ts` 中，`cleanupMediaAssets` 的动态 import 之后新增：

```ts
  const { analyticsCrontab } = await import("../services/analytics-rollup");
```

并在 `await cleanupMediaAssets(db, env);` 之后新增：

```ts
  await analyticsCrontab(env, db, serverConfig);
```

- [ ] **Step 6: 跑全部服务端测试**

Run: `bun run test:server`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add server/src/services/analytics-rollup.ts server/src/services/__tests__/analytics-rollup.test.ts server/src/runtime/scheduled-handler.ts
git commit -m "feat: roll Analytics Engine data into D1 daily aggregates via cron"
```

---

### Task 6: HTTP 端点与共享类型

**Files:**
- Create: `server/src/services/analytics.ts`
- Modify: `server/src/core/register-routes.ts`
- Modify: `packages/api/src/types.ts`
- Modify: `client/src/api/client.ts`
- Test: `server/src/services/__tests__/analytics.test.ts`

**Interfaces:**
- Consumes: Task 2 的表、Task 4 的 `queryAnalyticsEngine` / `AnalyticsUnavailableError` / `ANALYTICS_DATASET`、Task 5 的 `addDays`、`server/src/core/route-boundaries.ts` 的 `adminOnly`
- Produces:
  ```ts
  // packages/api/src/types.ts
  export type AnalyticsDimensionType = "referrer" | "country" | "device";
  export interface AnalyticsDailyPoint { date: string; pv: number; uv: number; }
  export interface AnalyticsOverview {
      range: { days: number; from: string; to: string };
      totals: { pv: number; uv: number; uvApproximate: boolean };
      today: { pv: number; uv: number };
      yesterday: { pv: number; uv: number };
      series: AnalyticsDailyPoint[];
  }
  export interface AnalyticsTopFeed { feedId: number; title: string | null; pv: number; uv: number; }
  export interface AnalyticsTopFeedsResponse { items: AnalyticsTopFeed[]; }
  export interface AnalyticsDimensionItem { value: string; count: number; }
  export interface AnalyticsDimensionsResponse { type: AnalyticsDimensionType; items: AnalyticsDimensionItem[]; }
  export interface AnalyticsLiveResponse { available: boolean; hours: number; items: AnalyticsTopFeed[]; }

  // server/src/services/analytics.ts
  export function parseDays(value: string | undefined): 7 | 30 | 90;
  export function parseHours(value: string | undefined): 1 | 24;
  export function parseLimit(value: string | undefined): number;
  export function parseDimensionType(value: string | undefined): AnalyticsDimensionType;
  export function AnalyticsService(): Hono<{ Bindings: Env; Variables: Variables }>;

  // client/src/api/client.ts
  client.analytics.getOverview(days?: number)
  client.analytics.getTopFeeds(days?: number, limit?: number)
  client.analytics.getDimensions(type: AnalyticsDimensionType, days?: number)
  client.analytics.getLive(hours?: number)
  ```

**注意：** `totals.uvApproximate` 在 `days > 1` 时为 `true`——每日轮换盐使得跨日 UV 只能取各日之和，属于高估的近似值。前端据此显示标注。

- [ ] **Step 1: 写失败测试**

创建 `server/src/services/__tests__/analytics.test.ts`：

```ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { adminOnly } from "../../core/route-boundaries";
import { parseDays, parseDimensionType, parseHours, parseLimit } from "../analytics";

describe("parseDays", () => {
    it("accepts only the three supported ranges", () => {
        expect(parseDays("7")).toBe(7);
        expect(parseDays("30")).toBe(30);
        expect(parseDays("90")).toBe(90);
    });

    it("falls back to 30 for anything else", () => {
        expect(parseDays(undefined)).toBe(30);
        expect(parseDays("")).toBe(30);
        expect(parseDays("365")).toBe(30);
        expect(parseDays("-1")).toBe(30);
        expect(parseDays("abc")).toBe(30);
    });
});

describe("parseHours", () => {
    it("accepts 1 and 24", () => {
        expect(parseHours("1")).toBe(1);
        expect(parseHours("24")).toBe(24);
    });

    it("falls back to 24", () => {
        expect(parseHours("720")).toBe(24);
        expect(parseHours(undefined)).toBe(24);
    });
});

describe("parseLimit", () => {
    it("defaults to 20", () => {
        expect(parseLimit(undefined)).toBe(20);
    });

    it("caps at 100", () => {
        expect(parseLimit("5000")).toBe(100);
    });

    it("rejects non-positive values", () => {
        expect(parseLimit("0")).toBe(20);
        expect(parseLimit("-3")).toBe(20);
    });
});

describe("parseDimensionType", () => {
    it("accepts the three known dimensions", () => {
        expect(parseDimensionType("referrer")).toBe("referrer");
        expect(parseDimensionType("country")).toBe("country");
        expect(parseDimensionType("device")).toBe("device");
    });

    it("falls back to referrer", () => {
        expect(parseDimensionType("browser")).toBe("referrer");
        expect(parseDimensionType(undefined)).toBe("referrer");
    });
});

describe("analytics routes are admin only", () => {
    it("rejects non-admin requests with 403", async () => {
        const app = new Hono();
        app.use("*", async (c, next) => {
            c.set("admin", false);
            await next();
        });
        app.get("/overview", adminOnly(async (c) => c.json({ ok: true }), { status: 403, format: "json" }));

        const response = await app.request("/overview");
        expect(response.status).toBe(403);
    });

    it("allows admin requests through", async () => {
        const app = new Hono();
        app.use("*", async (c, next) => {
            c.set("admin", true);
            await next();
        });
        app.get("/overview", adminOnly(async (c) => c.json({ ok: true }), { status: 403, format: "json" }));

        const response = await app.request("/overview");
        expect(response.status).toBe(200);
    });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/services/__tests__/analytics.test.ts`
Expected: FAIL，模块 `../analytics` 不存在。

- [ ] **Step 3: 添加共享类型**

把 Interfaces 段列出的全部 `Analytics*` 类型追加到 `packages/api/src/types.ts` 末尾。`packages/api/src/index.ts` 已有 `export * from './types'`，无需改动。

- [ ] **Step 4: 实现服务**

创建 `server/src/services/analytics.ts`：

```ts
import type {
    AnalyticsDimensionItem,
    AnalyticsDimensionType,
    AnalyticsDimensionsResponse,
    AnalyticsLiveResponse,
    AnalyticsOverview,
    AnalyticsTopFeed,
    AnalyticsTopFeedsResponse,
} from "@rin/api";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import { analyticsDaily, analyticsDimDaily, feeds } from "../db/schema";
import { utcDateString } from "../utils/analytics";
import {
    ANALYTICS_DATASET,
    AnalyticsUnavailableError,
    queryAnalyticsEngine,
} from "../utils/analytics-query";
import { addDays } from "./analytics-rollup";

const SUPPORTED_DAYS = [7, 30, 90] as const;
const SUPPORTED_HOURS = [1, 24] as const;
const DIMENSION_TYPES: AnalyticsDimensionType[] = ["referrer", "country", "device"];

const guard = { status: 403, format: "json" } as const;

export function parseDays(value: string | undefined): 7 | 30 | 90 {
    const parsed = Number.parseInt(value ?? "", 10);
    return (SUPPORTED_DAYS as readonly number[]).includes(parsed) ? (parsed as 7 | 30 | 90) : 30;
}

export function parseHours(value: string | undefined): 1 | 24 {
    const parsed = Number.parseInt(value ?? "", 10);
    return (SUPPORTED_HOURS as readonly number[]).includes(parsed) ? (parsed as 1 | 24) : 24;
}

export function parseLimit(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 20;
    }
    return Math.min(parsed, 100);
}

export function parseDimensionType(value: string | undefined): AnalyticsDimensionType {
    return DIMENSION_TYPES.includes(value as AnalyticsDimensionType)
        ? (value as AnalyticsDimensionType)
        : "referrer";
}

export function AnalyticsService() {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();

    // GET /analytics/overview?days=30
    app.get("/overview", adminOnly(async (c) => {
        const db = c.get("db");
        const days = parseDays(c.req.query("days"));
        const today = utcDateString(new Date());
        const yesterday = addDays(today, -1);
        const from = addDays(today, -(days - 1));

        const rows = await db
            .select({
                date: analyticsDaily.date,
                pv: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)`,
                uv: sql<number>`COALESCE(SUM(${analyticsDaily.uv}), 0)`,
            })
            .from(analyticsDaily)
            .where(gte(analyticsDaily.date, from))
            .groupBy(analyticsDaily.date)
            .orderBy(analyticsDaily.date);

        const series = rows.map((row) => ({
            date: row.date,
            pv: Number(row.pv) || 0,
            uv: Number(row.uv) || 0,
        }));

        const empty = { pv: 0, uv: 0 };
        const overview: AnalyticsOverview = {
            range: { days, from, to: today },
            totals: {
                pv: series.reduce((sum, point) => sum + point.pv, 0),
                uv: series.reduce((sum, point) => sum + point.uv, 0),
                // 每日轮换盐 → 跨日 UV 只能取各日之和，是高估的近似值。
                uvApproximate: days > 1,
            },
            today: series.find((point) => point.date === today) ?? { date: today, ...empty },
            yesterday: series.find((point) => point.date === yesterday) ?? { date: yesterday, ...empty },
            series,
        };

        return c.json(overview);
    }, guard));

    // GET /analytics/top-feeds?days=30&limit=20
    app.get("/top-feeds", adminOnly(async (c) => {
        const db = c.get("db");
        const days = parseDays(c.req.query("days"));
        const limit = parseLimit(c.req.query("limit"));
        const from = addDays(utcDateString(new Date()), -(days - 1));

        const rows = await db
            .select({
                feedId: analyticsDaily.feedId,
                title: feeds.title,
                pv: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)`,
                uv: sql<number>`COALESCE(SUM(${analyticsDaily.uv}), 0)`,
            })
            .from(analyticsDaily)
            .leftJoin(feeds, eq(feeds.id, analyticsDaily.feedId))
            .where(gte(analyticsDaily.date, from))
            .groupBy(analyticsDaily.feedId, feeds.title)
            .orderBy(desc(sql`SUM(${analyticsDaily.pv})`))
            .limit(limit);

        const response: AnalyticsTopFeedsResponse = {
            items: rows.map<AnalyticsTopFeed>((row) => ({
                feedId: row.feedId,
                title: row.title ?? null,
                pv: Number(row.pv) || 0,
                uv: Number(row.uv) || 0,
            })),
        };

        return c.json(response);
    }, guard));

    // GET /analytics/dimensions?days=30&type=referrer
    app.get("/dimensions", adminOnly(async (c) => {
        const db = c.get("db");
        const days = parseDays(c.req.query("days"));
        const type = parseDimensionType(c.req.query("type"));
        const from = addDays(utcDateString(new Date()), -(days - 1));

        const rows = await db
            .select({
                value: analyticsDimDaily.dimValue,
                count: sql<number>`COALESCE(SUM(${analyticsDimDaily.count}), 0)`,
            })
            .from(analyticsDimDaily)
            .where(and(gte(analyticsDimDaily.date, from), eq(analyticsDimDaily.dimType, type)))
            .groupBy(analyticsDimDaily.dimValue)
            .orderBy(desc(sql`SUM(${analyticsDimDaily.count})`))
            .limit(20);

        const response: AnalyticsDimensionsResponse = {
            type,
            items: rows.map<AnalyticsDimensionItem>((row) => ({
                value: row.value,
                count: Number(row.count) || 0,
            })),
        };

        return c.json(response);
    }, guard));

    // GET /analytics/live?hours=24 — the only endpoint that reaches Analytics Engine.
    app.get("/live", adminOnly(async (c) => {
        const hours = parseHours(c.req.query("hours"));

        try {
            const rows = await queryAnalyticsEngine<{ feed_id: string; title: string; pv: number; uv: number }>(
                c.env,
                `
                    SELECT index1 AS feed_id,
                           any(blob7) AS title,
                           SUM(_sample_interval) AS pv,
                           COUNT(DISTINCT blob6) AS uv
                    FROM ${ANALYTICS_DATASET}
                    WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
                    GROUP BY index1
                    ORDER BY pv DESC
                    LIMIT 20
                    FORMAT JSON
                `.trim(),
            );

            const response: AnalyticsLiveResponse = {
                available: true,
                hours,
                items: rows.map<AnalyticsTopFeed>((row) => ({
                    feedId: Number(row.feed_id),
                    title: row.title || null,
                    pv: Number(row.pv) || 0,
                    uv: Number(row.uv) || 0,
                })),
            };

            return c.json(response);
        } catch (error) {
            if (error instanceof AnalyticsUnavailableError) {
                // 未配置 token 或 token 缺少 Account Analytics Read 权限 → 降级，不是 500。
                console.warn("analytics: live query unavailable", error.reason, error.message);
                return c.json<AnalyticsLiveResponse>({ available: false, hours, items: [] });
            }
            throw error;
        }
    }, guard));

    return app;
}
```

- [ ] **Step 5: 注册路由**

在 `server/src/core/register-routes.ts` 顶部按字母序新增 `import { AnalyticsService } from "../services/analytics";`，并在 `app.route("/feed", FeedService());` 之前新增：

```ts
  app.route("/analytics", AnalyticsService());
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test server/src/services/__tests__/analytics.test.ts && bun run test:server`
Expected: 全部 PASS

- [ ] **Step 7: 添加客户端 API 方法**

在 `client/src/api/client.ts` 中：

1. 把 `AnalyticsDimensionType`、`AnalyticsDimensionsResponse`、`AnalyticsLiveResponse`、`AnalyticsOverview`、`AnalyticsTopFeedsResponse` 加进顶部从 `@rin/api` 的 type 导入列表。
2. 在 `ConfigAPI` 类之后新增：

```ts
/**
 * Analytics API methods (admin only)
 */
class AnalyticsAPI {
  constructor(private http: HttpClient) {}

  // GET /api/analytics/overview
  async getOverview(days = 30): Promise<ApiResponse<AnalyticsOverview>> {
    return this.http.get<AnalyticsOverview>(`/api/analytics/overview?days=${days}`);
  }

  // GET /api/analytics/top-feeds
  async getTopFeeds(days = 30, limit = 20): Promise<ApiResponse<AnalyticsTopFeedsResponse>> {
    return this.http.get<AnalyticsTopFeedsResponse>(`/api/analytics/top-feeds?days=${days}&limit=${limit}`);
  }

  // GET /api/analytics/dimensions
  async getDimensions(
    type: AnalyticsDimensionType,
    days = 30,
  ): Promise<ApiResponse<AnalyticsDimensionsResponse>> {
    return this.http.get<AnalyticsDimensionsResponse>(`/api/analytics/dimensions?type=${type}&days=${days}`);
  }

  // GET /api/analytics/live
  async getLive(hours = 24): Promise<ApiResponse<AnalyticsLiveResponse>> {
    return this.http.get<AnalyticsLiveResponse>(`/api/analytics/live?hours=${hours}`);
  }
}
```

3. 在 `ApiClient` 类中，于 `config: ConfigAPI;` 之后新增字段 `analytics: AnalyticsAPI;`，并在构造函数中 `this.config = new ConfigAPI(this.http);` 之后新增 `this.analytics = new AnalyticsAPI(this.http);`。

**路径前缀确认：** 实现前先 `grep -n '"/api/' client/src/api/client.ts | head -3` 确认现有方法确实带 `/api` 前缀（`ConfigAPI.getAll` 用的是 `/api/config`）。若前缀不同，按该文件的实际约定调整上面四个路径。

- [ ] **Step 8: 类型检查**

Run: `bun run check`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add server/src/services/analytics.ts server/src/services/__tests__/analytics.test.ts server/src/core/register-routes.ts packages/api/src/types.ts client/src/api/client.ts
git commit -m "feat: add admin analytics endpoints and shared response types"
```

---

### Task 7: 看板页面

**Files:**
- Create: `client/src/components/analytics-charts.tsx`
- Create: `client/src/page/analytics.tsx`
- Modify: `client/src/app/routes.tsx`
- Modify: `client/src/components/admin-layout.tsx:70`
- Modify: `client/public/locales/en/translation.json`
- Modify: `client/public/locales/zh-CN/translation.json`
- Modify: `client/public/locales/zh-TW/translation.json`
- Modify: `client/public/locales/ja/translation.json`

**Interfaces:**
- Consumes: Task 6 的 `client.analytics.*` 与 `@rin/api` 的 `Analytics*` 类型；现有 `useApiResource`（`client/src/hooks/use-api-resource.ts`）；`@rin/ui` 的 `SettingsCard` / `SettingsCardHeader` / `SettingsCardBody` / `SettingsBadge` / `Spinner`
- Produces：
  ```tsx
  export function LineChart(props: { points: { label: string; value: number }[]; height?: number }): JSX.Element;
  export function BarList(props: { items: { label: string; value: number }[] }): JSX.Element;
  export function AnalyticsPage(): JSX.Element;
  ```

**约束提醒：** 不引第三方图表库，`LineChart` 与 `BarList` 用内联 SVG / CSS 实现。

- [ ] **Step 1: 实现图表组件**

创建 `client/src/components/analytics-charts.tsx`：

```tsx
export function LineChart({
  points,
  height = 160,
}: {
  points: { label: string; value: number }[];
  height?: number;
}) {
  if (points.length === 0) {
    return <div className="h-40" />;
  }

  const width = 600;
  const padding = 8;
  const max = Math.max(...points.map((point) => point.value), 1);
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const coords = points.map((point, i) => {
    const x = padding + i * step;
    const y = height - padding - (point.value / max) * (height - padding * 2);
    return `${x},${y}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      preserveAspectRatio="none"
    >
      <polyline
        points={coords.join(" ")}
        fill="none"
        strokeWidth="2"
        className="stroke-sky-500 dark:stroke-sky-400"
      />
    </svg>
  );
}

export function BarList({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(...items.map((item) => item.value), 1);

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label} className="space-y-1">
          <div className="flex justify-between text-sm text-neutral-600 dark:text-neutral-300">
            <span className="truncate">{item.label}</span>
            <span className="tabular-nums">{item.value}</span>
          </div>
          <div className="h-1.5 rounded bg-neutral-200 dark:bg-neutral-700">
            <div
              className="h-1.5 rounded bg-sky-500 dark:bg-sky-400"
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: 实现看板页**

创建 `client/src/page/analytics.tsx`。参照 `client/src/page/queue-status.tsx` 的结构（`useApiResource` + `SettingsCard` 系列 + `useTranslation`）组装以下五块，并保证：

- 四个数字卡：今日 PV/UV、区间 PV/UV。**当 `overview.totals.uvApproximate === true` 时，区间 UV 数字旁必须渲染 `t("analytics.uv_approximate")` 标注**——每日轮换盐使跨日 UV 是各日之和的高估近似值。
- 趋势区：`<LineChart points={overview.series.map((p) => ({ label: p.date, value: p.pv }))} />`
- 热门文章：`topFeeds.items` 列表，每行链接到 `/feed/${item.feedId}`。
- 三个维度分布：对 `referrer` / `country` / `device` 各渲染一个 `<BarList items={...map((i) => ({ label: i.value, value: i.count }))} />`。
- 时间范围切换：7 / 30 / 90，用 `useState<7 | 30 | 90>(30)`，变更时 `reload()`。

加载态用 `<Spinner />`；`useApiResource` 返回的 `error` 非空时渲染错误文案 `t("analytics.load_failed")`；`overview.series.length === 0` 时渲染空状态 `t("analytics.empty")`（首次部署到 cron 首次聚合之间会出现这个状态）。

- [ ] **Step 3: 接线路由与导航**

在 `client/src/app/routes.tsx` 中：

1. 按字母序新增 `import { AnalyticsPage } from "../page/analytics";`
2. 在 queue-status 的 `AdminRoute`（约第 76 行）旁新增：

```tsx
      <AdminRoute path="/admin/analytics" requirePermission title={t("analytics.title")} description={t("admin.analytics_description")}>
        <AnalyticsPage />
      </AdminRoute>
```

在 `client/src/components/admin-layout.tsx` 第 70 行的 `AdminNavItem` 旁新增：

```tsx
                <AdminNavItem href="/admin/analytics" icon="ri-bar-chart-line" label={t("analytics.title")} />
```

- [ ] **Step 4: 补齐四语言文案**

在**四个**文件中都加上 `analytics` 顶层对象，并在各自的 `admin` 对象里加 `analytics_description`。

`client/public/locales/zh-CN/translation.json`：

```json
  "analytics": {
    "title": "访问统计",
    "range": { "7": "近 7 天", "30": "近 30 天", "90": "近 90 天" },
    "today_pv": "今日浏览量",
    "today_uv": "今日访客数",
    "range_pv": "区间浏览量",
    "range_uv": "区间访客数",
    "uv_approximate": "近似值（各日之和）",
    "trend": "访问趋势",
    "top_feeds": "热门文章",
    "referrer": "流量来源",
    "country": "国家和地区",
    "device": "设备",
    "empty": "暂无数据。统计在每日聚合任务首次运行后显示。",
    "load_failed": "加载访问统计失败。"
  },
```

`admin` 对象内新增：`"analytics_description": "查看站点访问趋势、热门文章以及来源、地区和设备分布。"`

`client/public/locales/en/translation.json`：

```json
  "analytics": {
    "title": "Analytics",
    "range": { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" },
    "today_pv": "Page views today",
    "today_uv": "Visitors today",
    "range_pv": "Page views",
    "range_uv": "Visitors",
    "uv_approximate": "Approximate (sum of daily values)",
    "trend": "Traffic trend",
    "top_feeds": "Top posts",
    "referrer": "Referrers",
    "country": "Countries",
    "device": "Devices",
    "empty": "No data yet. Stats appear after the daily rollup job runs for the first time.",
    "load_failed": "Failed to load analytics."
  },
```

`admin` 对象内新增：`"analytics_description": "Inspect site traffic trends, top posts, and referrer, country, and device breakdowns."`

`client/public/locales/zh-TW/translation.json`：与 zh-CN 相同结构，用繁体：`"title": "訪問統計"`、`"range": { "7": "近 7 天", "30": "近 30 天", "90": "近 90 天" }`、`"today_pv": "今日瀏覽量"`、`"today_uv": "今日訪客數"`、`"range_pv": "區間瀏覽量"`、`"range_uv": "區間訪客數"`、`"uv_approximate": "近似值（各日之和）"`、`"trend": "訪問趨勢"`、`"top_feeds": "熱門文章"`、`"referrer": "流量來源"`、`"country": "國家和地區"`、`"device": "裝置"`、`"empty": "暫無資料。統計會在每日彙總任務首次執行後顯示。"`、`"load_failed": "載入訪問統計失敗。"`；`admin.analytics_description`: `"查看網站訪問趨勢、熱門文章以及來源、地區和裝置分布。"`

`client/public/locales/ja/translation.json`：`"title": "アクセス解析"`、`"range": { "7": "過去 7 日間", "30": "過去 30 日間", "90": "過去 90 日間" }`、`"today_pv": "本日のページビュー"`、`"today_uv": "本日の訪問者数"`、`"range_pv": "ページビュー"`、`"range_uv": "訪問者数"`、`"uv_approximate": "概算値（日次の合計）"`、`"trend": "アクセス推移"`、`"top_feeds": "人気記事"`、`"referrer": "参照元"`、`"country": "国・地域"`、`"device": "デバイス"`、`"empty": "データがまだありません。日次集計ジョブの初回実行後に表示されます。"`、`"load_failed": "アクセス解析の読み込みに失敗しました。"`；`admin.analytics_description`: `"サイトのアクセス推移、人気記事、参照元・地域・デバイスの内訳を確認します。"`

- [ ] **Step 5: 验证四个语言文件的键完全一致**

Run:
```bash
cd /home/idea/code/Rin && for lang in en zh-CN zh-TW ja; do
  echo -n "$lang: "
  bun -e "const j=require('./client/public/locales/$lang/translation.json'); console.log(Object.keys(j.analytics).sort().join(','), '| admin.analytics_description:', typeof j.admin.analytics_description)"
done
```
Expected: 四行的键列表完全相同，且 `admin.analytics_description` 均为 `string`。

- [ ] **Step 6: 类型检查与全量测试**

Run: `bun run check && bun run test && bun run format:check`
Expected: 全部 PASS。`format:check` 报错就跑 `bun run format:write` 后重跑。

- [ ] **Step 7: 提交**

```bash
git add client/src/components/analytics-charts.tsx client/src/page/analytics.tsx client/src/app/routes.tsx client/src/components/admin-layout.tsx client/public/locales
git commit -m "feat: add admin analytics dashboard page"
```

---

## 部署后的人工步骤

代码无法代劳，实施完成后需要人工执行：

1. 在 Cloudflare 面板给现有 API token 追加 `Account | Account Analytics | Read` 权限（该 token 当前只有 Stream Write，用于 TUS 上传）。
2. 部署后确认 `wrangler.toml` 中 `[[analytics_engine_datasets]]` 块存在——这是 Task 1 防回归的目的。
3. 等待 cron 首次完成每日聚合（最迟次日）后看板才有数据；在此之前页面显示 `analytics.empty` 空状态，属正常。

未完成第 1 步时系统不会崩溃：`/analytics/live` 返回 `available: false`，cron 聚合跳过且游标不推进（权限补齐后会自动补跑窗口内的历史日期）。

## Self-Review

**Spec coverage：** 逐节核对 —— §4 架构（Task 3/5）、§4.1 cron 调度（Task 5）、§4.2 降级（Task 3 采集降级、Task 4 查询降级、Task 6 路由降级）、§5.1 AE 数据点（Task 3）、§5.2 D1 表（Task 2）、§5.3 保留 `visit_stats` / drop `visits`（Task 2 + Task 3）、§6 采集（Task 3）、§7 查询层与 API（Task 6）、§7.2 聚合（Task 5）、§7.3 共享类型（Task 6）、§8 前端（Task 7）、§9 部署配置（Task 1）、§10 测试（Task 3/4/5/6 各自内联）。无遗漏。

**Spec 偏差（实施中发现并已在计划内解决）：** spec §5.3 未提及 `visit_stats` 缺少 `uv` 列——UV 原本是从 `hll_data` 实时算出的。Task 3 Step 5 补了 `ALTER TABLE visit_stats ADD COLUMN uv`，并说明不做历史 UV 回填的理由。

**命名一致性核对：** `ANALYTICS`（binding）、`rin_analytics`（dataset）、`analytics.salt_seed`、`analytics.last_rollup`、`analyticsDaily` / `analytics_daily`、`analyticsDimDaily` / `analytics_dim_daily`、`recordPageView`、`buildPageViewDataPoint`、`queryAnalyticsEngine`、`AnalyticsUnavailableError`、`analyticsCrontab`、`addDays`、`AnalyticsService`、`parseDays` / `parseHours` / `parseLimit` / `parseDimensionType`、`client.analytics.*` —— 跨任务引用处拼写一致。blob 序号在 spec §5.1、Task 3 测试、Task 5 聚合 SQL、Task 6 live SQL 四处一致（blob2=referrer、blob3=country、blob5=device、blob6=指纹、blob7=标题）。
