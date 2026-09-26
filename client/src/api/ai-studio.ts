// Stage 4 frontend contract: AI Studio admin endpoints + public /api/ask.
// Backend is implemented in parallel by the backend lane (server/ is theirs,
// do not touch). Field names below must be aligned during integration:
//
//   POST /api/admin/ai-studio/jobs
//       body { kind: 'transcribe'|'derive'|'check'|'retrieval-test'|'embed',
//              input: { storyId?, assetId?, text?, question? }, params? }
//       201 -> { id, job_type, status }
//   GET  /api/admin/ai-studio/jobs?status=&page=  -> { jobs, page, hasNext }
//   GET  /api/admin/ai-studio/jobs/:id            -> { job, artifacts }
//   POST /api/admin/ai-studio/artifacts/:id/accept -> 200 { ok: true, applied: true }
//   POST /api/admin/ai-studio/artifacts/:id/reject -> 200 { ok: true }
//   GET  /api/admin/ai-studio/usage?days=30        -> { days, total: { calls }, byModel }
//   GET  /api/admin/ai-studio/settings            -> { ai_enabled, daily_call_quota }
//   PUT  /api/admin/ai-studio/settings            -> 200 { ok: true }
//   POST /api/ask
//       body { question, mode?: 'quick'|'full' }
//       200 -> { answer, citations, coverage: 'full'|'partial'|'none', verifiedAt? }
//   GET  /api/ask/recommend?storyId=              -> { items: [{ storySlug, title, reason }] }
//
// The backend lane defines the concrete shape of artifact `output_json`;
// the frontend renders it generically (key-value tree + text diff) and never
// hard-codes its inner fields.

import type { ApiResponse } from "@rin/api";

/** Minimal HTTP surface the API classes need (structural; HttpClient satisfies it). */
export interface AIStudioHttp {
  get<T>(path: string, options?: unknown): Promise<ApiResponse<T>>;
  post<T>(path: string, body?: unknown, options?: unknown): Promise<ApiResponse<T>>;
  put<T>(path: string, body?: unknown, options?: unknown): Promise<ApiResponse<T>>;
}

export type AIJobStatus = "pending" | "processing" | "ready" | "failed";

export type AIJobKind = "transcribe" | "derive" | "check" | "retrieval-test" | "embed";

export interface AIJobInput {
  storyId?: number;
  assetId?: number;
  text?: string;
  question?: string;
}

export type AIJobMaterial = "story" | "asset" | "text";

/**
 * Build the job input from wizard picker values. The backend schema
 * requires integer ids, but the pickers hold string values — convert here
 * so the wire format is always numeric. Callers must validate non-empty /
 * integer ids before submitting (the wizard's `materialValid` does this).
 */
export function buildAIJobInput(
  material: AIJobMaterial,
  values: { storyId: string; assetId: string; text: string },
): AIJobInput {
  if (material === "story") return { storyId: Number(values.storyId) };
  if (material === "asset") return { assetId: Number(values.assetId) };
  return { text: values.text.trim() };
}

export interface CreateAIJobRequest {
  kind: AIJobKind;
  input: AIJobInput;
  params?: Record<string, unknown>;
}

export interface AIJob {
  id: number | string;
  job_type: AIJobKind;
  status: AIJobStatus;
  input?: AIJobInput;
  params?: Record<string, unknown>;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIJobListResponse {
  jobs: AIJob[];
  page: number;
  hasNext: boolean;
}

export interface AIArtifact {
  id: number | string;
  output_json: unknown;
  accepted_at: string | null;
  created_at: string;
}

export interface AIJobDetailResponse {
  job: AIJob;
  artifacts: AIArtifact[];
}

export interface AIUsageModelRow {
  model: string;
  calls: number;
}

export interface AIUsageResponse {
  days: number;
  total: { calls: number };
  byModel: AIUsageModelRow[];
}

export interface AISettings {
  ai_enabled: boolean;
  daily_call_quota: number;
}

export class AIStudioAPI {
  constructor(private http: AIStudioHttp) {}

  /** POST /api/admin/ai-studio/jobs -> 201 { id, job_type, status } */
  async createJob(
    body: CreateAIJobRequest,
  ): Promise<ApiResponse<{ id: number | string; job_type: AIJobKind; status: AIJobStatus }>> {
    return this.http.post<{ id: number | string; job_type: AIJobKind; status: AIJobStatus }>(
      "/api/admin/ai-studio/jobs",
      body,
    );
  }

  /** GET /api/admin/ai-studio/jobs?status=&page= */
  async listJobs(params?: {
    status?: AIJobStatus | "all";
    page?: number;
  }): Promise<ApiResponse<AIJobListResponse>> {
    const searchParams = new URLSearchParams();
    if (params?.status && params.status !== "all") searchParams.set("status", params.status);
    if (params?.page) searchParams.set("page", String(params.page));
    const query = searchParams.toString();
    return this.http.get<AIJobListResponse>(
      `/api/admin/ai-studio/jobs${query ? `?${query}` : ""}`,
    );
  }

  /** GET /api/admin/ai-studio/jobs/:id */
  async getJob(id: number | string): Promise<ApiResponse<AIJobDetailResponse>> {
    return this.http.get<AIJobDetailResponse>(
      `/api/admin/ai-studio/jobs/${encodeURIComponent(String(id))}`,
    );
  }

  /** POST /api/admin/ai-studio/artifacts/:id/accept */
  async acceptArtifact(id: number | string): Promise<ApiResponse<{ ok: boolean; applied: boolean }>> {
    return this.http.post<{ ok: boolean; applied: boolean }>(
      `/api/admin/ai-studio/artifacts/${encodeURIComponent(String(id))}/accept`,
    );
  }

  /** POST /api/admin/ai-studio/artifacts/:id/reject */
  async rejectArtifact(id: number | string): Promise<ApiResponse<{ ok: boolean }>> {
    return this.http.post<{ ok: boolean }>(
      `/api/admin/ai-studio/artifacts/${encodeURIComponent(String(id))}/reject`,
    );
  }

  /** GET /api/admin/ai-studio/usage?days=30 */
  async getUsage(days = 30): Promise<ApiResponse<AIUsageResponse>> {
    return this.http.get<AIUsageResponse>(`/api/admin/ai-studio/usage?days=${days}`);
  }

  /** GET /api/admin/ai-studio/settings */
  async getSettings(): Promise<ApiResponse<AISettings>> {
    return this.http.get<AISettings>("/api/admin/ai-studio/settings");
  }

  /** PUT /api/admin/ai-studio/settings */
  async updateSettings(body: Partial<AISettings>): Promise<ApiResponse<{ ok: boolean }>> {
    return this.http.put<{ ok: boolean }>("/api/admin/ai-studio/settings", body);
  }
}

export type AskMode = "quick" | "full";

export type AskCoverage = "full" | "partial" | "none";

export interface AskCitation {
  storySlug: string;
  title: string;
  blockId?: string;
  text?: string;
  /** Backend-provided jump target (story paragraph anchor or media timecode). Used verbatim. */
  url?: string;
}

export interface AskResponse {
  answer: string;
  citations: AskCitation[];
  coverage: AskCoverage;
  /** Present for finance/policy answers: the last verification date. */
  verifiedAt?: string;
}

export interface RecommendItem {
  storySlug: string;
  title: string;
  reason: string;
}

export class AskAPI {
  constructor(private http: AIStudioHttp) {}

  /** POST /api/ask */
  async ask(question: string, mode?: AskMode): Promise<ApiResponse<AskResponse>> {
    return this.http.post<AskResponse>("/api/ask", { question, ...(mode ? { mode } : {}) });
  }

  /** GET /api/ask/recommend?storyId= */
  async recommend(storyId: number | string): Promise<ApiResponse<{ items: RecommendItem[] }>> {
    return this.http.get<{ items: RecommendItem[] }>(
      `/api/ask/recommend?storyId=${encodeURIComponent(String(storyId))}`,
    );
  }
}
