import type { AIComposeImageMode, ComposeLength } from "@rin/api";

export const FEED_AI_SUMMARY_TASK = "feed.ai-summary.generate" as const;
export const FEED_AI_COMPOSE_TASK = "feed.ai-compose.generate" as const;

// Stage 4 · AI Studio 任务（处理函数见 server/src/features/ai-studio/processors.ts）
export const AISTUDIO_TRANSCRIBE_TASK = "aistudio.transcribe" as const;
export const AISTUDIO_DERIVE_TASK = "aistudio.derive" as const;
export const AISTUDIO_CHECK_TASK = "aistudio.check" as const;
export const AISTUDIO_RETRIEVAL_TEST_TASK = "aistudio.retrieval-test" as const;
export const AISTUDIO_EMBED_TASK = "aistudio.embed" as const;

export type AIStudioTaskType =
  | typeof AISTUDIO_TRANSCRIBE_TASK
  | typeof AISTUDIO_DERIVE_TASK
  | typeof AISTUDIO_CHECK_TASK
  | typeof AISTUDIO_RETRIEVAL_TEST_TASK
  | typeof AISTUDIO_EMBED_TASK;

export interface AIStudioTaskPayload {
  jobId: number;
  storyId?: number;
  assetId?: number;
  question?: string;
  params?: Record<string, unknown>;
}

export interface AIStudioTask {
  type: AIStudioTaskType;
  payload: AIStudioTaskPayload;
}

export type FeedAISummaryStatus =
  | "idle"
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export type FeedAIComposeStatus = FeedAISummaryStatus;

export interface FeedAISummaryTaskPayload {
  feedId: number;
  expectedUpdatedAt?: string;
  expectedUpdatedAtUnix?: number;
}

export interface FeedAISummaryTask {
  type: typeof FEED_AI_SUMMARY_TASK;
  payload: FeedAISummaryTaskPayload;
}

export interface FeedAIComposeTaskPayload {
  feedId: number;
  expectedUpdatedAtUnix: number;
  topic: string;
  assets: Array<{ id: string; note: string }>;
  length: ComposeLength;
  style?: string;
  listed: boolean;
  /** AI 配图方式：none 不配图（默认） */
  imageMode: AIComposeImageMode;
  /** 配图数量，1..3（服务端钳制） */
  imageCount: number;
}

export interface FeedAIComposeTask {
  type: typeof FEED_AI_COMPOSE_TASK;
  payload: FeedAIComposeTaskPayload;
}

export type QueueTask = FeedAISummaryTask | FeedAIComposeTask | AIStudioTask;

export function createFeedAISummaryTask(
  payload: FeedAISummaryTaskPayload,
): FeedAISummaryTask {
  return {
    type: FEED_AI_SUMMARY_TASK,
    payload,
  };
}

export function createFeedAIComposeTask(
  payload: FeedAIComposeTaskPayload,
): FeedAIComposeTask {
  return {
    type: FEED_AI_COMPOSE_TASK,
    payload,
  };
}

export function createAIStudioTask(
  type: AIStudioTaskType,
  payload: AIStudioTaskPayload,
): AIStudioTask {
  return {
    type,
    payload,
  };
}

function isSummaryPayload(value: unknown): value is FeedAISummaryTaskPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<FeedAISummaryTaskPayload>;
  return (
    typeof payload.feedId === "number" &&
    (
      typeof payload.expectedUpdatedAtUnix === "number" ||
      typeof payload.expectedUpdatedAt === "string"
    )
  );
}

function isComposePayload(value: unknown): value is FeedAIComposeTaskPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<FeedAIComposeTaskPayload>;
  return (
    typeof payload.feedId === "number" &&
    typeof payload.expectedUpdatedAtUnix === "number" &&
    typeof payload.topic === "string" &&
    typeof payload.listed === "boolean" &&
    Array.isArray(payload.assets)
  );
}

function isAIStudioPayload(value: unknown): value is AIStudioTaskPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<AIStudioTaskPayload>;
  return typeof payload.jobId === "number";
}

export function isQueueTask(value: unknown): value is QueueTask {
  if (!value || typeof value !== "object") {
    return false;
  }

  const task = value as Partial<QueueTask>;

  if (task.type === FEED_AI_SUMMARY_TASK) {
    return isSummaryPayload(task.payload);
  }

  if (task.type === FEED_AI_COMPOSE_TASK) {
    return isComposePayload(task.payload);
  }

  if (
    task.type === AISTUDIO_TRANSCRIBE_TASK ||
    task.type === AISTUDIO_DERIVE_TASK ||
    task.type === AISTUDIO_CHECK_TASK ||
    task.type === AISTUDIO_RETRIEVAL_TEST_TASK ||
    task.type === AISTUDIO_EMBED_TASK
  ) {
    return isAIStudioPayload(task.payload);
  }

  return false;
}
