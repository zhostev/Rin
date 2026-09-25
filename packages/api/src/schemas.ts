// Request/Response schemas for server-side validation
import { t } from './schema-validator';

// ============================================================================
// Feed Schemas
// ============================================================================

export const feedListSchema = t.Object({
  page: t.Number({ optional: true }),
  limit: t.Number({ optional: true }),
  type: t.String({ optional: true }),
});

export const feedCreateSchema = t.Object({
  title: t.String({ minLength: 1 }),
  content: t.String({ minLength: 1 }),
  summary: t.String({ optional: true }),
  alias: t.String({ optional: true }),
  draft: t.Boolean(),
  listed: t.Boolean(),
  createdAt: t.Date({ optional: true }),
  tags: t.Array(t.String()),
});

export const feedUpdateSchema = t.Object({
  title: t.String({ optional: true }),
  alias: t.String({ optional: true }),
  content: t.String({ optional: true }),
  summary: t.String({ optional: true }),
  listed: t.Boolean(),
  draft: t.Boolean({ optional: true }),
  createdAt: t.Date({ optional: true }),
  tags: t.Array(t.String(), { optional: true }),
  top: t.Numeric({ optional: true }),
});

export const feedSetTopSchema = t.Object({
  top: t.Numeric(),
});

// ============================================================================
// Story Schemas (Stage 1 · 统一内容对象)
// ============================================================================

export const contentBlockInputSchema = t.Object({
  type: t.String({ minLength: 1 }),
  position: t.Integer({ optional: true }),
  payload: t.Optional(t.Object({})),
  revision: t.Integer({ optional: true }),
});

export const storyCreateSchema = t.Object({
  slug: t.String({ minLength: 1 }),
  title: t.String({ optional: true }),
  status: t.String({ optional: true }),
  summary: t.String({ optional: true }),
  coverAssetId: t.Integer({ optional: true }),
  feedId: t.Integer({ optional: true }),
  publishedAt: t.Date({ optional: true }),
  blocks: t.Array(contentBlockInputSchema, { optional: true }),
});

export const storyUpdateSchema = t.Object({
  slug: t.String({ optional: true }),
  title: t.String({ optional: true }),
  status: t.String({ optional: true }),
  summary: t.String({ optional: true }),
  coverAssetId: t.Integer({ optional: true }),
  feedId: t.Integer({ optional: true }),
  publishedAt: t.Date({ optional: true }),
  verifiedAt: t.Date({ optional: true }),
  blocks: t.Array(contentBlockInputSchema, { optional: true }),
});

// ============================================================================
// Auth Schemas
// ============================================================================

export const loginSchema = t.Object({
  username: t.String(),
  password: t.String(),
});

// ============================================================================
// User Schemas
// ============================================================================

export const updateProfileSchema = t.Object({
  username: t.String({ optional: true }),
  avatar: t.String({ optional: true }),
});

// ============================================================================
// Comment Schemas
// ============================================================================

export const commentCreateSchema = t.Object({
  content: t.String(),
  guestName: t.String({ optional: true }),
  guestEmail: t.String({ optional: true }),
  guestWebsite: t.String({ optional: true }),
});

// ============================================================================
// Friend Schemas
// ============================================================================

export const friendCreateSchema = t.Object({
  name: t.String(),
  desc: t.String(),
  avatar: t.String(),
  url: t.String(),
});

export const friendUpdateSchema = t.Object({
  name: t.String(),
  desc: t.String(),
  avatar: t.String({ optional: true }),
  url: t.String(),
  accepted: t.Numeric({ optional: true }),
  sort_order: t.Numeric({ optional: true }),
});

// ============================================================================
// Moment Schemas
// ============================================================================

export const momentCreateSchema = t.Object({
  content: t.String(),
});

export const momentUpdateSchema = t.Object({
  content: t.String(),
});

// ============================================================================
// AI Config Schemas
// ============================================================================

export const aiConfigUpdateSchema = t.Object({
  enabled: t.Boolean({ optional: true }),
  provider: t.String({ optional: true }),
  model: t.String({ optional: true }),
  api_key: t.String({ optional: true }),
  api_url: t.String({ optional: true }),
});

// ============================================================================
// WordPress Import Schemas
// ============================================================================

export const wpImportSchema = t.Object({
  data: t.File(),
});

// ============================================================================
// Search Schemas
// ============================================================================

export const searchSchema = t.Object({
  page: t.Number({ optional: true }),
  limit: t.Number({ optional: true }),
});

// ============================================================================
// AI Compose Schemas (server/src/services/feed-ai-compose.ts)
// ============================================================================

export const feedAIComposeSchema = t.Object({
  topic: t.String({ minLength: 1 }),
  assets: t.Array(
    t.Object({
      id: t.String(),
      note: t.String(),
    }),
  ),
  length: t.Optional(t.String()),
  style: t.Optional(t.String()),
  listed: t.Optional(t.Boolean()),
  // AI 配图：none 不配图，generate 用 Workers AI 生成，search 用 Pexels 搜图。
  // 服务端做归一化（非法值 → none；数量钳制 1..3），schema 只做宽松透传。
  imageMode: t.Optional(t.String()),
  imageCount: t.Optional(t.Number()),
});

export const feedAIReviseSchema = t.Object({
  mode: t.String({ minLength: 1 }),
  instruction: t.Optional(t.String()),
});
