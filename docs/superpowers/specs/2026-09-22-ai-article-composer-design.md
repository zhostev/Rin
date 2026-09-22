# AI 文章生成（AI Article Composer）设计

- 日期：2026-09-22
- 状态：已确认，待实施
- 分支基点：`main` @ `2aa5ddd`

## 1. 目标与非目标

### 目标

管理员给出**一句话选题**和**一组媒体库素材（每个附一句说明）**，系统异步生成整篇 Markdown 文章并**直接发布上线**。

### 非目标（明确 YAGNI）

- **编辑器内联助手**（选中文本做润色/续写/翻译）—— 不做
- **定时自动选题与自动生成** —— 只做手动触发，不接 cron
- **外部素材源**（RSS 抓取、URL 抓取、友链更新驱动）—— 不做
- **多模态视觉理解** —— 模型不"看"图片，只按管理员写的说明排布素材
- **SSE 流式输出** —— 与结构化字段解析冲突，且与"直接发布"目标不符
- **生成结果的人工审阅环节** —— 用户明确选择"直接发布上线"
- **生成任务的历史记录与原样重试** —— 不建 job 表，失败后重新填一次表单
- 批量生成、文章改写、多语言版本

### 一处已声明的风险

"生成成功即公开、不经人工审阅"是用户在被明确告知风险（模型胡言、格式坏掉、素材插错都会直接上线）后做出的决定。本设计据此实现，并加入 §6 的格式闸门作为**唯一**的自动防线 —— 它只拦明确坏掉的输出，**不做任何质量判断**。

## 2. 现状：可复用的既有设施

本模块不是从零开始。仓库中已有：

| 设施 | 位置 |
|---|---|
| 通用 LLM 调用层（OpenAI 兼容 + Workers AI；openai/claude/gemini/deepseek 预设；错误映射；`<think>` 剥离） | `server/src/utils/ai.ts` |
| AI 配置命名空间 `ai_summary.*`，`api_key` 已登记为敏感字段 | `packages/config/src/index.ts:43` |
| Cloudflare Queues 生产者/消费者 + `idle/pending/processing/completed/failed` 状态机 | `server/src/queue/`、`server/src/runtime/queue-handler.ts` |
| 队列状态页 | `client/src/page/queue-status.tsx` |
| 媒体库（R2 图片 + Cloudflare Stream 视频） | `server/src/services/media.ts` |
| 正文素材自动绑定 `syncMediaForFeed(content)` | `server/src/services/media.ts:277` |
| 写作页与 Markdown 编辑器 | `client/src/page/writing.tsx`、`client/src/components/markdown_editor.tsx` |

真正的设计问题不是"怎么调模型"，而是**生成能力如何接入既有的发布链路**，以及**配置层如何从已被占用的 `ai_summary.*` 命名空间中长出通用的 AI 能力层**。

## 3. 模块边界与文件落点

按 AGENTS.md 的分层要求，新增代码分"纯逻辑 / 应用装配 / 契约"三层，**不新建任何 workspace package**。

| 文件 | 性质 | 职责 |
|---|---|---|
| `server/src/utils/ai-compose.ts` | 新增·纯函数 | `buildComposePrompt()`、`parseComposedArticle()`、`renderMediaPlaceholders()`。不依赖 `env`/`db` |
| `server/src/services/feed-ai-compose.ts` | 新增·应用装配 | `enqueueFeedAICompose()`、`processFeedAIComposeTask()`、`registerFeedAIComposeRoutes()`。与既有 `feed-ai-summary.ts` 严格对称 |
| `client/src/components/media-picker.tsx` | 新增·UI | 媒体库多选 + 逐项说明输入 |
| `server/src/utils/ai.ts` | 改造 | 参数化 `max_tokens`/`temperature`；导出统一入口 `generateAIText()` |
| `server/src/utils/db-config.ts` | 改造 | `getAIWriterConfig()`、`setAIWriterConfig()` |
| `packages/config/src/index.ts` | 改造 | `ai_writer.*` 常量与敏感字段登记 |
| `packages/api/src/{types,schemas}.ts` | 改造 | 请求/响应契约与校验 schema |
| `server/src/queue/tasks.ts` | 改造 | `QueueTask` 由单类型改为 union |
| `server/src/runtime/queue-handler.ts` | 改造 | consumer 增加分支 |
| `server/src/db/schema.ts` | 改造 | `feeds` 增两列 |
| `server/src/services/feed.ts` | 改造 | 挂载路由（一行）；详情响应裁列（见 §7.1） |
| `client/src/page/writing.tsx` | 改造 | 顶部折叠面板入口 |
| `client/src/api/client.ts` | 改造 | 两个新方法 |

**路由不写进 `feed.ts`** —— 该文件已 664 行。`feed-ai-compose.ts` 导出 `registerFeedAIComposeRoutes(app)`，`FeedService()` 中只增一行挂载调用。这符合 AGENTS.md「路由注册、中间件装配、错误映射应在重构时分离」一条。

## 4. 数据模型

**不建新表。** `feeds` 增两列，与既有 `ai_summary_*` 三列对称：

```ts
ai_compose_status: text("ai_compose_status").default("idle").notNull(),
ai_compose_error:  text("ai_compose_error").default("").notNull(),
```

取值域：`idle | pending | processing | completed | failed`。

**不需要第三个"内容列"** —— compose 的产物就是 `content` 本身。

**选题与素材说明不落库**，只存在于 queue message payload 中。Cloudflare Queues 自带重试且 payload 随消息走；落库只会多出一张需要清理的表。代价已知并接受：任务失败后无法在后台"原样重试"，只能重新填一次表单。

迁移经 `bun run db:generate` 生成。

## 5. 数据流

```
管理员：一句话选题 + 媒体库素材（每个附说明）+ 长度/风格
         │
         ▼
POST /api/feed/ai-compose   (adminOnly)
         │  ① 校验 ai_writer 已启用；校验素材 id 归属当前用户
         │  ② 建占位 feed：title=选题, content="", draft=1,
         │     ai_compose_status='pending'
         │  ③ 入队 FEED_AI_COMPOSE_TASK
         │  ④ 立即 202 返回 { id, status }
         ▼
Queue consumer（15 分钟执行预算）
   ① 校验 updatedAt 与 payload 一致（复用既有 matchesExpectedUpdatedAt）
      —— 不一致说明生成期间有人工编辑，放弃自动发布，不覆盖手改
   ② status → 'processing'
   ③ buildComposePrompt() → generateAIText()（ai_writer 配置）
   ④ stripReasoningTags() → parseComposedArticle()
      → renderMediaPlaceholders()
   ⑤ 格式闸门（§6）：不通过 → status='failed'，保持 draft=1，结束
   ⑥ 通过 → 写入 title/summary/content，draft=0，listed 按请求
             + 绑定 hashtags
             + syncMediaForFeed()          ← 素材绑定自动完成
             + syncFeedAISummaryQueueState() ← 与手工发布行为一致
             + clearFeedCache()
             status='completed'，文章上线
```

第 ① 步的 `updatedAt` 校验是从 `feed-ai-summary.ts` 直接继承的既有机制，不是新发明。

## 6. 生成内核

### 6.1 输出契约：front-matter，不用 JSON

要求模型输出：

```
---
title: 文章标题
summary: 一句话摘要
tags: 标签一, 标签二
---

正文 Markdown……
```

**不用 JSON 的理由**：整篇 Markdown 塞进 JSON 字符串需转义全部换行与引号，模型在长输出中翻车概率显著更高，而正文恰是最不能坏的部分。front-matter 将结构化字段与自由正文分开，正文无需任何转义。

**解析器手写，不引入 YAML 依赖**（控制 Worker bundle 体积）：只识别 `title`/`summary`/`tags` 三个已知键，逐行 `key: value`，其余忽略。`tags` 支持逗号（中英文）与顿号分隔。

**容错**：无 front-matter 时，取正文首个 `# ` 标题作 `title`、其余作正文；仍无则交由格式闸门拦截。

### 6.2 素材：模型只写占位符，服务端做替换

仓库中素材引用有两套语法（见 `server/src/services/media.ts:177` 的 `extractMediaIds`）：

- 图片 → `![说明](/api/media/<id>/playback)`
- 音视频 → `<video data-rin-media-id="<id>"></video>` / `<audio ...>`

**不让模型直接产出这些语法。** prompt 中只给带编号的素材清单，模型在正文里写 `[[media:2]]`；服务端按素材类型做确定性替换。

换来四点：

1. 模型只需写一个编号，几乎不可能写错；手写 HTML 属性或长 URL 错一个字符即绑定失败
2. 引用语法正确性由代码保证，不依赖模型的格式服从性
3. 图片/视频语法差异对模型完全隐藏，prompt 更短且省 token
4. 可统计未被引用的素材 —— 管理员明确上传却未被使用的素材**追加至文末**，而非静默丢弃

未知编号（如只传 3 个素材而模型写了 `[[media:9]]`）直接剥除，不在正文留残渣。

### 6.3 格式闸门

只拦明确坏掉的输出，**不做质量判断**：

| 判据 | 处理 |
|---|---|
| `title` 解析为空 | `failed`，停在 `draft=1` |
| 正文剥除占位符后为空，或短于 100 字符 | `failed`，停在 `draft=1` |
| LLM 抛错或返回空 | `failed`，错误写入 `ai_compose_error` |
| 以上均通过 | 发布上线 |

解析前先跑 `stripReasoningTags()`，复用既有的推理模型 `<think>` 块处理。

## 7. API 契约

### 7.1 状态查询走独立端点

```
GET /api/feed/:id/ai-compose-status   (adminOnly, 不走缓存)
  → { status: 'idle'|'pending'|'processing'|'completed'|'failed', error: string }
```

**不复用 `GET /api/feed/:id` 的两个原因**（查证于 `server/src/services/feed.ts:228-287`）：

1. **该路由有缓存**。详情走 `cache.getOrSet(cacheKey, ...)`，轮询将持续命中陈旧快照，状态永不更新。
2. **该路由将整行原样返回给所有访客**。结尾为 `return c.json({ ...other, ... })`，未按权限裁列 —— `ai_compose_error` 将公开可见，而错误信息可能含 `API error 401: ...` 乃至自建 `api_url`。

第 2 点是**既有缺陷**：`ai_summary_error` 目前即以此方式泄露。本设计顺路修复 —— 详情响应在非 admin 时 `omit` 掉 `ai_compose_error` 与 `ai_summary_error`。这属于「改到哪里就把那里的问题一并修好」，不算扩大范围。

### 7.2 创建端点

```
POST /api/feed/ai-compose   (adminOnly)
{
  topic:  string,                           // 一句话选题，必填，非空
  assets: [{ id: string, note: string }],   // 媒体库素材 + 说明，可为空数组
  length?: 'short' | 'medium' | 'long',     // 见下表，默认 medium
  style?:  string,                          // 自由文本，可空
  listed?: boolean                          // 默认 true
}
→ 202 { id: number, status: 'pending' }
```

`length` 映射到 prompt 中的字数区间（中文字符），并据此推导 `max_tokens` 下限：

| 取值 | prompt 字数区间 |
|---|---|
| `short` | 600 – 1000 |
| `medium` | 1200 – 2000 |
| `long` | 2500 – 4000 |

字数区间仅作为 prompt 的软约束写入提示词，**不在格式闸门中校验** —— 模型写短了或写长了不构成"坏掉的输出"。`ai_writer.max_tokens` 若小于所选区间上限所需的 token 数，取二者较大值，避免长文被硬截断。

`assets[].id` **必须校验归属当前用户**，否则该接口可被用于探测他人媒体库。

## 8. 配置层

### 8.1 `ai_writer.*` 与空值继承

```
ai_writer.enabled        bool    默认 false
ai_writer.provider       ""  →  继承 ai_summary.provider
ai_writer.model          ""  →  继承 ai_summary.model
ai_writer.api_key        ""  →  继承 ai_summary.api_key      【敏感】
ai_writer.api_url        ""  →  继承 ai_summary.api_url
ai_writer.temperature    0.8
ai_writer.max_tokens     4000
ai_writer.system_prompt  ""  →  内置默认写作提示词
```

**空字符串即继承** —— 只填 `model` 即可实现"摘要用便宜模型、写文章用强模型"，无需重填 key 与 URL。

合并逻辑必须在 `getAIWriterConfig()` 中**显式实现**：`ConfigWrapper.get`（`packages/config/src/index.ts:78`）现有的"空值回落"只回落到静态默认值，无法表达跨命名空间继承。

`setAIWriterConfig()` 沿用 `setAIConfig` 既有规则：**`api_key` 传空串时跳过写入**，避免前端回显空值抹除已存的 key。

`ai_writer.api_key` 加入 `SENSITIVE_SERVER_CONFIG_FIELDS`，确保不出现在设置面板响应中。

设置页需明确标注"留空 = 继承摘要配置"。

### 8.2 `ai.ts` 参数化

```ts
export type AIGenerationOptions = { maxTokens?: number; temperature?: number };
```

`executeExternalAI` / `executeWorkerAI` 各增一个 options 参数，**默认值保持现有的 `max_tokens: 500` / `temperature: 0.3`**（`server/src/utils/ai.ts:135-136`）。摘要链路行为逐字不变。

另导出 `generateAIText(env, config, messages, options)`，将"worker-ai 还是外部 API"的分支判断收口。该分支当前在 `testAIModel` 与 `generateAISummaryResult` 中各抄一遍，compose 是第三个调用方。

## 9. 前端

### 9.1 入口

**写作页顶部的默认折叠面板**，不新增路由、不动导航、不加导航 i18n 条目。

理由在失败路径：生成失败停在 draft，此时需要的恰是"跳进编辑器接手"，而写作页本就是那个地方。

面板内容：选题输入框 + 素材选择器 + 长度/风格 + 生成按钮。

### 9.2 素材选择器

本模块前端的**主要工作量**。需拉取 `/api/media` 列表、缩略图多选、每个选中项配说明输入框。

既有的 `client/src/components/image-upload-input.tsx` 是"上传单张"形态，可复用部分有限。独立落为 `client/src/components/media-picker.tsx`，因媒体库页面将来大概率复用。

### 9.3 状态反馈

提交后取得 `id`，轮询 §7.1 状态端点，**间隔 3 秒、上限 5 分钟**。

| 结果 | 处理 |
|---|---|
| `completed` | 跳转 `/feed/:id` |
| `failed` | 弹出 `error`，提供"去编辑草稿"链接指向 `/writing/:id` |
| 轮询超时 | 提示"仍在生成，稍后到文章列表查看"，**不作失败处理** |

## 10. 测试

全部使用 `bun:test`，遵循仓库既有约定。

| 测试文件 | 覆盖重点 |
|---|---|
| `server/src/utils/__tests__/ai-compose.test.ts` | **最重的一块**。front-matter 解析（缺 title、缺 front-matter、tags 多种分隔符）；`[[media:N]]` 替换（图片/视频两种语法、未知编号剥除、未使用素材追加文末）；格式闸门各项判据 |
| `server/src/services/__tests__/feed-ai-compose.test.ts` | 状态机：`pending→processing→completed/failed`；`updatedAt` 不匹配时放弃；闸门失败时确保 `draft` 仍为 1 |
| `server/src/utils/__tests__/ai.test.ts` | **现有测试一行不改**，用以证明参数化未回归摘要链路 |
| 路由测试 | `adminOnly` 边界；非本人素材 id 被拒；状态端点拒绝非 admin |
| 配置测试 | `ai_writer.*` 空值继承；`api_key` 空串不抹除；敏感字段不出现在设置响应中 |

纯函数层（prompt 组装、解析、替换）无需任何 mock —— 这正是 §3 将其从 service 中拆出的回报。
