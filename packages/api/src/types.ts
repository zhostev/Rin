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
  /** 归属地标签，如 `江苏省·南京市` */
  location?: string | null;
  /** 归属地国家 */
  country?: string | null;
  /** 归属地省份（仅国内有值） */
  province?: string | null;
  /** 归属地城市（仅国内有值） */
  city?: string | null;
  /** 原始 IP，仅管理员请求评论列表时返回 */
  ip?: string | null;
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

// ============================================================================
// Media Types
// ============================================================================

export type MediaType = "audio" | "video";

export interface MediaAsset {
  id: string;
  provider: "r2" | "stream";
  type: MediaType;
  mimeType: string;
  fileSize: number;
  status: "uploading" | "processing" | "ready" | "failed";
  playbackUrl: string;
  createdAt: string;
  feedId?: number | null;
  feedTitle?: string | null;
  streamUid?: string | null;
}

export interface MediaLibraryResponse {
  size: number;
  data: MediaAsset[];
  hasNext: boolean;
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

  // WordPress
  WP_IMPORT: '/wp',

  // RSS
  RSS_GET: (name: string) => `/${encodeURIComponent(name)}`,
} as const;

export type APIEndpoint = typeof API_PATHS;

// Analytics
export type AnalyticsDimensionType = "referrer" | "country" | "device";
export interface AnalyticsDailyPoint { date: string; pv: number; uv: number; }
export interface AnalyticsOverview {
    range: { days: number; from: string; to: string };
    totals: { pv: number; uv: number; uvApproximate: boolean };
    today: AnalyticsDailyPoint;
    yesterday: AnalyticsDailyPoint;
    series: AnalyticsDailyPoint[];
    /**
     * 紧邻当前区间之前的等长窗口，供区间卡做环比。
     *
     * 长度对齐的是当前区间里**已完结**的天数（cron 从不聚合当天，所以当前区间
     * 的最后一天在 analytics_daily 里恒为 0）。以 days=30、今天 2026-09-20 为例：
     * 当前区间 2026-08-22..2026-09-20 里有 29 天完整数据，previous 即
     * 2026-07-24..2026-08-21，同样 29 天且全部完整——两侧口径一致，
     * 不会因为当前区间含一个空当天而系统性显示下降。
     */
    previous: { from: string; to: string; pv: number; uv: number };
}
export interface AnalyticsTopFeed { feedId: number; title: string | null; pv: number; uv: number; }
export interface AnalyticsTopFeedsResponse { items: AnalyticsTopFeed[]; }
export interface AnalyticsDimensionItem { value: string; count: number; }
export interface AnalyticsDimensionsResponse { type: AnalyticsDimensionType; items: AnalyticsDimensionItem[]; }
export interface AnalyticsLiveTotals { pv: number; uv: number; }

/**
 * GET /api/analytics/live —— 唯一直接查 Analytics Engine 的端点。
 *
 * 刻意做成「站点级 UTC 当日累计」，而不是「按文章分组的滚动 24 小时」：
 * 后者同时踩三个坑 —— ①挂在「今日」卡上标签就是错的（滚动窗口横跨两个 UTC 日）；
 * ②环比要除以昨天一整天，两个窗口根本不可比；③把每篇文章各自的基数去重值相加，
 * 同一个人读两篇会被算两次，而且会被 LIMIT 20 截断。
 */
export interface AnalyticsLiveResponse {
    available: boolean;
    /** UTC 当天的日期（YYYY-MM-DD）。 */
    date: string;
    /** 站点级：UTC 当天 00:00 起的累计。 */
    totals: AnalyticsLiveTotals;
    /** 站点级：昨天「同一已过小时数」之前的累计 —— 与 totals 窗口对齐，环比才有意义。 */
    yesterday: AnalyticsLiveTotals;
    /** UV 来自 AE 的基数估算，不是精确去重。 */
    uvApproximate: true;
    /** 已过的 UTC 小时数（0–23），用于说明比较窗口。 */
    elapsedHours: number;
}
