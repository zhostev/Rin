import type { ComposeLength } from "@rin/api";

export const FEED_AI_SUMMARY_TASK = "feed.ai-summary.generate" as const;
export const FEED_AI_COMPOSE_TASK = "feed.ai-compose.generate" as const;

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
}

export interface FeedAIComposeTask {
  type: typeof FEED_AI_COMPOSE_TASK;
  payload: FeedAIComposeTaskPayload;
}

export type QueueTask = FeedAISummaryTask | FeedAIComposeTask;

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

  return false;
}
