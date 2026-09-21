import { relations, sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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

export const visitStats = sqliteTable("visit_stats", {
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull().primaryKey(),
    pv: integer("pv").default(0).notNull(),
    uv: integer("uv").default(0).notNull(),
    pvBaseline: integer("pv_baseline").default(0).notNull(),
    uvBaseline: integer("uv_baseline").default(0).notNull(),
    hllData: text("hll_data").default("").notNull(),
    updatedAt: updated_at,
});

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
    publishedAt: integer("published_at", { mode: "timestamp" }),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    statusIdx: index("sharing_reports_status_idx").on(table.status),
    periodIdx: index("sharing_reports_period_idx").on(table.periodStart, table.periodEnd),
}));

export const financeTransactions = sqliteTable("finance_transactions", {
    id: integer("id").primaryKey(),
    reportId: integer("report_id").references(() => sharingReports.id, { onDelete: "set null" }),
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
    /** 评论者 IP，仅管理员可见，公开接口不返回 */
    ip: text("ip").default("").notNull(),
    /** 展示用归属地标签，如 `江苏省·南京市` */
    location: text("location").default("").notNull(),
    country: text("country").default("").notNull(),
    province: text("province").default("").notNull(),
    city: text("city").default("").notNull(),
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

export const mediaAssets = sqliteTable("media_assets", {
    id: text("id").primaryKey(),
    uid: integer("uid").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'set null' }),
    momentId: integer("moment_id").references(() => moments.id, { onDelete: 'set null' }),
    provider: text("provider").default("r2").notNull(),
    streamUid: text("stream_uid"),
    playbackUrl: text("playback_url"),
    type: text("type").notNull(),
    objectKey: text("object_key").notNull().unique(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    status: text("status").default("ready").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, (table) => ({
    uidIdx: index("media_assets_uid_idx").on(table.uid),
    feedIdx: index("media_assets_feed_idx").on(table.feedId),
    momentIdx: index("media_assets_moment_idx").on(table.momentId),
    statusIdx: index("media_assets_status_idx").on(table.status),
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

export const mediaAssetsRelations = relations(mediaAssets, ({ one }) => ({
    user: one(users, {
        fields: [mediaAssets.uid],
        references: [users.id],
    }),
    feed: one(feeds, {
        fields: [mediaAssets.feedId],
        references: [feeds.id],
    }),
    moment: one(moments, {
        fields: [mediaAssets.momentId],
        references: [moments.id],
    }),
}));

export const sharingReportsRelations = relations(sharingReports, ({ many }) => ({
    transactions: many(financeTransactions),
}));

export const financeTransactionsRelations = relations(financeTransactions, ({ one }) => ({
    report: one(sharingReports, {
        fields: [financeTransactions.reportId],
        references: [sharingReports.id],
    }),
}));
