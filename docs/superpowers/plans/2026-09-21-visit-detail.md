# 访问明细（Visit Detail）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/admin/analytics` 增加一个仅管理员可见的「访问明细」表格，逐次列出最近的文章访问，含原始 IP。

**Architecture:** 在现有 Analytics Engine 数据点上新增 `blob8 = 原始 IP`（`recordPageView` 已经为了算指纹而取到了 IP，只是用完即弃，这里顺手多写一个 blob 位）。新增一个 `adminOnly` 端点 `GET /analytics/visits`，用一条 `ORDER BY timestamp DESC LIMIT n` 的 AE SQL 查询直接返回明细。不建表、不迁移、不加清理任务 —— AE 固有的 3 个月保留期就是保留策略。

**Tech Stack:** Cloudflare Workers + Workers Analytics Engine、Hono 风格 Router、React 18 + Wouter + TailwindCSS + i18next、`bun:test`、Bun、Turbo。

**Spec:** `docs/superpowers/specs/2026-09-21-visit-detail-design.md`（该 spec 第 0 节修订了 `docs/superpowers/specs/2026-09-20-visitor-analytics-design.md` 中「不持久化明文 IP」的规定，实施前务必先读第 0 节）

**Branch base:** `origin/main` @ `0e1f81e`，分支 `feat/analytics-visit-detail`。

## Global Constraints

- 测试一律 `bun:test`，不得引入其他测试运行器。服务端测试位于 `server/src/**/__tests__/*.test.ts`。
- 文件名 kebab-case；组件 PascalCase；函数 camelCase；类型/接口 PascalCase。
- 导入顺序：外部依赖在前（字母序），内部导入在后（字母序）。
- **`blob1..blob7` 的位置与语义一律不变**：blob1=path、blob2=referrer host、blob3=country、blob4=city、blob5=device、blob6=访客指纹、blob7=标题。新增的 IP 只能放 `blob8`。
- AE 单数据点上限：20 blobs、20 doubles、1 index，blobs 合计 ≤16 KB。
- SQL 中一切动态值必须先校验再拼接，禁止字符串插值未校验的输入。
- `days` 仍只接受 7/30/90（回落 30）；本次新增的 `limit` 默认 **100**、上限 **500**、非法回落 100。**不要复用现有的 `parseLimit`**（那是 `/top-feeds` 的，默认 20/上限 100）。
- Analytics Engine 不可用时一律降级为正常响应，禁止 HTTP 500。
- IP 只允许出现在 `/analytics/visits` 的响应里，其余端点与聚合 cron 不得返回。
- 新增前端文案必须同时补齐 `client/public/locales/{en,zh-CN,zh-TW,ja}/translation.json` 四个文件，key 集合完全一致。
- 不引入任何第三方表格库或图表库。
- 提交遵循 conventional commits，并以下面这行结尾：
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- 验证用 `bun test` 与 `bunx turbo check --force`。**必须带 `--force`** —— 默认 `bun run check` 会命中 Turbo 缓存（`>>> FULL TURBO`），那是缓存绿不是执行绿。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `server/src/utils/analytics.ts` | 采集：`buildPageViewDataPoint` 增加 `ip` 入参写入 blob8 |
| `server/src/services/analytics.ts` | 新增 `parseVisitLimit`、`normalizeAeTimestamp`、`buildVisitDetailSql`、`GET /analytics/visits` |
| `packages/api/src/types.ts` | `AnalyticsVisit`、`AnalyticsVisitsResponse` |
| `client/src/api/client.ts` | `AnalyticsAPI.getVisits()` + 类型再导出 |
| `client/src/components/analytics-visit-table.tsx` | 纯展示表格组件 |
| `client/src/page/analytics.tsx` | 新增 `VisitSection` 区块并挂到页面末尾 |
| `client/public/locales/*/translation.json` | 四语言文案 |

查询与端点放进已有的 `services/analytics.ts` 而不是新建文件：它们与 `/live` 共用 `queryAnalyticsEngine`、降级分支和 `guard` 常量，拆开反而割裂。表格拆成独立组件，因为它是页面里唯一有内部布局逻辑的部分。

---

### Task 1: 采集 —— blob8 写入原始 IP

**Files:**
- Modify: `server/src/utils/analytics.ts`（`buildPageViewDataPoint` 与 `recordPageView`）
- Test: `server/src/utils/__tests__/analytics.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  ```ts
  // buildPageViewDataPoint 的入参新增一个必填字段
  export function buildPageViewDataPoint(input: {
      feedId: number;
      title: string | null;
      path: string;
      referrerHost: string;
      country: string;
      city: string;
      device: DeviceType;
      fingerprint: string;
      ip: string;          // 新增 → blobs[7]
  }): PageViewDataPoint;
  ```

**背景（实现者必读）：** `recordPageView` 目前已经调用 `getClientIp(c.req.raw.headers)` 取到 IP 用来算指纹，算完就丢。本任务只是把这个已在内存里的值多写一个 blob 位，**不是新增数据采集**，响应路径开销不变。

`blobs[0..6]` 的位置是跨文件契约：`server/src/services/analytics-rollup.ts` 的 `buildFeedRollupSql` / `buildDimensionRollupSql` 与 `server/src/services/analytics.ts` 的 `/live` 查询都按位置读 `blob2/blob3/blob5/blob6`。位移不会报错，只会静默产出错误数字，所以本任务必须留下一条锁死位置的断言。

- [ ] **Step 1: 写失败测试**

在 `server/src/utils/__tests__/analytics.test.ts` 中，`describe("buildPageViewDataPoint", ...)` 里的 `const input = {...}` 增加 `ip: "203.0.113.7",`，然后在该 describe 内追加：

```ts
    it("puts the raw ip in blob8", () => {
        expect(buildPageViewDataPoint(input).blobs[7]).toBe("203.0.113.7");
    });

    it("handles an IPv6 address without truncating it", () => {
        const v6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
        expect(buildPageViewDataPoint({ ...input, ip: v6 }).blobs[7]).toBe(v6);
    });

    it("tolerates a missing ip", () => {
        expect(buildPageViewDataPoint({ ...input, ip: "" }).blobs[7]).toBe("");
    });

    // 位置锁：rollup 与 /live 的 SQL 按下标读 blob2/3/5/6，
    // 任何位移都不会报错，只会静默产出错误数字。
    it("keeps blob1..blob7 at their contracted positions", () => {
        const point = buildPageViewDataPoint(input);
        expect(point.blobs.slice(0, 7)).toEqual([
            "/feed/42",
            "www.google.com",
            "JP",
            "Tokyo",
            "mobile",
            "abcdef0123456789",
            "Hello",
        ]);
        expect(point.blobs).toHaveLength(8);
        expect(point.indexes).toEqual(["42"]);
        expect(point.doubles).toEqual([1]);
    });
```

在 `describe("recordPageView", ...)` 中，那条断言 `dataset.points[0].blobs[6]` 的用例后面追加：

```ts
    it("records the client ip in blob8", async () => {
        const dataset = createFakeDataset();
        await recordPageView(fakeContext({ dataset, headers: { "cf-connecting-ip": "198.51.100.9" } }), {
            feedId: 42,
            title: "Hello",
        });
        expect(dataset.points[0].blobs[7]).toBe("198.51.100.9");
    });
```

> 该 describe 里已有的 fake context / fake dataset 辅助函数怎么命名，以文件现状为准；照搬现有用例的构造方式，不要新造一套。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/utils/__tests__/analytics.test.ts`
Expected: FAIL —— `blobs[7]` 为 `undefined`，且 TS 报 `input` 缺少 `ip`。

- [ ] **Step 3: 实现**

`server/src/utils/analytics.ts` 的 `buildPageViewDataPoint`：入参类型增加 `ip: string;`，返回的 `blobs` 数组在 `truncateToBytes(input.title ?? "", MAX_TITLE_BYTES),` 之后追加一行：

```ts
            input.ip,
```

`recordPageView` 中，`buildPageViewDataPoint({...})` 的调用增加一行（`ip` 变量在该作用域内已存在）：

```ts
            ip,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/src/utils/__tests__/analytics.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验证**

Run: `bun test && bunx turbo check --force`
Expected: 全绿；`turbo check` 显示 `Cached: 0`。

- [ ] **Step 6: 提交**

```bash
git add server/src/utils/analytics.ts server/src/utils/__tests__/analytics.test.ts
git commit -m "feat(analytics): record the client ip in blob8

recordPageView already reads the client ip to derive the visitor
fingerprint and then discards it; persist that same in-memory value as
blob8 so the admin visit-detail view can show it. No new collection and
no change to the response path.

Adds a regression assertion pinning blob1..blob7 to their contracted
positions — the rollup and /live queries read blob2/3/5/6 by index, so a
shift would silently produce wrong numbers rather than an error.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 查询层 —— `/analytics/visits` 端点与共享类型

**Files:**
- Modify: `server/src/services/analytics.ts`
- Modify: `packages/api/src/types.ts`
- Modify: `client/src/api/client.ts`
- Test: `server/src/services/__tests__/analytics.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `blob8`；现有 `queryAnalyticsEngine` / `AnalyticsUnavailableError` / `ANALYTICS_DATASET`（`server/src/utils/analytics-query.ts`）、`adminOnly`（`server/src/core/route-boundaries.ts`）、模块内已有的 `guard` 常量
- Produces:
  ```ts
  // server/src/services/analytics.ts
  export function parseVisitLimit(value: string | undefined): number;      // 默认 100，上限 500
  export function normalizeAeTimestamp(raw: string): string;               // → ISO 8601，不可解析时返回 ""
  export function buildVisitDetailSql(limit: number, dataset?: string): string;

  // packages/api/src/types.ts
  export interface AnalyticsVisit {
      timestamp: string;   // ISO 8601 UTC；不可解析时为 ""
      feedId: number;
      title: string | null;
      path: string;
      referrer: string;
      country: string;
      city: string;
      device: string;
      visitor: string;
      ip: string;          // Task 1 之前写入的数据点为 ""
  }
  export interface AnalyticsVisitsResponse {
      available: boolean;
      items: AnalyticsVisit[];
      sampled: boolean;
  }

  // client/src/api/client.ts
  client.analytics.getVisits(limit?: number): Promise<ApiResponse<AnalyticsVisitsResponse>>
  ```

**背景：** AE 没有读取绑定，查询走 HTTP SQL API，`queryAnalyticsEngine` 已经封装好了。`/live` 是现成的范本：同样的 `adminOnly(handler, guard)`、同样的 `AnalyticsUnavailableError` 降级分支。

**时间戳归一化是必须的**：AE SQL API 返回的时间戳格式不保证是 ISO（可能是 `YYYY-MM-DD HH:MM:SS`），而客户端要 `new Date(ts)` 解析。Safari 与 Chrome 对非 ISO 字符串的 `Date` 解析行为不一致 —— 透传会变成只在部分浏览器出现的空白时间列。

- [ ] **Step 1: 写失败测试**

在 `server/src/services/__tests__/analytics.test.ts` 顶部从 `../analytics` 的 import 列表中加入 `buildVisitDetailSql`、`normalizeAeTimestamp`、`parseVisitLimit`（保持字母序），并追加：

```ts
describe("parseVisitLimit", () => {
    it("defaults to 100", () => {
        expect(parseVisitLimit(undefined)).toBe(100);
        expect(parseVisitLimit("")).toBe(100);
        expect(parseVisitLimit("abc")).toBe(100);
    });

    it("caps at 500", () => {
        expect(parseVisitLimit("5000")).toBe(500);
        expect(parseVisitLimit("501")).toBe(500);
    });

    it("rejects non-positive values", () => {
        expect(parseVisitLimit("0")).toBe(100);
        expect(parseVisitLimit("-7")).toBe(100);
    });

    it("accepts a value inside the range", () => {
        expect(parseVisitLimit("250")).toBe(250);
    });

    // /top-feeds 的 parseLimit 是默认 20 / 上限 100，两者不可混用。
    it("is not the same bounds as parseLimit", () => {
        expect(parseVisitLimit(undefined)).not.toBe(parseLimit(undefined));
    });
});

describe("normalizeAeTimestamp", () => {
    it("converts a space-separated AE timestamp to ISO, treating it as UTC", () => {
        expect(normalizeAeTimestamp("2026-09-21 02:31:07")).toBe("2026-09-21T02:31:07.000Z");
    });

    it("passes an already-ISO timestamp through unchanged in value", () => {
        expect(normalizeAeTimestamp("2026-09-21T02:31:07Z")).toBe("2026-09-21T02:31:07.000Z");
    });

    it("returns an empty string for unparseable input", () => {
        expect(normalizeAeTimestamp("")).toBe("");
        expect(normalizeAeTimestamp("not a date")).toBe("");
    });
});

describe("buildVisitDetailSql", () => {
    it("selects every blob including blob8 and the sample interval", () => {
        const sql = buildVisitDetailSql(100);
        for (const column of ["timestamp", "index1", "blob1", "blob6", "blob7", "blob8", "_sample_interval"]) {
            expect(sql).toContain(column);
        }
        expect(sql).toContain("rin_analytics");
    });

    it("orders newest first and applies the limit", () => {
        const sql = buildVisitDetailSql(250);
        expect(sql).toContain("ORDER BY timestamp DESC");
        expect(sql).toContain("LIMIT 250");
    });

    it("does not group or aggregate — it is a raw row listing", () => {
        const sql = buildVisitDetailSql(100);
        expect(sql).not.toContain("GROUP BY");
        expect(sql).not.toContain("SUM(");
    });

    it("refuses a non-integer limit instead of interpolating it", () => {
        expect(() => buildVisitDetailSql(Number.NaN)).toThrow();
        expect(() => buildVisitDetailSql(1.5)).toThrow();
        expect(() => buildVisitDetailSql(-1)).toThrow();
        expect(() => buildVisitDetailSql("100; DROP TABLE x--" as unknown as number)).toThrow();
    });
});
```

在既有的 `describe("AnalyticsService admin guard", ...)` 中，把 `/analytics/visits` 加进 `paths` 数组：

```ts
    const paths = [
        "/analytics/overview",
        "/analytics/top-feeds",
        "/analytics/dimensions",
        "/analytics/live",
        "/analytics/visits",
    ];
```

并追加一条针对 IP 泄漏的断言：

```ts
    it("never leaks an ip to a non-admin", async () => {
        const app = mount(false);
        const response = await app.request("/analytics/visits");
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(body).not.toContain("ip");
    });
```

> `mount()` 辅助函数是该 describe 里现成的，照用即可。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/src/services/__tests__/analytics.test.ts`
Expected: FAIL —— 三个新导出不存在。

- [ ] **Step 3: 实现共享类型**

把 Interfaces 段里的 `AnalyticsVisit` 与 `AnalyticsVisitsResponse` 追加到 `packages/api/src/types.ts` 末尾（带上 spec §5.1 的中文注释）。`packages/api/src/index.ts` 已有 `export * from './types'`，无需改动。

- [ ] **Step 4: 实现服务端**

在 `server/src/services/analytics.ts` 中，把 `AnalyticsVisit`、`AnalyticsVisitsResponse` 加入顶部从 `@rin/api` 的 type 导入列表（字母序），并在 `parseDimensionType` 之后新增：

```ts
export function parseVisitLimit(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 100;
    }
    return Math.min(parsed, 500);
}

/**
 * AE SQL API 的时间戳格式不保证是 ISO（可能是 `YYYY-MM-DD HH:MM:SS`）。
 * 客户端要 `new Date(ts)` 解析，而 Safari 与 Chrome 对非 ISO 字符串的行为不一致，
 * 透传会变成只在部分浏览器出现的空白时间列 —— 所以在服务端归一化。
 */
export function normalizeAeTimestamp(raw: string): string {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) {
        return "";
    }

    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
    const candidate = hasZone ? trimmed : `${trimmed.replace(" ", "T")}Z`;
    const date = new Date(candidate);

    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function buildVisitDetailSql(limit: number, dataset: string = ANALYTICS_DATASET): string {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new Error(`Refusing to build SQL with a non-integer limit: ${limit}`);
    }

    return [
        "SELECT timestamp, index1, blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, _sample_interval",
        `FROM ${dataset}`,
        "ORDER BY timestamp DESC",
        `LIMIT ${limit}`,
        "FORMAT JSON",
    ].join(" ");
}
```

然后在 `/live` 的 `app.get(...)` 之后、`return app;` 之前新增端点：

```ts
    // GET /analytics/visits?limit=100 — 唯一返回原始 IP 的路径。
    app.get("/visits", adminOnly(async (c) => {
        const limit = parseVisitLimit(c.req.query("limit"));

        try {
            const rows = await queryAnalyticsEngine<Record<string, unknown>>(
                c.env,
                buildVisitDetailSql(limit),
            );

            const items = rows.map<AnalyticsVisit>((row) => ({
                timestamp: normalizeAeTimestamp(String(row.timestamp ?? "")),
                feedId: Number(row.index1) || 0,
                title: String(row.blob7 ?? "") || null,
                path: String(row.blob1 ?? ""),
                referrer: String(row.blob2 ?? ""),
                country: String(row.blob3 ?? ""),
                city: String(row.blob4 ?? ""),
                device: String(row.blob5 ?? ""),
                visitor: String(row.blob6 ?? ""),
                // Task 1 之前写入的数据点没有 blob8，查出来是空字符串。
                ip: String(row.blob8 ?? ""),
            }));

            const response: AnalyticsVisitsResponse = {
                available: true,
                items,
                // 采样后列表不完整；UI 据此提示，避免流量涨上来后悄悄误导人。
                sampled: rows.some((row) => (Number(row._sample_interval) || 1) > 1),
            };

            return c.json(response);
        } catch (error) {
            if (error instanceof AnalyticsUnavailableError) {
                console.warn("analytics: visit detail unavailable", error.reason, error.message);
                return c.json<AnalyticsVisitsResponse>({ available: false, items: [], sampled: false });
            }
            throw error;
        }
    }, guard));
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test server/src/services/__tests__/analytics.test.ts`
Expected: PASS

- [ ] **Step 6: 实现客户端方法**

在 `client/src/api/client.ts` 中：

1. 把 `AnalyticsVisit`、`AnalyticsVisitsResponse` 加入顶部从 `@rin/api` 的 `import type {...}` 列表。
2. **同时加入下方 `export type { ... } from "@rin/api";` 再导出块** —— 页面按仓库惯例从 `"../api/client"` 导入类型，漏掉这一步 Task 3 会编译不过。
3. 在 `AnalyticsAPI` 类中，`getLive()` 之后新增：

```ts
  // GET /api/analytics/visits
  async getVisits(limit = 100): Promise<ApiResponse<AnalyticsVisitsResponse>> {
    return this.http.get<AnalyticsVisitsResponse>(`/api/analytics/visits?limit=${limit}`);
  }
```

- [ ] **Step 7: 全量验证**

Run: `bun test && bunx turbo check --force`
Expected: 全绿；`Cached: 0`。

- [ ] **Step 8: 提交**

```bash
git add server/src/services/analytics.ts server/src/services/__tests__/analytics.test.ts packages/api/src/types.ts client/src/api/client.ts
git commit -m "feat(analytics): add the admin-only visit detail endpoint

GET /analytics/visits returns the most recent raw page views straight
from Analytics Engine — no aggregation, no new table. It is the only
route that returns blob8 (the client ip); the other four endpoints and
the rollup select columns by name and are unaffected.

parseVisitLimit is deliberately separate from parseLimit: /top-feeds
wants 20/100, the detail listing wants 100/500. AE timestamps are
normalized to ISO server-side because Safari and Chrome disagree on
parsing the space-separated form, which would surface as a blank time
column on some browsers only.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 前端 —— 明细表格区块

**Files:**
- Create: `client/src/components/analytics-visit-table.tsx`
- Modify: `client/src/page/analytics.tsx`
- Modify: `client/public/locales/en/translation.json`
- Modify: `client/public/locales/zh-CN/translation.json`
- Modify: `client/public/locales/zh-TW/translation.json`
- Modify: `client/public/locales/ja/translation.json`
- Test: `client/src/page/__tests__/analytics.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `client.analytics.getVisits(limit?)` 与 `AnalyticsVisit` / `AnalyticsVisitsResponse`；现有 `useApiResource`（`client/src/hooks/use-api-resource.ts`）；`@rin/ui` 的 `SettingsCard` / `SettingsCardHeader` / `SettingsCardBody` / `SettingsBadge` / `Spinner`
- Produces:
  ```tsx
  export function VisitTable({ items }: { items: AnalyticsVisit[] }): JSX.Element;
  ```

**背景：** 后台页此前**没有数据表格先例** —— 全仓库唯一的 `<table>` 在 `client/src/components/markdown.tsx:390` 用于渲染文章正文。不引表格库，用原生 `<table>` 配 `overflow-x-auto`，窄屏横向滚动，不另做移动端变体。

区块结构照抄同文件里的 `DimensionSection`（`client/src/page/analytics.tsx:60-92`）：`useCallback` 包 loader → `useApiResource` → loading/error/empty 三态分开渲染。

- [ ] **Step 1: 实现表格组件**

创建 `client/src/components/analytics-visit-table.tsx`：

```tsx
import type { AnalyticsVisit } from "../api/client";
import { useTranslation } from "react-i18next";

export function VisitTable({ items }: { items: AnalyticsVisit[] }) {
  const { t } = useTranslation();

  return (
    // markdown.tsx 已经在用这套类名做窄屏横向滚动，沿用它而不是另造一套。
    <div className="block max-w-full overflow-x-auto">
      <table className="w-full min-w-max text-left text-sm">
        <thead className="text-neutral-500 dark:text-neutral-400">
          <tr>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.time")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.article")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.referrer")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.location")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.device")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.visitor")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.ip")}</th>
          </tr>
        </thead>
        <tbody className="text-neutral-700 dark:text-neutral-200">
          {items.map((visit, index) => (
            <tr key={`${visit.timestamp}-${visit.visitor}-${index}`} className="border-t border-neutral-200 dark:border-neutral-700">
              {/* 看板别处按 UTC 天聚合，但「翻最近谁来过」看本地时间更符合直觉，
                  且 feed_card.tsx / adjacent_feed.tsx 都是这个写法。 */}
              <td className="whitespace-nowrap px-2 py-1 tabular-nums">
                {visit.timestamp ? new Date(visit.timestamp).toLocaleString() : "—"}
              </td>
              <td className="max-w-xs truncate px-2 py-1">
                <a className="hover:underline" href={`/feed/${visit.feedId}`}>
                  {visit.title || `#${visit.feedId}`}
                </a>
              </td>
              <td className="px-2 py-1">{visit.referrer || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1">
                {[visit.country, visit.city].filter(Boolean).join(" / ") || "—"}
              </td>
              <td className="px-2 py-1">{visit.device || "—"}</td>
              <td className="px-2 py-1 font-mono text-xs">{visit.visitor.slice(0, 8) || "—"}</td>
              {/* Task 1 上线之前写入的数据点没有 blob8，显示 — 而不是空白，
                  免得看起来像故障。 */}
              <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">{visit.ip || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: 挂上页面区块**

在 `client/src/page/analytics.tsx` 中，`DimensionSection` 函数之后新增：

```tsx
function VisitSection() {
  const { t } = useTranslation();
  const loadVisits = useCallback(() => client.analytics.getVisits(100), []);
  const { data, loading, error } = useApiResource<AnalyticsVisitsResponse>(loadVisits);
  const items = Array.isArray(data?.items) ? data.items : [];
  const unavailable = !loading && !error && data?.available === false;

  return (
    <SettingsCard>
      <SettingsCardHeader
        title={t("analytics.visits.title")}
        description={t("analytics.visits.retention")}
        badge={
          unavailable ? (
            <SettingsBadge tone="warning">{t("analytics.live_unavailable")}</SettingsBadge>
          ) : data?.sampled ? (
            <SettingsBadge tone="warning">{t("analytics.visits.sampled")}</SettingsBadge>
          ) : undefined
        }
      />
      <SettingsCardBody>
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Spinner label={t("analytics.visits.title")} />
          </div>
        ) : error ? (
          <p className="text-sm text-rose-600 dark:text-rose-300">{t("analytics.visits.load_failed")}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("analytics.visits.empty")}</p>
        ) : (
          <VisitTable items={items} />
        )}
      </SettingsCardBody>
    </SettingsCard>
  );
}
```

把 `VisitTable` 与 `AnalyticsVisitsResponse` 加进该文件顶部的导入（内部导入按字母序），并在三个 `DimensionSection` 所在的 `</div>` 之后、`</>` 之前渲染：

```tsx
          <VisitSection />
```

- [ ] **Step 3: 补齐四语言文案**

在**四个**文件的 `analytics` 对象里新增 `visits` 子对象。

`client/public/locales/zh-CN/translation.json`：

```json
    "visits": {
      "title": "访问明细",
      "retention": "仅保留最近 3 个月",
      "time": "时间",
      "article": "文章",
      "referrer": "来源",
      "location": "地区",
      "device": "设备",
      "visitor": "访客",
      "ip": "IP",
      "sampled": "数据已采样，列表不完整",
      "empty": "暂无访问记录。",
      "load_failed": "加载访问明细失败。"
    },
```

`client/public/locales/en/translation.json`：

```json
    "visits": {
      "title": "Recent visits",
      "retention": "Last 3 months only",
      "time": "Time",
      "article": "Article",
      "referrer": "Referrer",
      "location": "Location",
      "device": "Device",
      "visitor": "Visitor",
      "ip": "IP",
      "sampled": "Sampled — this list is incomplete",
      "empty": "No visits recorded yet.",
      "load_failed": "Failed to load recent visits."
    },
```

`client/public/locales/zh-TW/translation.json`（繁体）：

```json
    "visits": {
      "title": "訪問明細",
      "retention": "僅保留最近 3 個月",
      "time": "時間",
      "article": "文章",
      "referrer": "來源",
      "location": "地區",
      "device": "裝置",
      "visitor": "訪客",
      "ip": "IP",
      "sampled": "資料已取樣，列表不完整",
      "empty": "暫無訪問記錄。",
      "load_failed": "載入訪問明細失敗。"
    },
```

`client/public/locales/ja/translation.json`（敬体，与既有 ja 条目风格一致）：

```json
    "visits": {
      "title": "アクセス履歴",
      "retention": "直近 3 か月のみ保持",
      "time": "日時",
      "article": "記事",
      "referrer": "参照元",
      "location": "地域",
      "device": "デバイス",
      "visitor": "訪問者",
      "ip": "IP",
      "sampled": "サンプリングされているため、一覧は完全ではありません",
      "empty": "アクセス履歴はまだありません。",
      "load_failed": "アクセス履歴の読み込みに失敗しました。"
    },
```

- [ ] **Step 4: 写客户端测试**

在 `client/src/page/__tests__/analytics.test.tsx` 中，给 mock 的 `client.analytics` 增加 `getVisits`，并新增一个可变响应变量（照现有 `liveResponse` / `overviewResponse` 的写法）：

```ts
const visit: AnalyticsVisit = {
  timestamp: "2026-09-21T02:31:07.000Z",
  feedId: 42,
  title: "Hello",
  path: "/feed/42",
  referrer: "www.google.com",
  country: "JP",
  city: "Tokyo",
  device: "mobile",
  visitor: "abcdef0123456789",
  ip: "203.0.113.7",
};

let visitsResponse: AnalyticsVisitsResponse = { available: true, items: [visit], sampled: false };
```

mock 里加 `getVisits: async () => ({ data: visitsResponse }),`，并在两个 `beforeEach` 中重置 `visitsResponse`。然后追加：

```tsx
describe("AnalyticsPage visit detail", () => {
  beforeEach(() => {
    liveResponse = live({ pv: 0, uv: 0 });
    overviewResponse = overview;
    visitsResponse = { available: true, items: [visit], sampled: false };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a row per visit, including the ip", async () => {
    const { getByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getByText("203.0.113.7")).toBeDefined());
    expect(getByText("www.google.com")).toBeDefined();
    expect(getByText("JP / Tokyo")).toBeDefined();
    // 访客列只显示指纹前 8 位。
    expect(getByText("abcdef01")).toBeDefined();
  });

  it("shows an em dash for a visit recorded before ip capture existed", async () => {
    visitsResponse = { available: true, items: [{ ...visit, ip: "" }], sampled: false };

    const { getAllByText, queryByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getAllByText("—").length).toBeGreaterThan(0));
    expect(queryByText("203.0.113.7")).toBeNull();
  });

  it("warns when the listing is sampled", async () => {
    visitsResponse = { available: true, items: [visit], sampled: true };

    const { getByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getByText("analytics.visits.sampled")).toBeDefined());
  });

  it("shows the empty state rather than an error when there are no visits", async () => {
    visitsResponse = { available: true, items: [], sampled: false };

    const { getByText, queryByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getByText("analytics.visits.empty")).toBeDefined());
    expect(queryByText("analytics.visits.load_failed")).toBeNull();
  });
});
```

- [ ] **Step 5: 运行客户端测试**

Run: `bun test client/src/page/__tests__/analytics.test.tsx`
Expected: PASS

- [ ] **Step 6: 验证四语言 key 对齐**

Run:
```bash
cd /home/idea/code/Rin && python3 -c "
import json, io
def flat(d,p=''):
    o={}
    for k,v in d.items():
        key=f'{p}.{k}' if p else k
        if isinstance(v,dict): o.update(flat(v,key))
        else: o[key]=v
    return o
L={l:set(flat(json.load(io.open(f'client/public/locales/{l}/translation.json',encoding='utf-8')))) for l in ['en','ja','zh-CN','zh-TW']}
base=L['en']
for l,k in L.items(): print(l, len(k), 'missing=', sorted(base-k) or '-', 'extra=', sorted(k-base) or '-')
print('IDENTICAL:', all(k==base for k in L.values()))
"
```
Expected: 四行键数相同、missing 与 extra 均为 `-`，`IDENTICAL: True`。

- [ ] **Step 7: 全量验证**

Run: `bun test && bunx turbo check --force`
Expected: 全绿；`Cached: 0`。

- [ ] **Step 8: 提交**

```bash
git add client/src/components/analytics-visit-table.tsx client/src/page/analytics.tsx client/src/page/__tests__/analytics.test.tsx client/public/locales
git commit -m "feat(analytics): add the recent-visits table to the dashboard

Lists the most recent page views with time, article, referrer, location,
device, visitor fingerprint and ip, admin-only. Local time is used here
rather than the dashboard's UTC-day convention because the point is to
skim what just happened; it matches feed_card.tsx and adjacent_feed.tsx.

No table library: the repo had no admin-page table before this, so it
reuses the overflow-x-auto pattern already in markdown.tsx. Visits
recorded before ip capture existed render an em dash rather than a blank
cell, so they do not read as a fault.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：** 逐节核对 —— §0 修订声明（无需代码，spec 已提交）；§3 采集与 blob8（Task 1）；§3.1 blob 位置契约与回归断言（Task 1 Step 1 的位置锁用例）；§4 数据模型与历史空缺（Task 2 的 `ip: String(row.blob8 ?? "")` + Task 3 的 `—` 渲染）；§5 接口、`buildVisitDetailSql`、limit 钳制、整数校验（Task 2）；§5.1 共享类型与时间戳归一化（Task 2）；§5.2 降级（Task 2 的 catch 分支）；§6 门禁与 IP 不外泄（Task 2 Step 1 的 403 + 不含 IP 断言）；§7 前端全部要点（Task 3）；§8 测试（三个任务各自内联）；§9 实施顺序（三个任务即是）；§10 部署影响（无需代码）。无遗漏。

**Placeholder 扫描：** 无 TBD / TODO / "类似 Task N"。每个代码步骤都带可直接粘贴的代码块。唯一的转述是 Task 1 Step 1 里对 fake context 辅助函数命名的说明 —— 那是因为该辅助函数是既有代码，照抄反而可能与现状不符，所以明确要求以文件现状为准。

**类型一致性：** `AnalyticsVisit` / `AnalyticsVisitsResponse` 的字段名在 Task 2（服务端构造、客户端方法签名）与 Task 3（表格组件、测试夹具）中逐字一致；`parseVisitLimit`（非 `parseLimit`）、`normalizeAeTimestamp`、`buildVisitDetailSql`、`getVisits`、`VisitTable`、`VisitSection` 在定义处与引用处拼写一致。blob 下标在 spec §3.1、Task 1 断言、Task 2 的 SQL 与行映射三处一致（blob1→path … blob7→title、blob8→ip）。
