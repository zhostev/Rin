import { relations, sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const created_at = integer("created_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();
const updated_at = integer("updated_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();

export const feeds = sqliteTable("feeds", {
    id: integer("id").primaryKey(),
    alias: text("alias"),
    title: text("title"),
    summary: text("summary").default("").notNull(),
    ai_summary: text("ai_summary").default("").notNull(),
    ai_summary_status: text("ai_summary_status").default("idle").notNull(),
    ai_summary_error: text("ai_summary_error").default("").notNull(),
    // 0019 · AI 写作任务状态（feed-ai-compose.ts 读写；迁移已建列，schema 后补）
    aiComposeStatus: text("ai_compose_status").default("idle").notNull(),
    aiComposeError: text("ai_compose_error").default("").notNull(),
    content: text("content").notNull(),
    listed: integer("listed").default(1).notNull(),
    draft: integer("draft").default(1).notNull(),
    top: integer("top").default(0).notNull(),
    uid: integer("uid").references(() => users.id).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    aliasIdx: index("feeds_alias_idx").on(table.alias),
    visibilityOrderIdx: index("feeds_visibility_order_idx").on(
        table.draft,
        table.listed,
        table.top,
        table.createdAt,
        table.updatedAt,
    ),
    uidIdx: index("feeds_uid_idx").on(table.uid),
}));

export const moments = sqliteTable("moments", {
    id: integer("id").primaryKey(),
    content: text("content").notNull(),
    uid: integer("uid").references(() => users.id).notNull(),
    createdAt: created_at,
    updatedAt: updated_at
});

export const visits = sqliteTable("visits", {
    id: integer("id").primaryKey(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    ip: text("ip").notNull(),
    createdAt: created_at,
}, (table) => ({
    feedCreatedAtIdx: index("visits_feed_created_at_idx").on(table.feedId, table.createdAt),
}));

export const visitStats = sqliteTable("visit_stats", {
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull().primaryKey(),
    pv: integer("pv").default(0).notNull(),
    // 0016 新增列（聚合 rollup 读写；迁移已建列，schema 后补）
    uv: integer("uv").default(0).notNull(),
    pvBaseline: integer("pv_baseline").default(0).notNull(),
    uvBaseline: integer("uv_baseline").default(0).notNull(),
    hllData: text("hll_data").default("").notNull(),
    updatedAt: updated_at,
});

export const info = sqliteTable("info", {
    key: text("key").notNull().unique(),
    value: text("value").notNull(),
});

export const friends = sqliteTable("friends", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    desc: text("desc"),
    avatar: text("avatar").notNull(),
    url: text("url").notNull(),
    uid: integer("uid").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    accepted: integer("accepted").default(0).notNull(),
    health: text("health").default("").notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    acceptedOrderIdx: index("friends_accepted_order_idx").on(
        table.accepted,
        table.sort_order,
        table.createdAt,
    ),
}));

export const users = sqliteTable("users", {
    id: integer("id").primaryKey(),
    username: text("username").notNull(),
    openid: text("openid").notNull(),
    avatar: text("avatar"),
    password: text("password"),
    permission: integer("permission").default(0),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    openidIdx: index("users_openid_idx").on(table.openid),
}));

export const comments = sqliteTable("comments", {
    id: integer("id").primaryKey(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    userId: integer("user_id").references(() => users.id, { onDelete: 'cascade' }),
    content: text("content").notNull(),
    guestName: text("guest_name").default(""),
    guestEmail: text("guest_email").default(""),
    guestWebsite: text("guest_website").default(""),
    approved: integer("approved").default(1).notNull(),
    // 0015 新增列（评论地理归属；迁移已建列，schema 后补）
    ip: text("ip"),
    location: text("location"),
    country: text("country"),
    province: text("province"),
    city: text("city"),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    feedCreatedAtIdx: index("comments_feed_created_at_idx").on(table.feedId, table.createdAt),
}));

export const hashtags = sqliteTable("hashtags", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    nameIdx: index("hashtags_name_idx").on(table.name),
}));

export const feedHashtags = sqliteTable("feed_hashtags", {
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    hashtagId: integer("hashtag_id").references(() => hashtags.id, { onDelete: 'cascade' }).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    feedHashtagIdx: index("feed_hashtags_feed_hashtag_idx").on(table.feedId, table.hashtagId),
    hashtagFeedIdx: index("feed_hashtags_hashtag_feed_idx").on(table.hashtagId, table.feedId),
}));

export const cache = sqliteTable("cache", {
    id: integer("id").primaryKey(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    type: text("type").default("cache").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    // 复合唯一约束：key + type
    keyTypeUnique: unique().on(table.key, table.type),
    typeKeyIdx: index("cache_type_key_idx").on(table.type, table.key),
}));

export const feedsRelations = relations(feeds, ({ many, one }) => ({
    hashtags: many(feedHashtags),
    user: one(users, {
        fields: [feeds.uid],
        references: [users.id],
    }),
    comments: many(comments),
}));

export const momentsRelations = relations(moments, ({ one }) => ({
    user: one(users, {
        fields: [moments.uid],
        references: [users.id],
    })
}));

export const commentsRelations = relations(comments, ({ one }) => ({
    feed: one(feeds, {
        fields: [comments.feedId],
        references: [feeds.id],
    }),
    user: one(users, {
        fields: [comments.userId],
        references: [users.id],
    }),
}));

export const hashtagsRelations = relations(hashtags, ({ many }) => ({
    feeds: many(feedHashtags),
}));

export const feedHashtagsRelations = relations(feedHashtags, ({ one }) => ({
    feed: one(feeds, {
        fields: [feedHashtags.feedId],
        references: [feeds.id],
    }),
    hashtag: one(hashtags, {
        fields: [feedHashtags.hashtagId],
        references: [hashtags.id],
    }),
}));

// ============================================================================
// Stage 1 · 统一内容对象（Story / 内容包）
// ----------------------------------------------------------------------------
// 只增表、不改旧表：feeds 等旧表定义原封不动。
//
// distribution_records 故意不建（见 0013.sql 头注释）：用户已明确把邮件订阅、
// Podcast、YouTube、B 站分发全部延期到分发阶段。当前没有任何消费者会读写
// 该表，建一个死表只会扩大迁移面。分发阶段再以 0014+ 增量加入。
// ============================================================================

export const mediaAssets = sqliteTable("media_assets", {
    id: integer("id").primaryKey(),
    kind: text("kind").default("image").notNull(), // image/video/audio/gallery/attachment
    source: text("source").default("r2").notNull(), // r2/stream/cloudflare_images/external
    r2Key: text("r2_key"),
    streamUid: text("stream_uid"), // Stream UID，阶段 2 直传/webhook 时启用
    mime: text("mime").default("").notNull(),
    duration: integer("duration"), // 秒，可空
    width: integer("width"),
    height: integer("height"),
    altText: text("alt_text").default(""),
    title: text("title").default(""), // 阶段 2：音频上传标题等展示用标题
    streamStatus: text("stream_status").default("ready"), // 阶段 2：uploading/processing/ready/error，旧行默认 ready
    streamError: text("stream_error").default(""),
    streamMetaJson: text("stream_meta_json").default("{}").notNull(), // duration/thumbnail/readyToStream 等
    imagesId: text("images_id").default(""), // 阶段 2：Cloudflare Images 图片 ID
    imagesVariantsJson: text("images_variants_json").default("{}").notNull(), // {thumb,medium,large,public...} 完整 URL
    uploadSessionJson: text("upload_session_json").default("{}").notNull(), // 直传会话追踪
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    kindIdx: index("media_assets_kind_idx").on(table.kind),
    streamUidIdx: index("media_assets_stream_uid_idx").on(table.streamUid),
}));

export const stories = sqliteTable("stories", {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title"),
    status: text("status").default("draft").notNull(), // draft/scheduled/published/updated/archived
    summary: text("summary").default("").notNull(),
    coverAssetId: integer("cover_asset_id").references(() => mediaAssets.id),
    feedId: integer("feed_id").references(() => feeds.id).unique(), // post-to-story 映射键
    publishedAt: integer("published_at", { mode: 'timestamp' }),
    updatedAt: updated_at,
    verifiedAt: integer("verified_at", { mode: 'timestamp' }),
}, (table) => ({
    slugIdx: index("stories_slug_idx").on(table.slug),
    statusIdx: index("stories_status_idx").on(table.status),
    feedIdIdx: index("stories_feed_id_idx").on(table.feedId),
}));

export const contentBlocks = sqliteTable("content_blocks", {
    id: integer("id").primaryKey(),
    storyId: integer("story_id").references(() => stories.id, { onDelete: 'cascade' }).notNull(),
    type: text("type").default("rich_text").notNull(), // rich_text/quote/code/callout/image/gallery/video/audio/attachment/divider/cta
    position: integer("position").default(0).notNull(),
    payloadJson: text("payload_json").default("{}").notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    storyPositionIdx: index("content_blocks_story_position_idx").on(table.storyId, table.position),
}));

export const transcripts = sqliteTable("transcripts", {
    id: integer("id").primaryKey(),
    assetId: integer("asset_id").references(() => mediaAssets.id, { onDelete: 'cascade' }).notNull(),
    language: text("language").default("").notNull(),
    text: text("text").default("").notNull(),
    segmentsJson: text("segments_json").default("[]").notNull(),
    status: text("status").default("draft").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    assetIdx: index("transcripts_asset_idx").on(table.assetId),
}));

export const series = sqliteTable("series", {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title"),
    summary: text("summary").default("").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const storySeries = sqliteTable("story_series", {
    seriesId: integer("series_id").references(() => series.id, { onDelete: 'cascade' }).notNull(),
    storyId: integer("story_id").references(() => stories.id, { onDelete: 'cascade' }).notNull(),
    position: integer("position").default(0).notNull(),
    createdAt: created_at,
}, (table) => ({
    pk: primaryKey({ columns: [table.seriesId, table.storyId] }),
    storyIdx: index("story_series_story_idx").on(table.storyId, table.position),
}));

// Stage 3 · 聚合分析事件：只做聚合统计，不收任何 PII
// （不收 IP / UA / cookie）。原始事件按行存，聚合在查询时按天 GROUP BY。
export const mediaEvents = sqliteTable("media_events", {
    id: integer("id").primaryKey(),
    eventType: text("event_type").notNull(), // video_play/audio_play/story_read/media_view
    assetId: integer("asset_id"),
    storyId: integer("story_id"),
    createdAt: integer("created_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull(),
}, (table) => ({
    typeCreatedIdx: index("media_events_type_created_idx").on(table.eventType, table.createdAt),
}));

export const storyRelations = sqliteTable("story_relations", {
    fromId: integer("from_id").references(() => stories.id, { onDelete: 'cascade' }).notNull(),
    toId: integer("to_id").references(() => stories.id, { onDelete: 'cascade' }).notNull(),
    relationType: text("relation_type").default("related").notNull(), // prev_next/related/supersedes/cites/derives
    createdAt: created_at,
}, (table) => ({
    pk: primaryKey({ columns: [table.fromId, table.toId, table.relationType] }),
    toIdx: index("story_relations_to_idx").on(table.toId),
}));

export const revisions = sqliteTable("revisions", {
    id: integer("id").primaryKey(),
    storyId: integer("story_id").references(() => stories.id, { onDelete: 'cascade' }).notNull(),
    version: integer("version").notNull(),
    summary: text("summary").default("").notNull(),
    snapshotKey: text("snapshot_key").default("").notNull(),
    createdAt: created_at,
}, (table) => ({
    storyVersionIdx: index("revisions_story_version_idx").on(table.storyId, table.version),
}));

export const aiJobs = sqliteTable("ai_jobs", {
    id: integer("id").primaryKey(),
    jobType: text("job_type").notNull(),
    inputRefsJson: text("input_refs_json").default("[]").notNull(),
    modelRef: text("model_ref").default("").notNull(),
    status: text("status").default("pending").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    statusIdx: index("ai_jobs_status_idx").on(table.status),
}));

export const aiArtifacts = sqliteTable("ai_artifacts", {
    id: integer("id").primaryKey(),
    jobId: integer("job_id").references(() => aiJobs.id, { onDelete: 'cascade' }).notNull(),
    outputJson: text("output_json").default("{}").notNull(),
    acceptedAt: integer("accepted_at", { mode: 'timestamp' }),
    createdAt: created_at,
}, (table) => ({
    jobIdx: index("ai_artifacts_job_idx").on(table.jobId),
}));

/** 向量清单：story_id -> 本次 embed 实际写入 Vectorize 的 vector id 列表（JSON 数组） */
export const storyVectors = sqliteTable("story_vectors", {
    storyId: integer("story_id").primaryKey(),
    vectorIdsJson: text("vector_ids_json").default("[]").notNull(),
    updatedAt: updated_at,
});

export const storiesRelations = relations(stories, ({ many, one }) => ({
    blocks: many(contentBlocks),
    revisions: many(revisions),
    series: many(storySeries),
    outgoingRelations: many(storyRelations, { relationName: "from_story" }),
    incomingRelations: many(storyRelations, { relationName: "to_story" }),
    cover: one(mediaAssets, {
        fields: [stories.coverAssetId],
        references: [mediaAssets.id],
    }),
    feed: one(feeds, {
        fields: [stories.feedId],
        references: [feeds.id],
    }),
}));

export const contentBlocksRelations = relations(contentBlocks, ({ one }) => ({
    story: one(stories, {
        fields: [contentBlocks.storyId],
        references: [stories.id],
    }),
}));

export const mediaAssetsRelations = relations(mediaAssets, ({ many }) => ({
    transcripts: many(transcripts),
}));

export const transcriptsRelations = relations(transcripts, ({ one }) => ({
    asset: one(mediaAssets, {
        fields: [transcripts.assetId],
        references: [mediaAssets.id],
    }),
}));

export const seriesRelations = relations(series, ({ many }) => ({
    stories: many(storySeries),
}));

export const storySeriesRelations = relations(storySeries, ({ one }) => ({
    series: one(series, {
        fields: [storySeries.seriesId],
        references: [series.id],
    }),
    story: one(stories, {
        fields: [storySeries.storyId],
        references: [stories.id],
    }),
}));

export const storyRelationsRelations = relations(storyRelations, ({ one }) => ({
    from: one(stories, {
        fields: [storyRelations.fromId],
        references: [stories.id],
        relationName: "from_story",
    }),
    to: one(stories, {
        fields: [storyRelations.toId],
        references: [stories.id],
        relationName: "to_story",
    }),
}));

export const revisionsRelations = relations(revisions, ({ one }) => ({
    story: one(stories, {
        fields: [revisions.storyId],
        references: [stories.id],
    }),
}));

export const aiJobsRelations = relations(aiJobs, ({ many }) => ({
    artifacts: many(aiArtifacts),
}));

export const aiArtifactsRelations = relations(aiArtifacts, ({ one }) => ({
    job: one(aiJobs, {
        fields: [aiArtifacts.jobId],
        references: [aiJobs.id],
    }),
}));

// Stage 4 · AI Studio 用量记账：每次 AI 调用记一行。
// job_id 可空（/api/ask 等非 job 调用直接记账）；cost 恒 0，字段为未来预留。
export const aiUsage = sqliteTable("ai_usage", {
    id: integer("id").primaryKey(),
    jobId: integer("job_id").references(() => aiJobs.id, { onDelete: 'set null' }),
    model: text("model").default("").notNull(),
    tokensIn: integer("tokens_in").default(0).notNull(),
    tokensOut: integer("tokens_out").default(0).notNull(),
    costUsdEst: real("cost_usd_est").default(0).notNull(),
    createdAt: integer("created_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull(),
}, (table) => ({
    createdIdx: index("ai_usage_created_idx").on(table.createdAt),
    modelIdx: index("ai_usage_model_idx").on(table.model),
}));

// Stage 4 · AI Studio 总开关与日配额（文本 kv）。
export const aiSettings = sqliteTable("ai_settings", {
    key: text("key").primaryKey(),
    value: text("value").default("").notNull(),
    updatedAt: updated_at,
});

// ============================================================================
// 上游基线迁移 0016 · 访问聚合表
// ----------------------------------------------------------------------------
// Drizzle 定义后补：services/analytics.ts（/analytics）、analytics-rollup.ts
// 早已引用这两张表，schema 一直缺失。字段与 server/sql/0016.sql 一一对应。
// ============================================================================

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

// ============================================================================
// 上游基线迁移 0017 · 公开分享报告（sharing_reports / finance_transactions）
// ----------------------------------------------------------------------------
// Drizzle 定义后补：services/sharing-reports.ts（/reports）已引用，schema
// 一直缺失。字段与 server/sql/0017.sql 一一对应。
// ============================================================================

export const sharingReports = sqliteTable("sharing_reports", {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    goals: text("goals").default("").notNull(),
    summary: text("summary").default("").notNull(),
    status: text("status").default("draft").notNull(),
    metricsJson: text("metrics_json").default("{}").notNull(),
    financeJson: text("finance_json").default("{}").notNull(),
    publishedAt: integer("published_at", { mode: 'timestamp' }),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    statusIdx: index("sharing_reports_status_idx").on(table.status),
    periodIdx: index("sharing_reports_period_idx").on(table.periodStart, table.periodEnd),
}));

export const financeTransactions = sqliteTable("finance_transactions", {
    id: integer("id").primaryKey(),
    reportId: integer("report_id").references(() => sharingReports.id, { onDelete: 'set null' }),
    type: text("type").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    description: text("description").default("").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").default("CNY").notNull(),
    occurredAt: text("occurred_at").notNull(),
    receiptUrl: text("receipt_url").default("").notNull(),
    isAnonymous: integer("is_anonymous").default(1).notNull(),
    status: text("status").default("confirmed").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    reportIdx: index("finance_transactions_report_idx").on(table.reportId),
    typeDateIdx: index("finance_transactions_type_date_idx").on(table.type, table.occurredAt),
    statusIdx: index("finance_transactions_status_idx").on(table.status),
}));

export const financeTransactionsRelations = relations(financeTransactions, ({ one }) => ({
    report: one(sharingReports, {
        fields: [financeTransactions.reportId],
        references: [sharingReports.id],
    }),
}));
