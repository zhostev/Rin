// ============================================================================
// Shared API Types - Used by both client and server
// ============================================================================

// Common types
export interface ApiResponse<T> {
  data?: T;
  error?: {
    status: number;
    value: string;
  };
}

export interface RequestOptions {
  headers?: Record<string, string>;
}

// ============================================================================
// Feed Types
// ============================================================================

export interface Feed {
  id: number;
  title: string | null;
  content: string;
  uid: number;
  createdAt: string;
  updatedAt: string;
  ai_summary: string;
  ai_summary_status: "idle" | "pending" | "processing" | "completed" | "failed";
  ai_summary_error: string;
  hashtags: Array<{ id: number; name: string }>;
  user: {
    avatar: string | null;
    id: number;
    username: string;
  };
  pv: number;
  uv: number;
  top?: number;
}

export interface FeedListResponse {
  size: number;
  data: Array<{
    id: number;
    title: string | null;
    summary: string;
    hashtags: Array<{ id: number; name: string }>;
    user: {
      avatar: string | null;
      id: number;
      username: string;
    };
    avatar: string | null;
    createdAt: string;
    updatedAt: string;
    pv: number;
    uv: number;
  }>;
  hasNext: boolean;
}

export interface TimelineItem {
  id: number;
  title: string | null;
  createdAt: string;
}

export interface CreateFeedRequest {
  title: string;
  content: string;
  summary?: string;
  alias?: string;
  draft: boolean;
  listed: boolean;
  createdAt?: string;
  tags: string[];
}

export interface UpdateFeedRequest {
  title?: string;
  content?: string;
  summary?: string;
  alias?: string;
  listed: boolean;
  draft?: boolean;
  createdAt?: string;
  tags?: string[];
  top?: number;
}

export interface AdjacentFeed {
  id: number;
  title: string | null;
  summary: string;
  hashtags: Array<{ id: number; name: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface AdjacentFeedResponse {
  previousFeed: AdjacentFeed | null;
  nextFeed: AdjacentFeed | null;
}

// ============================================================================
// Story Types (Stage 1 · 统一内容对象)
// ============================================================================

/** stories.status 允许的取值 */
export type StoryStatus = 'draft' | 'scheduled' | 'published' | 'updated' | 'archived';

export const STORY_STATUSES: StoryStatus[] = ['draft', 'scheduled', 'published', 'updated', 'archived'];

/** content_blocks.type 允许的取值 */
export type ContentBlockType =
  | 'rich_text'
  | 'quote'
  | 'code'
  | 'callout'
  | 'image'
  | 'gallery'
  | 'video'
  | 'audio'
  | 'attachment'
  | 'divider'
  | 'cta';

export const CONTENT_BLOCK_TYPES: ContentBlockType[] = [
  'rich_text', 'quote', 'code', 'callout', 'image', 'gallery',
  'video', 'audio', 'attachment', 'divider', 'cta',
];

/** media_assets.kind 允许的取值 */
export type MediaAssetKind = 'image' | 'video' | 'audio' | 'gallery' | 'attachment';

/** media_assets.source 允许的取值 */
export type MediaAssetSource = 'r2' | 'stream' | 'external';

/** story_relations.relation_type 允许的取值 */
export type StoryRelationType = 'prev_next' | 'related' | 'supersedes' | 'cites' | 'derives';

export interface ContentBlock {
  id: number;
  storyId: number;
  type: ContentBlockType;
  position: number;
  /** JSON 字符串；按 type 解析（如 rich_text -> { markdown }） */
  payloadJson: string;
  revision: number;
}

/** 新建/更新内容块时的输入（payload 为对象，服务端负责序列化） */
export interface ContentBlockInput {
  type: ContentBlockType;
  position?: number;
  payload?: Record<string, unknown>;
  revision?: number;
}

export interface Story {
  id: number;
  slug: string;
  title: string | null;
  status: StoryStatus;
  summary: string;
  coverAssetId: number | null;
  /** post-to-story 映射键：非空表示该 story 映射自旧 feeds 行 */
  feedId: number | null;
  publishedAt: string | null;
  updatedAt: string;
  verifiedAt: string | null;
  blocks: ContentBlock[];
  /** 读取时 fallback 合成：命中 feeds.alias 而非 stories.slug */
  fromLegacyFeed?: boolean;
}

export interface StoryListResponse {
  size: number;
  data: Story[];
  hasNext: boolean;
}

export interface CreateStoryRequest {
  slug: string;
  title?: string;
  status?: StoryStatus;
  summary?: string;
  coverAssetId?: number;
  feedId?: number;
  publishedAt?: string;
  blocks?: ContentBlockInput[];
}

export interface UpdateStoryRequest {
  slug?: string;
  title?: string;
  status?: StoryStatus;
  summary?: string;
  coverAssetId?: number;
  feedId?: number;
  publishedAt?: string;
  verifiedAt?: string;
  /** 传入时整体替换该 story 的内容块 */
  blocks?: ContentBlockInput[];
}

export interface MediaAsset {
  id: number;
  kind: MediaAssetKind;
  source: MediaAssetSource;
  r2Key: string | null;
  /** Cloudflare Stream UID（阶段 2 启用） */
  streamUid: string | null;
  mime: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  altText: string | null;
}

export interface Transcript {
  id: number;
  assetId: number;
  language: string;
  text: string;
  segmentsJson: string;
  status: string;
}

export interface Series {
  id: number;
  slug: string;
  title: string | null;
  summary: string;
}

// ============================================================================
// Stage 3 · 媒体中心 Types（GET /api/media、/api/series/:slug、搜索转录、事件）
// ============================================================================

/** GET /api/media type 参数：gallery 视为 image（后端合并返回，前端按 story 聚合） */
export type MediaCenterTypeFilter = 'video' | 'audio' | 'image';

/** GET /api/media 返回的单个资产（只含已发布 story 的资产） */
export interface MediaCenterItem {
  id: number;
  kind: string;
  title: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  /** Stream UID；非 stream 源为 null */
  streamUid: string | null;
  /** stream 转码状态；非 stream 源为 null。无真实 Stream token 时 video 的值非 ready */
  streamStatus: string | null;
  thumbnailUrl: string | null;
  publicUrl: string | null;
  storyId: number;
  storySlug: string;
  storyTitle: string | null;
  /** 归属 story 的 publishedAt 年份 */
  year: number | null;
  updatedAt: string;
}

export interface MediaCenterListResponse {
  size: number;
  data: MediaCenterItem[];
  hasNext: boolean;
}

export interface SeriesStoryItem {
  storyId: number;
  slug: string;
  title: string | null;
  status: string;
  position: number;
  publishedAt: string | null;
  updatedAt: string;
  coverUrl?: string;
}

/** GET /api/series/:slug */
export interface SeriesDetailResponse {
  series: { id: number; slug: string; title: string | null; summary: string };
  stories: SeriesStoryItem[];
  completion: { total: number; published: number };
  recentUpdates: Array<{ storySlug: string; title: string | null; updatedAt: string }>;
}

/** GET /api/search/:keyword 的可选 transcripts 字段 */
export interface TranscriptSegmentHit {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptHit {
  assetId: number;
  storyId: number;
  storySlug: string;
  storyTitle: string | null;
  /** 命中位置前后各 ~40 字 */
  snippet: string;
  segments: TranscriptSegmentHit[];
}

/** POST /api/events 事件类型：只做聚合统计，不收任何 PII */
export type MediaEventType = 'video_play' | 'audio_play' | 'story_read' | 'media_view';

export interface MediaEventInput {
  type: MediaEventType;
  assetId?: number;
  storyId?: number;
}

/** GET /api/events/daily */
export interface EventsDailyResponse {
  days: number;
  from: string | null;
  to: string | null;
  data: Array<{
    date: string;
    total: number;
    counts: Record<MediaEventType, number>;
  }>;
}

// ============================================================================
// User Types
// ============================================================================

export interface UserProfile {
  id: number;
  username: string;
  avatar: string | null;
  permission: boolean;
}

export interface UpdateProfileRequest {
  username?: string;
  avatar?: string | null;
}

// ============================================================================
// Auth Types
// ============================================================================

export interface AuthStatus {
  github: boolean;
  password: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  token?: string;
  user: UserProfile;
}

// ============================================================================
// Tag Types
// ============================================================================

export interface Tag {
  id: number;
  name: string;
  count: number;
  createdAt: string;
  updatedAt: string;
}

export interface TagDetail extends Tag {
  feeds: Feed[];
}

// ============================================================================
// Comment Types
// ============================================================================

export interface Comment {
  id: number;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** 登录用户的评论 */
  user?: {
    id: number;
    username: string;
    avatar: string | null;
    permission: number | null;
  } | null;
  /** 游客评论的昵称 */
  guestName?: string;
  /** 游客评论的邮箱 */
  guestEmail?: string;
  /** 游客评论的网站 */
  guestWebsite?: string;
  /** 审核状态 */
  approved: boolean;
}

export interface CreateCommentRequest {
  content: string;
  /** 游客昵称（未登录时必填） */
  guestName?: string;
  /** 游客邮箱（可选） */
  guestEmail?: string;
  /** 游客网站（可选） */
  guestWebsite?: string;
}

// ============================================================================
// Friend Types
// ============================================================================

export interface Friend {
  id: number;
  name: string;
  desc: string | null;
  avatar: string;
  url: string;
  accepted: number;
  sort_order: number | null;
  createdAt: string;
  uid: number;
  updatedAt: string;
  health: string;
}

export interface FriendListResponse {
  friend_list: Friend[];
  apply_list: Friend | null;
}

export interface CreateFriendRequest {
  name: string;
  desc: string;
  avatar: string;
  url: string;
}

export interface UpdateFriendRequest {
  name: string;
  desc: string;
  avatar?: string;
  url: string;
  accepted?: number;
  sort_order?: number;
}

// ============================================================================
// Moment Types
// ============================================================================

export interface Moment {
  id: number;
  content: string;
  createdAt: string;
  updatedAt: string;
  user: {
    id: number;
    username: string;
    avatar: string;
  };
}

export interface CreateMomentRequest {
  content: string;
}

export interface MomentListResponse {
  data: Moment[];
  hasNext: boolean;
}

// ============================================================================
// Config Types
// ============================================================================

export type ConfigType = 'client' | 'server';

export interface ConfigResponse {
  [key: string]: any;
}

// ============================================================================
// AI Config Types
// ============================================================================

export interface AIConfig {
  enabled: boolean;
  provider: string;
  model: string;
  api_key: string;
  api_url: string;
}

// ============================================================================
// Storage Types
// ============================================================================

export interface UploadResponse {
  url: string;
}

// ============================================================================
// Search Types
// ============================================================================

// Uses FeedListResponse

// ============================================================================
// WordPress Import Types
// ============================================================================

export interface WordPressImportResponse {
  success: number;
  skipped: number;
  skippedList: Array<{ title: string; reason: string }>;
}

// ============================================================================
// API Endpoint Paths
// ============================================================================

export const API_PATHS = {
  // Feed
  FEED_LIST: '/api/feed',
  FEED_TIMELINE: '/api/feed/timeline',
  FEED_GET: (id: number | string) => `/api/feed/${id}`,
  FEED_CREATE: '/api/feed',
  FEED_UPDATE: (id: number) => `/api/feed/${id}`,
  FEED_DELETE: (id: number) => `/api/feed/${id}`,
  FEED_ADJACENT: (id: number | string) => `/api/feed/adjacent/${id}`,
  FEED_SET_TOP: (id: number) => `/api/feed/top/${id}`,

  // Auth
  AUTH_STATUS: '/api/auth/status',
  AUTH_LOGIN: '/api/auth/login',

  // User
  USER_PROFILE: '/api/user/profile',
  USER_UPDATE_PROFILE: '/api/user/profile',
  USER_LOGOUT: '/api/user/logout',
  USER_GITHUB: '/api/user/github',

  // Tag
  TAG_LIST: '/api/tag',
  TAG_GET: (name: string) => `/api/tag/${encodeURIComponent(name)}`,

  // Comment
  COMMENT_LIST: (feedId: number) => `/api/comment/${feedId}`,
  COMMENT_CREATE: (feedId: number) => `/api/comment/${feedId}`,
  COMMENT_DELETE: (id: number) => `/api/comment/${id}`,

  // Friend
  FRIEND_LIST: '/api/friend',
  FRIEND_CREATE: '/api/friend',
  FRIEND_UPDATE: (id: number) => `/api/friend/${id}`,
  FRIEND_DELETE: (id: number) => `/api/friend/${id}`,

  // Moments
  MOMENTS_LIST: '/api/moments',
  MOMENTS_CREATE: '/api/moments',
  MOMENTS_UPDATE: (id: number) => `/api/moments/${id}`,
  MOMENTS_DELETE: (id: number) => `/api/moments/${id}`,

  // Config
  CONFIG_GET: (type: ConfigType) => `/config/${type}`,
  CONFIG_UPDATE: (type: ConfigType) => `/config/${type}`,
  CONFIG_CLEAR_CACHE: '/config/cache',

  // AI Config (deprecated - use CONFIG_GET/CONFIG_UPDATE with 'server' type instead)
  /** @deprecated Use CONFIG_GET('server') instead. AI config is now part of server config. */
  AI_CONFIG_GET: '/ai-config',
  /** @deprecated Use CONFIG_UPDATE('server', {...}) instead. AI config is now part of server config. */
  AI_CONFIG_UPDATE: '/ai-config',

  // Storage
  STORAGE_UPLOAD: '/storage',

  // Favicon
  FAVICON_GET: '/favicon',
  FAVICON_GET_ORIGINAL: '/favicon/original',
  FAVICON_UPLOAD: '/favicon',

  // Search
  SEARCH: (keyword: string) => `/search/${encodeURIComponent(keyword)}`,

  // Stage 3 · 媒体中心（公开）
  MEDIA_LIST: '/media',
  SERIES_GET: (slug: string) => `/series/${encodeURIComponent(slug)}`,
  EVENTS_POST: '/events',
  EVENTS_DAILY: '/events/daily',

  // WordPress
  WP_IMPORT: '/wp',

  // Story (Stage 1 · 统一内容对象)
  // 公开读：先查 stories.slug，不存在则 fallback 到 feeds.alias 合成视图
  STORY_GET: (slug: string) => `/api/story/${encodeURIComponent(slug)}`,
  // 管理端：CRUD 全部要求 admin
  STORY_ADMIN_LIST: '/api/admin/stories',
  STORY_ADMIN_CREATE: '/api/admin/stories',
  STORY_ADMIN_GET: (id: number) => `/api/admin/stories/${id}`,
  STORY_ADMIN_UPDATE: (id: number) => `/api/admin/stories/${id}`,
  STORY_ADMIN_DELETE: (id: number) => `/api/admin/stories/${id}`,

  // RSS
  RSS_GET: (name: string) => `/${encodeURIComponent(name)}`,
} as const;

export type APIEndpoint = typeof API_PATHS;

// ============================================================================
// Media Types (Stage 1/2 upload + AI compose)
// ============================================================================

/** 素材/上传的类型标记：markdown_editor、media-embed、ai-compose 共用 */
export type MediaType = 'image' | 'video' | 'audio';

// ============================================================================
// AI Writer Config (server/src/utils/db-config.ts:getAIWriterConfig)
// ============================================================================

export interface AIWriterConfig {
  enabled: boolean;
  provider: string;
  model: string;
  api_key: string;
  api_url: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string;
  /** Pexels 搜图 API Key（AI 配图 search 模式用；空串表示未配置） */
  pexels_api_key: string;
}

// ============================================================================
// Analytics (server/src/services/analytics.ts → GET /analytics/*, adminOnly)
// ============================================================================

export interface AnalyticsDailyPoint {
  date: string;
  pv: number;
  uv: number;
}

export interface AnalyticsOverview {
  range: { days: number; from: string; to: string };
  totals: { pv: number; uv: number; uvApproximate: boolean };
  today: AnalyticsDailyPoint;
  yesterday: AnalyticsDailyPoint;
  series: AnalyticsDailyPoint[];
  previous: { from: string; to: string; pv: number; uv: number };
}

export interface AnalyticsTopFeed {
  feedId: number;
  title: string | null;
  pv: number;
  uv: number;
}

export interface AnalyticsTopFeedsResponse {
  items: AnalyticsTopFeed[];
}

export type AnalyticsDimensionType = 'referrer' | 'country' | 'device';

export interface AnalyticsDimensionItem {
  value: string;
  count: number;
}

export interface AnalyticsDimensionsResponse {
  type: AnalyticsDimensionType;
  items: AnalyticsDimensionItem[];
}

export interface AnalyticsLiveTotals {
  pv: number;
  uv: number;
}

export interface AnalyticsLiveResponse {
  available: boolean;
  date: string;
  totals: AnalyticsLiveTotals;
  yesterday: AnalyticsLiveTotals;
  uvApproximate: boolean;
  elapsedHours: number;
}

export interface AnalyticsVisit {
  timestamp: string;
  feedId: number;
  title: string | null;
  path: string;
  referrer: string;
  country: string;
  city: string;
  device: string;
  visitor: string;
  ip: string;
}

export interface AnalyticsVisitsResponse {
  available: boolean;
  items: AnalyticsVisit[];
  sampled: boolean;
}

// ============================================================================
// AI Compose (server/src/services/feed-ai-compose.ts)
// POST /feed/ai-compose, GET /feed/:id/ai-compose-status, adminOnly
// ============================================================================

export type ComposeLength = 'short' | 'medium' | 'long';

export interface AIComposeAssetInput {
  id: string;
  note: string;
}

export interface CreateAIComposeRequest {
  topic: string;
  assets: AIComposeAssetInput[];
  length?: ComposeLength;
  style?: string;
  listed?: boolean;
  imageMode?: AIComposeImageMode;
  imageCount?: number;
}

/** AI 配图方式：none 不配图，generate 用 Workers AI 生成，search 用 Pexels 搜图。 */
export type AIComposeImageMode = "none" | "generate" | "search";

export interface AIComposeResponse {
  id: number;
  status: 'pending';
}

export interface AIComposeStatusResponse {
  status: string;
  error: string;
}

// ============================================================================
// AI Revise (server/src/services/feed-ai-revise.ts)
// ============================================================================

export type AIReviseMode = 'polish' | 'expand' | 'shorten' | 'proofread' | 'custom';

export interface CreateAIReviseRequest {
  mode: AIReviseMode;
  instruction?: string;
}

export interface AIReviseResponse {
  revised: string;
}

// ============================================================================
// Sharing Reports (server/src/services/sharing-reports.ts)
// ============================================================================

export interface SharingReportMetrics {
  imageReferences: number;
  publishedArticles: number;
  pageViews: number;
  storageBytes: number;
}

export interface FinanceCategoryTotal {
  category: string;
  amount: number;
}

export interface FinanceSummary {
  donationTotal: number;
  expenseTotal: number;
  balance: number;
  donationCount: number;
  expenseCount: number;
  byCategory: FinanceCategoryTotal[];
}

export type FinanceTransactionType = 'donation' | 'expense';
export type FinanceTransactionStatus = 'confirmed' | 'voided';

export interface FinanceTransaction {
  id: number;
  reportId: number | null;
  type: FinanceTransactionType;
  category: string;
  title: string;
  description: string;
  amount: number;
  currency: string;
  occurredAt: string;
  receiptUrl: string;
  isAnonymous: boolean;
  status: FinanceTransactionStatus;
}

export interface SharingReport {
  id: number;
  slug: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  goals: string;
  summary: string;
  status: 'draft' | 'published';
  metrics: SharingReportMetrics;
  finance: FinanceSummary;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSharingReportRequest {
  title: string;
  periodStart: string;
  periodEnd: string;
  goals?: string;
  summary?: string;
}

export interface UpdateSharingReportRequest {
  title?: string;
  periodStart?: string;
  periodEnd?: string;
  goals?: string;
  summary?: string;
  status?: 'draft' | 'published';
}

export interface CreateFinanceTransactionRequest {
  type: FinanceTransactionType;
  category: string;
  title: string;
  description?: string;
  amount: number;
  currency?: string;
  occurredAt: string;
  reportId?: number | null;
  receiptUrl?: string;
  isAnonymous?: boolean;
}

export interface SharingReportDetailResponse {
  report: SharingReport;
  transactions: FinanceTransaction[];
}
