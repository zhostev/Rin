# 访问明细（Visit Detail）设计

- 日期：2026-09-21
- 状态：已确认，待实施
- 分支基点：`origin/main` @ `0e1f81e`
- **本文修订了** `docs/superpowers/specs/2026-09-20-visitor-analytics-design.md`（下称「原 spec」）

## 0. 对原 spec 的修订声明

原 spec §5.3 与 §6.1 明确规定**不持久化明文 IP**：`visits` 表被 drop 的理由之一就是它是明文 IP 唯一的落盘点，采集侧只保留 `SHA-256(IP + UA + feedId + 每日轮换盐)` 的前 16 位。

**本设计推翻这一条**：自本次改动起，原始 IP 会作为 `blob8` 随每个访问数据点写入 Analytics Engine。

推翻的理由与边界：

- 站长需要一个「最近谁来过」的明细视图，而伪匿名指纹无法满足（每日轮换，跨天不可关联，也无法识别具体来访者）。
- 仓库中已有同类先例：`comments.ip` 存明文 IP，通过 `server/src/services/comments.ts:42-44` 的列选择做到「访客只见归属地标签，完整 IP 仅管理员可见」。本设计沿用同一原则。
- **保留期从无限变为 3 个月**（AE 固有保留期，自动过期），实际上比原 `visits` 表的「永久保留且无清理」更克制。
- 指纹（`blob6`）保留不变，UV 去重仍然依赖它。但需要诚实记录：在同一批数据点内 IP 与指纹并存的 3 个月里，该指纹的假名化保护基本失效。这是需求本身带来的后果，不是实现缺陷。

原 spec 的其余部分（聚合口径、D1 永久保留、四个端点、降级策略）全部继续有效。

## 1. 目标与非目标

### 目标

- 在 `/admin/analytics` 增加「访问明细」区块，逐次列出最近的文章访问。
- 每行含：时间、文章、来源、地区、设备、访客指纹、IP。
- 仅管理员可见，IP 不出现在任何公开路径。

### 非目标（明确 YAGNI）

- 按文章筛选 / 下钻（用户明确确认不做）
- 按 IP 或时间段搜索
- 分页（固定取最近 N 条）
- 会话归组视图
- 导出
- IP 截断或脱敏（用户确认存完整值）
- 反刷量、审计取证等能力 —— 用途明确为「站长日常翻看」

## 2. 方案选型

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **IP 作为 blob 写入 AE** | **采用** | 零 D1 写入、零迁移、零清理 cron；3 个月自动过期即保留策略；`writeDataPoint` 本就在 `ctx.waitUntil` 中，加字段不增加响应路径开销 |
| 新建 D1 `visit_log` 表 + 环形缓冲 | 不采用 | 完整不采样，但把 2026-09-20 才刚移除的「每次浏览一次 D1 写入」写放大原样带回，并需要迁移与清理 cron。对「日常翻看」这一用途性价比不成立 |
| 按访客归组的会话视图 | 不采用 | 盐每日轮换，会话无法跨天延续；UI 复杂度也不匹配用途 |

**已知代价**：AE 在高流量时会采样，明细列表严格说是「最近访问（可能被采样）」。当前站点量级（7 篇文章）远未触及采样阈值。接口会返回 `sampled` 标记，UI 据此提示，避免列表在流量增长后悄悄变得不完整而误导人。

## 3. 采集

改动点：`server/src/utils/analytics.ts` 的 `buildPageViewDataPoint` 增加 `ip` 入参，写入 `blob8`。

**这不是新增数据采集。** `recordPageView` 目前已调用 `getClientIp(c.req.raw.headers)` 取得 IP 用于计算指纹，只是用完即弃。本次仅将内存中已有的值多写一个 blob 位。

### 3.1 blob 位置契约（硬约束）

`blob1..blob7` 的位置与语义**一律不变**：

| 位 | 内容 |
| --- | --- |
| blob1 | 请求路径 |
| blob2 | referrer host（同源/缺失为 `direct`） |
| blob3 | country |
| blob4 | city |
| blob5 | device |
| blob6 | 访客指纹前 16 位 |
| blob7 | 文章标题（截断至 256 字节） |
| **blob8** | **原始 IP（本次新增）** |

`server/src/services/analytics-rollup.ts` 的 `buildFeedRollupSql` / `buildDimensionRollupSql` 与 `analytics.ts` 的 `/live` 查询都按位置读 `blob2/3/5/6`，位移会静默产出错误数字而不报错。实施时必须加一条锁死 blob1..blob7 位置的回归断言。

IPv6 最长 45 字符，blobs 合计上限 16 KB，无需截断。

## 4. 数据模型

无新表、无迁移、无清理任务。AE 数据点从 7 个 blob 变为 8 个。

**不可补的历史空缺**：本次部署之前写入的数据点只有 7 个 blob，其 `blob8` 查询结果为空字符串。AE 数据点写入后不可变，因此 2026-09-21 本次部署之前的访问记录，IP 列永久为空。UI 将空 IP 渲染为 `—` 而非空白，以免被误认为故障。

## 5. 接口

新增 `GET /analytics/visits?limit=100`，挂在现有 `AnalyticsService()` 中，使用 `adminOnly(handler, { status: 403, format: "json" })`，与其余四个端点同形。

纯函数 `buildVisitDetailSql(limit)`：

```sql
SELECT timestamp, index1, blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, _sample_interval
FROM rin_analytics
ORDER BY timestamp DESC
LIMIT <n>
```

`limit` 默认 100、上限 500、非法值回落至 100。**必须先整数校验再拼接**，绝不字符串插值 —— 沿用 `analytics-rollup.ts` 中 `assertDate` / `DATE_PATTERN` 的做法。

### 5.1 共享类型（`packages/api/src/types.ts`）

```ts
export interface AnalyticsVisit {
    /**
     * ISO 8601，UTC。
     *
     * Analytics Engine 的 SQL API 返回的时间戳格式不保证是 ISO（可能是
     * `YYYY-MM-DD HH:MM:SS`），而客户端要用 `new Date(ts)` 解析。**服务端负责
     * 归一化成 ISO 再返回**，不要把原始格式透传给前端 —— Safari 对非 ISO 字符串
     * 的 Date 解析行为与 Chrome 不一致，透传会变成只在部分浏览器出现的空白时间列。
     */
    timestamp: string;
    feedId: number;
    title: string | null;
    path: string;
    /** referrer host，或 "direct"。 */
    referrer: string;
    country: string;
    city: string;
    device: string;
    /** 访客指纹前缀，用于肉眼识别同一访客。 */
    visitor: string;
    /** 本次改动前写入的数据点为空字符串。 */
    ip: string;
}

export interface AnalyticsVisitsResponse {
    available: boolean;
    items: AnalyticsVisit[];
    /** 任意一行 _sample_interval > 1 即为 true：列表不完整。 */
    sampled: boolean;
}
```

### 5.2 降级

沿用 `/live` 的处理：捕获 `AnalyticsUnavailableError` 时返回
`{ available: false, items: [], sampled: false }`，绝不 500；非该类型的异常照常上抛。

## 6. 门禁与隐私

- `/analytics/visits` 是**唯一**返回 `blob8` 的路径。`/overview`、`/top-feeds`、`/dimensions`、`/live` 以及聚合 cron 均按名字选列，不会捎带 IP。
- 公开接口（文章详情页的 pv/uv）不受影响。
- 测试需覆盖：非管理员请求返回 403，且响应体不含 IP 字样。

## 7. 前端

新建 `client/src/components/analytics-visit-table.tsx`，在 `client/src/page/analytics.tsx` 的三个维度分布之后新增区块。

仓库的后台页此前**没有数据表格先例**（唯一的 `<table>` 在 `markdown.tsx` 渲染文章内容）。不引入表格库，使用原生 `<table>` 配 `overflow-x-auto`，沿用 `client/src/components/markdown.tsx:390` 已有的类名组合；窄屏横向滚动，不另做移动端变体。

七列：时间 / 文章 / 来源 / 地区 / 设备 / 访客 / IP。

- 时间用 `new Date(ts).toLocaleString()` 显示**本地时间**。看板别处是 UTC 日期口径（聚合按 UTC 天），但「翻最近谁来过」看本地时间更符合直觉，且 `feed_card.tsx`、`adjacent_feed.tsx` 已是此写法。
- 文章链接到 `/feed/<id>`。
- 访客列显示指纹前 8 位。
- IP 为空时显示 `—`。

区块标题下固定一行小字说明「仅保留最近 3 个月」。`sampled` 为 true 时额外渲染 warning 徽章说明列表不完整。

三态分开处理：loading 出 `Spinner`；error 出 `analytics.visits.load_failed`；空列表出 `analytics.visits.empty`（空是正常路径，新站点本就没有访问记录）。`available: false` 走 warning 徽章，与今日卡一致。

新增 i18n key 落到 `client/public/locales/{en,zh-CN,zh-TW,ja}/translation.json` 四个文件，key 集合必须完全一致。

## 8. 测试

服务端（`bun:test`，`server/src/**/__tests__/`）：

- `buildPageViewDataPoint`：`blob8 === ip`；**并锁死 blob1..blob7 的位置**（最易被后续改动静默破坏的契约）。
- `buildVisitDetailSql`：含 `blob8`、`ORDER BY timestamp DESC`、`LIMIT`；limit 钳制（默认 100 / 上限 500 / 非法回落）；非整数输入抛错而非插值。
- `/analytics/visits` 降级：`AnalyticsUnavailableError` → `available: false`，非 500。
- 非管理员请求 403，响应体不含 IP。

客户端：表格行渲染、空态、`sampled` 警示、`available: false` 警示、空 IP 显示 `—`。

## 9. 实施顺序

三步，各自独立可验证、各自一个提交：

1. **采集**：`blob8` + blob1..blob7 位置回归断言。
2. **查询层**：`buildVisitDetailSql` + `/analytics/visits` 端点 + `packages/api` 类型 + `client/src/api/client.ts` 方法（含 `export type` 再导出块）。
3. **前端**：表格组件 + 页面区块 + 四语言文案。

每步验证：`bun test` 与 `bunx turbo check --force`（后者必须带 `--force`，默认 `bun run check` 会命中 Turbo 缓存，那是缓存绿不是执行绿）。

## 10. 部署影响

无迁移、无新绑定、无新环境变量、无需人工操作。`ANALYTICS` 绑定与 `CLOUDFLARE_API_TOKEN` 的 `Account Analytics Read` 权限已于 2026-09-21 在生产确认可用。

部署后新写入的数据点即带 IP；明细视图在此之前的行 IP 列为空。
