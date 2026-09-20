# 访问统计（Visitor Analytics）设计

- 日期：2026-09-20
- 状态：已确认，待实施
- 范围：站点级访问统计看板 + 改造现有文章 PV/UV 采集链路

## 1. 背景与现状

仓库里已有一套局部的访问统计，只覆盖单篇文章：

| 位置 | 内容 |
| --- | --- |
| `server/src/db/schema.ts:42` | `visits` 表：`feed_id` + 明文 `ip`，逐次访问一行 |
| `server/src/db/schema.ts:51` | `visit_stats` 表：`pv` + HyperLogLog 序列化的 `hll_data` |
| `server/src/services/feed.ts:261-305` | `GET /feed/:id` 请求路径内同步读写统计 |
| `client/src/page/feed.tsx:216-223` | 文章详情页展示 pv/uv |

存在三个问题：

1. **`visits` 表只写不读。** 全仓库没有任何 SELECT，cron（`server/src/runtime/scheduled-handler.ts`）里也没有清理逻辑，是纯粹的 D1 写放大，且明文 IP 长期落盘。
2. **每次浏览都要整行读写 HLL。** 流程是 SELECT `visit_stats` → 反序列化 → `add(ip)` → 重新序列化 → UPDATE，且全部在响应路径上同步执行，直接计入 TTFB。
3. **没有任何站点级视图。** 没有时间序列、没有总量、没有来源/地理/设备维度，管理后台也没有对应页面。

## 2. 目标与非目标

### 目标

- 新增仅管理员可见的站点级统计看板：总量、按天趋势、热门文章 Top N、来源 / 国家 / 设备分布。
- 把访问采集从 D1 请求路径上移走，消除写放大和 TTFB 开销。
- 消除明文 IP 落盘。
- 文章详情页现有的公开 pv/uv 展示与历史累计数字保持不变。

### 非目标（明确 YAGNI）

- 实时在线人数
- 自定义事件打点
- CSV / JSON 数据导出
- 公开（非管理员）看板
- 引入第三方图表库
- 前端 beacon 上报非文章页面（首页、标签页、时间线等）的访问量

## 3. Cloudflare 能力选型

| 能力 | 结论 | 依据 |
| --- | --- | --- |
| **Workers Analytics Engine** | **采用** | `writeDataPoint()` 写入 + HTTP SQL API 读取。免费版 10 万写入/天 + 1 万查询/天；付费版 1000 万写入/月 + 100 万查询/月。单次调用上限 20 blobs / 20 doubles / 1 index，blobs 合计 ≤16 KB，单次 Worker 调用最多 250 个数据点。高基数维度不额外收费。**数据保留 3 个月。** |
| **D1** | **采用（长期存储）** | AE 只留 3 个月，博客累计阅读量需要永久保留，因此用 cron 做每日聚合落盘。 |
| Cloudflare Web Analytics | 不采用 | 客户端 RUM beacon，数据在 CF 面板内；要嵌入自有页面仍需走 GraphQL API + token 代理，且拿不到「按 feed_id 聚合」的粒度。 |
| GraphQL Analytics API | 不采用 | 统计粒度是边缘 HTTP 请求，无法回答「这篇文章被看了多少次」。 |
| Durable Objects | 不采用 | 精确实时计数器对博客场景属于过度设计。 |

**读取方式约束：** Analytics Engine **没有读取绑定**，查询必须走
`POST https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`，
认证头 `Authorization: Bearer <API_TOKEN>`，token 需要 `Account | Account Analytics | Read` 权限。

**已有基础设施：** `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN` 已存在于 `server/src/custom-env.d.ts:40-42`（Stream TUS 上传在用），CI secrets 也已配置。因此无需新增 secret 管道，**只需在 Cloudflare 面板为现有 token 追加 `Account Analytics Read` 权限**。

## 4. 架构与数据流

```
访问 GET /feed/:id
  └─ 响应立即返回（不再等待统计写入）
     └─ ctx.waitUntil(AE.writeDataPoint({...}))      ← 非阻塞，不触碰 D1
           ↓
       Analytics Engine（原始明细，保留 3 个月）
           ↓  cron 每日聚合一次（SQL API）
       D1 analytics_daily / analytics_dim_daily      ← 永久保留
           ↓
    GET /analytics/*（adminOnly）──→ 客户端 /admin/analytics 看板
```

写路径的 D1 **写操作**从 2 次（UPDATE `visit_stats` + INSERT `visits`）降为 **0 次**，替换为 1 次非阻塞 `writeDataPoint`。仍保留 1 次 `visit_stats` 的 SELECT，用于返回文章页展示的 pv/uv（见 6.3）。

### 4.1 cron 调度

复用现有的 `*/20 * * * *` 触发器（`wrangler.toml` 的 `[triggers]`），在
`server/src/runtime/scheduled-handler.ts` 中追加 `analyticsCrontab`。该函数内部依据
`info` 表的 `analytics_last_rollup` 游标判断是否有未聚合的 UTC 日期，没有则直接返回，
因此不会每 20 分钟重复执行聚合。

### 4.2 降级行为

当 AE binding 未配置、`CLOUDFLARE_API_TOKEN` 缺失、或 token 缺少 Analytics Read 权限时：

- 写入侧：`writeDataPoint` 静默跳过，不抛异常，不影响页面响应。
- cron 侧：记录一次告警日志后跳过本轮聚合，游标不推进。
- 读取侧：`GET /analytics/live` 返回 `{ available: false }` 而非 HTTP 500；其余三个端点读 D1，照常工作。

## 5. 数据模型

### 5.1 Analytics Engine 数据点

`index` 每个数据点只能有一个，且 ≤96 字节。

| 字段 | 内容 |
| --- | --- |
| `indexes[0]` | `feed_id`（字符串化）— 作为采样键，保证热门文章不因采样被丢弃 |
| `blob1` | 请求路径 |
| `blob2` | referrer host（同源或空 → `direct`） |
| `blob3` | country（来自 `cf.country`） |
| `blob4` | city（来自 `cf.city`） |
| `blob5` | device：`mobile` / `desktop` |
| `blob6` | 访客指纹哈希前 16 位 hex |
| `blob7` | feed 标题（便于 live 查询直接显示，无需 join） |
| `double1` | 恒为 `1`（计数；AE 采样时自动附带 `_sample_interval`） |

### 5.2 D1 新增表

写入 `server/src/db/schema.ts`，迁移文件 `server/sql/0016.sql`（沿用现有手工编号 + `UPDATE info SET value='16' WHERE key='migration_version'` 惯例）。

```sql
CREATE TABLE analytics_daily (
  date    TEXT    NOT NULL,          -- UTC 'YYYY-MM-DD'
  feed_id INTEGER NOT NULL,
  pv      INTEGER NOT NULL DEFAULT 0,
  uv      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, feed_id)
);

CREATE TABLE analytics_dim_daily (
  date      TEXT    NOT NULL,        -- UTC 'YYYY-MM-DD'
  dim_type  TEXT    NOT NULL,        -- 'referrer' | 'country' | 'device'
  dim_value TEXT    NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, dim_type, dim_value)
);

CREATE INDEX analytics_daily_date_idx ON analytics_daily (date);
CREATE INDEX analytics_dim_daily_date_type_idx ON analytics_dim_daily (date, dim_type);
```

维度使用单表 + `dim_type` 判别列，避免为每个维度建独立表。

### 5.3 现有表处理

- **`visit_stats`：保留。** 文章详情页的公开 pv/uv 继续读该表，历史累计数字不丢失。改为由 cron 从 AE 聚合结果累加回写，不再在请求路径中读写 `hll_data`。`hll_data` 列保留但停止更新。
- **`visits`：在 `0016.sql` 中 `DROP TABLE`。** 该表只写不读，同时是明文 IP 落盘的唯一来源。`server/src/db/schema.ts` 中的 `visits` 定义一并删除。

## 6. 采集实现

新建 `server/src/utils/analytics.ts`，导出 `recordPageView(c, { feedId, title })`。

### 6.1 访客指纹

```
fingerprint = SHA-256(ip + user-agent + feedId + dailySalt).slice(0, 16)
dailySalt   = HMAC(seed, utcDateString)
```

`seed` 是一次性生成并存于 `info` 表的随机值；`dailySalt` 按 UTC 日期派生，**每日轮换**。

结果：无法跨天关联同一访客，也无法从存储值反推 IP。

**已知取舍（已与用户确认接受）：** 月度 UV 只能取各日 UV 之和，属于**高估的近似值**。
看板 UI 必须对月度/季度 UV 标注「近似值（各日之和）」，不得呈现为精确去重数字。
日 UV 则是当日精确去重值。

### 6.2 其他维度

- **referrer**：只取 `new URL(ref).host`，不存完整 URL（避免查询参数泄漏与隐私问题）。同源或为空记为 `direct`。
- **地理**：从 `c.req.raw.cf` 读 `country` / `city`，零额外成本（`comments` 表已在用同一来源）。
- **设备**：由 User-Agent 粗分为 `mobile` / `desktop`。
- **Bot**：由 UA 识别为爬虫的请求**完全不打点**，不计入任何统计。

### 6.3 开关与接入点

受现有 `counter.enabled` 客户端配置控制（`server/src/services/feed.ts:262` 已在读该键），不新增配置项。

调用点：`server/src/services/feed.ts` 的 `GET /feed/:id`，替换掉第 261-305 行的同步统计逻辑。
该 handler 仍需返回 `pv` / `uv` 字段，值改为直接读 `visit_stats`（单次 SELECT，无写入）。

## 7. 查询层与 API

新建 `server/src/services/analytics.ts`，所有端点用 `adminOnly`（`server/src/core/route-boundaries.ts:27`）包装，在 `server/src/core/register-routes.ts` 中注册 `app.route("/analytics", AnalyticsService())`。

| 端点 | 数据源 | 返回 |
| --- | --- | --- |
| `GET /analytics/overview?days=30` | D1 | 总 PV/UV、今日、昨日、环比、按天时间序列 |
| `GET /analytics/top-feeds?days=30&limit=20` | D1 | 热门文章 Top N（join `feeds` 取标题） |
| `GET /analytics/dimensions?days=30&type=referrer\|country\|device` | D1 | 指定维度的分布 Top N |
| `GET /analytics/live?hours=24` | AE SQL API | 近期下钻，覆盖 D1 尚未聚合的当天数据 |

仅 `/analytics/live` 走外部 HTTP。

**参数约定：**

- `days` 只接受 `7` / `30` / `90`，其他值一律回退为 `30`（不接受任意整数，避免管理端被用于构造重查询）。
- `limit` 上限 100，超出则截断。
- `hours` 只接受 `1` / `24`，其他值回退为 `24`。

**维度粒度：** `analytics_dim_daily` 不含 `feed_id`，因此 referrer / country / device 分布是**站点级**的，不支持按单篇文章下钻。需要单篇下钻时走 `/analytics/live`（限近 3 个月）。

### 7.1 AE 查询封装

新建 `server/src/utils/analytics-query.ts`，职责：

1. 拼接 SQL 文本。
2. 附加 `Authorization: Bearer ${env.CLOUDFLARE_API_TOKEN}` 并 POST 到 SQL API。
3. token 缺失或响应非 200 时抛出可识别的 `AnalyticsUnavailableError`，由路由层捕获后降级为 `{ available: false }`。

### 7.2 cron 聚合逻辑

`analyticsCrontab(env, db, ...)`：

1. 读 `info` 表的 `analytics_last_rollup` 游标（UTC 日期字符串）。
2. 对每个未聚合且仍在 AE 3 个月窗口内的日期，发送 3 条 SQL：
   - 按 `index1`（feed_id）聚合 PV
   - 按 `blob2/blob3/blob5` 分别聚合维度计数
   - `SELECT COUNT(DISTINCT blob6)` 按 feed 求当日 UV
3. 批量 upsert 进 `analytics_daily` / `analytics_dim_daily`，并把当日 pv/uv 累加回写 `visit_stats`。
4. 推进游标。

**D1 聚合数据永久保留，不做清理。** 每天新增行数约为「当天有访问的文章数 + 三个维度的去重取值数」，量级在百行以内，无需保留期策略。（此处与第 4 节「永久保留」一致；唯一被清理的是 AE 自身的 3 个月窗口，由 Cloudflare 自动处理。）

**游标落后处理：** 若游标早于 AE 可查窗口起点（例如站点停机一个月），直接跳到窗口起点，不做无限重试。跳过的区间记录一条日志。

### 7.3 共享类型

`packages/api/src/types.ts` 新增 `AnalyticsOverview` / `AnalyticsTopFeed` / `AnalyticsDimension` / `AnalyticsLiveResponse`，由 `packages/api/src/index.ts` 导出。客户端 `client/src/api/client.ts` 增加对应方法。

这符合 `AGENTS.md` 中「`packages/api` 用于共享 API 契约、schema、传输层类型」的定位；不新增任何 package。

## 8. 前端

新建 `client/src/page/analytics.tsx`，完全沿用现有 admin 页惯例：

| 文件 | 改动 |
| --- | --- |
| `client/src/app/routes.tsx` | 新增 `<AdminRoute path="/admin/analytics" requirePermission title={t("analytics.title")} description={t("admin.analytics_description")}>`，与第 76 行的 queue-status 同形 |
| `client/src/components/admin-layout.tsx` | 第 70 行附近新增 `<AdminNavItem href="/admin/analytics" icon="ri-bar-chart-line" label={t("analytics.title")} />` |
| `client/public/locales/{en,zh-CN,zh-TW,ja}/translation.json` | 新增 `analytics.*` 文案键（四个语言全部补齐） |

数据获取使用现有 `useApiResource` hook；UI 使用 `@rin/ui` 的 `SettingsCard` / `SettingsCardHeader` / `SettingsCardBody` / `SettingsBadge` / `Spinner`，与 `client/src/page/queue-status.tsx` 保持一致。

### 8.1 页面结构

1. 四个数字卡：今日 PV/UV、区间 PV/UV，带环比箭头（月度及以上 UV 标注「近似值」）。
2. 按天趋势折线图。
3. 热门文章 Top 20 列表。
4. 三个维度分布（来源 / 国家 / 设备）横向条形图。
5. 时间范围切换：7 / 30 / 90 天。

### 8.2 图表实现

**不引入第三方图表库**，用内联 SVG 绘制折线图与横向条形图。理由：这是后台单页看板，引入 recharts 量级的依赖（数十 KB）收益不成比例，且现有前端没有任何图表库，引入即产生长期维护面。

### 8.3 不改动项

`client/src/page/feed.tsx:216-223` 的公开 pv/uv 展示保持原样。

## 9. 部署配置

**必须同时修改两个 wrangler.toml 生成器，否则绑定会在部署时被抹掉。**

`cli/src/tasks/deploy-cf.ts:147-150` 已明确记录了这一 bug 类别：
"Dashboard-only STREAM bindings are wiped when generated wrangler.toml omits [stream] — same class of bug as R2 / former IP2REGION"。

需要追加 `[[analytics_engine_datasets]]` 块的位置：

- `scripts/ensure-wrangler-toml.ts`
- `cli/src/tasks/deploy-cf.ts`

```toml
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "rin_analytics"
```

同时在 `server/src/custom-env.d.ts` 的 `Env` 接口中新增 `ANALYTICS?: AnalyticsEngineDataset;`（可选，以支持降级）。

### 9.1 需要人工完成的操作

在 Cloudflare 面板为现有 API token 追加 `Account | Account Analytics | Read` 权限。

未完成时系统不会崩溃：`/analytics/live` 返回 `available: false`，cron 聚合跳过，看板呈现空数据状态。

## 10. 测试

遵循 `AGENTS.md`：服务端测试位于 `server/src/**/__tests__/*.test.ts`，统一使用 `bun:test`，不引入其他测试运行器。

| 测试文件 | 覆盖点 |
| --- | --- |
| `analytics.test.ts` | 指纹每日轮换（同 IP 跨天产生不同哈希）；referrer 同源被记为 `direct`；bot UA 不打点；`counter.enabled=false` 时不打点；`ANALYTICS` binding 缺失时不抛异常 |
| `analytics-query.test.ts` | SQL 拼接正确性；token 缺失时的降级路径；AE 返回非 200 时的降级路径（mock fetch） |
| `analytics-rollup.test.ts` | 游标推进；同一天重复执行幂等；游标超出 3 个月窗口时跳到窗口起点；pv/uv 正确回写 `visit_stats` |
| `analytics-routes.test.ts` | 非管理员请求四个端点均返回 403 |

## 11. 实施顺序

按 TDD 推进，每步可独立验证：

1. `[[analytics_engine_datasets]]` 加入两个 wrangler 生成器；`custom-env.d.ts` 补 `Env.ANALYTICS` 类型。
2. `server/sql/0016.sql`：建两张新表、`DROP TABLE visits`、更新 `migration_version` 为 `'16'`；`server/src/db/schema.ts` 同步新增两表定义并删除 `visits`。
3. `server/src/utils/analytics.ts` + 测试 → 接入 `server/src/services/feed.ts`，删除原同步 HLL 逻辑。
4. `server/src/utils/analytics-query.ts` + `analyticsCrontab` + 测试 → 接入 `scheduled-handler.ts`。
5. `server/src/services/analytics.ts` + `packages/api` 类型 + `client/src/api/client.ts` 方法 + 测试 → 注册进 `register-routes.ts`。
6. `client/src/page/analytics.tsx` + 路由 + 导航 + 四语言文案。
7. 验证：`bun run check`、`bun run test`、`bun run format:check` 全部通过。

## 12. 参考资料

- [Workers Analytics Engine — Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Workers Analytics Engine — Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Workers Analytics Engine — SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)
- [Types of analytics](https://developers.cloudflare.com/analytics/types-of-analytics/)
