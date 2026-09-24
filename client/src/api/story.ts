// Story (内容包) API client — Stage 1 frontend contract.
//
// Backend counterpart (packages/api + server story service) is implemented in
// parallel by the backend team. This module pins the frontend side of the
// contract so UI work can proceed; field names must be aligned during
// integration:
//
//   GET    /api/story/:slug   -> StoryDetailResponse (public, legacy feed fallback)
//   GET    /api/admin/stories -> StoryListResponse (?page, ?limit, ?status) (admin)
//   POST   /api/admin/stories -> { insertedId: number } (admin)
//   PUT    /api/admin/stories/:id -> void (admin)
//   DELETE /api/admin/stories/:id -> void (admin)
//
// Block types: rich_text | quote | code | callout | image | gallery |
//              video | audio | attachment | divider | cta
// Asset kinds: image | video | audio | gallery | attachment

import type { ApiResponse } from "@rin/api";

export type StoryStatus = "draft" | "scheduled" | "published" | "updated" | "archived";

export type BlockType =
  | "rich_text"
  | "quote"
  | "code"
  | "callout"
  | "image"
  | "gallery"
  | "video"
  | "audio"
  | "attachment"
  | "divider"
  | "cta";

export type AssetKind = "image" | "video" | "audio" | "gallery" | "attachment";

export interface MediaAsset {
  id: number;
  kind: AssetKind;
  mime?: string;
  duration?: number; // seconds
  width?: number;
  height?: number;
  url?: string;
  alt?: string;
  title?: string;
}

export interface ContentBlock<T = Record<string, unknown>> {
  id?: number | string;
  type: BlockType;
  position: number;
  payload: T;
}

export interface RichTextPayload {
  markdown: string;
}

export interface VideoPayload {
  title?: string;
  asset_id?: number;
  asset?: MediaAsset;
  stream_uid?: string;
  duration?: number;
}

export interface AudioPayload {
  title?: string;
  asset_id?: number;
  asset?: MediaAsset;
  duration?: number;
}

export interface Story {
  id: number;
  slug: string;
  title: string;
  summary?: string;
  status: StoryStatus;
  cover?: string;
  published_at?: string;
  updated_at?: string;
  verified_at?: string;
  /** 旧 feeds 合成的临时视图（id 复用 feeds.id），编辑时应另存为正式 story */
  fromLegacyFeed?: boolean;
}

export interface StoryDetailResponse {
  story: Story;
  blocks: ContentBlock[];
  assets: MediaAsset[];
  relations?: StoryRelation[];
}

export interface StoryRelation {
  story_id: number;
  slug: string;
  title: string;
  relation_type: string;
}

export interface StoryListItem {
  id: number;
  slug: string;
  title: string;
  summary?: string;
  status: StoryStatus;
  updated_at?: string;
}

export interface StoryListResponse {
  stories: StoryListItem[];
  total: number;
}

export interface CreateStoryRequest {
  slug?: string;
  title: string;
  summary?: string;
  status?: StoryStatus;
  cover?: string;
  blocks: ContentBlock[];
}

export interface UpdateStoryRequest {
  slug?: string;
  title?: string;
  summary?: string;
  status?: StoryStatus;
  cover?: string;
  blocks?: ContentBlock[];
}

/** Minimal structural surface of the shared HttpClient in ./client */
export interface StoryHttp {
  get<T>(path: string, options?: unknown): Promise<ApiResponse<T>>;
  post<T>(path: string, body?: unknown, options?: unknown): Promise<ApiResponse<T>>;
  put<T>(path: string, body?: unknown, options?: unknown): Promise<ApiResponse<T>>;
  delete<T>(path: string, body?: unknown, options?: unknown): Promise<ApiResponse<T>>;
}

// ---------------------------------------------------------------------------
// Wire types: 后端实际返回形状（扁平 camelCase，与现有 feed API 风格一致）。
// 前端组件使用上面的 snake_case 嵌套形状，StoryAPI 在此做一次性适配，
// 组件层无需改动。
// ---------------------------------------------------------------------------
interface WireStoryBlock {
  id: number;
  storyId: number;
  type: string;
  position: number;
  payloadJson: string;
  revision: number;
}

interface WireStory {
  id: number;
  slug: string;
  title: string;
  status: string;
  summary: string;
  coverAssetId: number | null;
  feedId: number | null;
  publishedAt: string | null;
  updatedAt: string;
  verifiedAt: string | null;
  fromLegacyFeed?: boolean;
  blocks: WireStoryBlock[];
}

interface WireStoryList {
  size: number;
  data: WireStory[];
  hasNext: boolean;
}

function safeParsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const v = JSON.parse(payloadJson);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toBlock(wb: WireStoryBlock): ContentBlock {
  return {
    id: wb.id,
    type: wb.type as BlockType,
    position: wb.position,
    payload: safeParsePayload(wb.payloadJson),
  };
}

function toStory(w: WireStory): Story {
  return {
    id: w.id,
    slug: w.slug,
    title: w.title,
    summary: w.summary,
    status: w.status as StoryStatus,
    published_at: w.publishedAt ?? undefined,
    updated_at: w.updatedAt,
    verified_at: w.verifiedAt ?? undefined,
    fromLegacyFeed: w.fromLegacyFeed,
  };
}

function toStoryDetail(w: WireStory): StoryDetailResponse {
  return {
    story: toStory(w),
    blocks: (w.blocks ?? []).map(toBlock),
    assets: [],
    relations: [],
  };
}

function toListItem(w: WireStory): StoryListItem {
  return {
    id: w.id,
    slug: w.slug,
    title: w.title,
    summary: w.summary,
    status: w.status as StoryStatus,
    updated_at: w.updatedAt,
  };
}

function toWireBlocks(blocks: ContentBlock[]): Array<{ type: string; position: number; payload: unknown }> {
  return (blocks ?? []).map((b, i) => ({
    type: b.type,
    position: b.position ?? i,
    payload: b.payload ?? {},
  }));
}

export class StoryAPI {
  constructor(private http: StoryHttp) {}

  // GET /api/story/:slug（公开；slug / 数字 id / 旧 feeds.alias 均可）
  async get(slug: number | string): Promise<ApiResponse<StoryDetailResponse>> {
    const res = await this.http.get<WireStory>(`/api/story/${slug}`);
    if (res.error || !res.data) return { error: res.error } as ApiResponse<StoryDetailResponse>;
    return { data: toStoryDetail(res.data) };
  }

  // GET /api/admin/stories (admin)
  async list(params?: {
    page?: number;
    limit?: number;
    status?: StoryStatus | "all";
  }): Promise<ApiResponse<StoryListResponse>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.status && params.status !== "all") searchParams.set("status", params.status);
    const query = searchParams.toString();
    const res = await this.http.get<WireStoryList>(`/api/admin/stories${query ? `?${query}` : ""}`);
    if (res.error || !res.data) return { error: res.error } as ApiResponse<StoryListResponse>;
    return { data: { stories: res.data.data.map(toListItem), total: res.data.size } };
  }

  // POST /api/admin/stories (admin)
  async create(body: CreateStoryRequest): Promise<ApiResponse<{ insertedId: number }>> {
    const wireBody = {
      slug: body.slug,
      title: body.title,
      summary: body.summary,
      status: body.status,
      blocks: toWireBlocks(body.blocks),
    };
    const res = await this.http.post<WireStory>("/api/admin/stories", wireBody);
    if (res.error || !res.data) return { error: res.error } as ApiResponse<{ insertedId: number }>;
    return { data: { insertedId: res.data.id } };
  }

  // PUT /api/admin/stories/:id (admin；传入 blocks 即整体替换）
  async update(id: number | string, body: UpdateStoryRequest): Promise<ApiResponse<void>> {
    const wireBody = {
      slug: body.slug,
      title: body.title,
      summary: body.summary,
      status: body.status,
      blocks: body.blocks ? toWireBlocks(body.blocks) : undefined,
    };
    return this.http.put<void>(`/api/admin/stories/${id}`, wireBody);
  }

  // DELETE /api/admin/stories/:id (admin)
  async remove(id: number | string): Promise<ApiResponse<void>> {
    return this.http.delete<void>(`/api/admin/stories/${id}`);
  }
}
