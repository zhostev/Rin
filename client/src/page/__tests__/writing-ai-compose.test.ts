import { describe, expect, it } from "bun:test";
import {
  COMPOSE_MAX_SHOTS,
  COMPOSE_POLL_INTERVAL_MS,
  COMPOSE_POLL_TIMEOUT_MS,
  canSubmitCompose,
  nextPollDecision,
} from "../writing-ai-compose";

describe("nextPollDecision", () => {
  it("keeps polling while the task is queued or running", () => {
    expect(nextPollDecision({ status: "pending", elapsedMs: 1000 })).toBe("continue");
    expect(nextPollDecision({ status: "processing", elapsedMs: 1000 })).toBe("continue");
  });

  it("stops on completion", () => {
    expect(nextPollDecision({ status: "completed", elapsedMs: 1000 })).toBe("done");
  });

  it("stops on failure", () => {
    expect(nextPollDecision({ status: "failed", elapsedMs: 1000 })).toBe("failed");
  });

  it("reports a timeout rather than a failure once the budget is spent", () => {
    expect(nextPollDecision({ status: "processing", elapsedMs: COMPOSE_POLL_TIMEOUT_MS + 1 })).toBe(
      "timeout",
    );
  });

  it("prefers a terminal status over a timeout", () => {
    expect(nextPollDecision({ status: "completed", elapsedMs: COMPOSE_POLL_TIMEOUT_MS + 1 })).toBe(
      "done",
    );
    expect(nextPollDecision({ status: "failed", elapsedMs: COMPOSE_POLL_TIMEOUT_MS + 1 })).toBe(
      "failed",
    );
  });

  it("keeps polling on an unexpected status instead of giving up", () => {
    expect(nextPollDecision({ status: "idle", elapsedMs: 1000 })).toBe("continue");
  });

  it("polls often enough to feel live but not busily", () => {
    expect(COMPOSE_POLL_INTERVAL_MS).toBe(3000);
    expect(COMPOSE_POLL_TIMEOUT_MS).toBe(300000);
  });
});

describe("canSubmitCompose", () => {
  it("accepts a topic without screenshots", () => {
    expect(canSubmitCompose({ topic: "AI 写作", shotCount: 0 })).toBe(true);
  });

  it("accepts screenshots without a topic （截图生文）", () => {
    expect(canSubmitCompose({ topic: "  ", shotCount: 2 })).toBe(true);
  });

  it("rejects an empty topic with no screenshots", () => {
    expect(canSubmitCompose({ topic: "", shotCount: 0 })).toBe(false);
    expect(canSubmitCompose({ topic: "   ", shotCount: 0 })).toBe(false);
  });
});

describe("COMPOSE_MAX_SHOTS", () => {
  it("matches the server-side vision cap", () => {
    expect(COMPOSE_MAX_SHOTS).toBe(5);
  });
});
