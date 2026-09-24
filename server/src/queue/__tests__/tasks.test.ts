import { describe, expect, it } from "bun:test";
import {
  createFeedAIComposeTask,
  createFeedAISummaryTask,
  FEED_AI_COMPOSE_TASK,
  FEED_AI_SUMMARY_TASK,
  isQueueTask,
} from "../tasks";

const composePayload = {
  feedId: 7,
  expectedUpdatedAtUnix: 1_700_000_000,
  topic: "聊聊本地优先软件",
  assets: [{ id: "img-1", note: "架构图" }],
  length: "medium" as const,
  listed: true,
};

describe("isQueueTask", () => {
  it("still accepts summary tasks", () => {
    expect(isQueueTask(createFeedAISummaryTask({ feedId: 1, expectedUpdatedAtUnix: 123 }))).toBe(true);
  });

  it("accepts compose tasks", () => {
    expect(isQueueTask(createFeedAIComposeTask(composePayload))).toBe(true);
  });

  it("rejects an unknown task type", () => {
    expect(isQueueTask({ type: "feed.unknown", payload: composePayload })).toBe(false);
  });

  it("rejects a compose task missing its topic", () => {
    const { topic, ...rest } = composePayload;
    expect(isQueueTask({ type: FEED_AI_COMPOSE_TASK, payload: rest })).toBe(false);
  });

  it("rejects a compose task whose assets are not an array", () => {
    expect(
      isQueueTask({ type: FEED_AI_COMPOSE_TASK, payload: { ...composePayload, assets: "img-1" } }),
    ).toBe(false);
  });

  it("rejects a summary payload sent under the compose type", () => {
    expect(
      isQueueTask({ type: FEED_AI_COMPOSE_TASK, payload: { feedId: 1, expectedUpdatedAtUnix: 1 } }),
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isQueueTask(null)).toBe(false);
    expect(isQueueTask("feed.ai-summary.generate")).toBe(false);
  });
});

describe("createFeedAIComposeTask", () => {
  it("tags the payload with the compose task type", () => {
    const task = createFeedAIComposeTask(composePayload);

    expect(task.type).toBe(FEED_AI_COMPOSE_TASK);
    expect(task.payload.topic).toBe("聊聊本地优先软件");
  });

  it("keeps the summary task type distinct", () => {
    expect(FEED_AI_COMPOSE_TASK).not.toBe(FEED_AI_SUMMARY_TASK);
  });
});
