// Tests for the analytics event tracker (utils/analytics).

import { describe, expect, it, mock } from "bun:test";
import { createEventTracker } from "../analytics";

describe("createEventTracker", () => {
  it("sends each event once (session dedupe)", () => {
    const send = mock(() => Promise.resolve());
    const tracker = createEventTracker(send);
    tracker.track({ type: "video_play", assetId: 1 });
    tracker.track({ type: "video_play", assetId: 1 });
    tracker.track({ type: "video_play", assetId: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(tracker.acceptedCount()).toBe(2);
  });

  it("treats distinct stories/assets as distinct events", () => {
    const send = mock(() => Promise.resolve());
    const tracker = createEventTracker(send);
    tracker.track({ type: "story_read", storyId: 1 });
    tracker.track({ type: "story_read", storyId: 2 });
    tracker.track({ type: "audio_play", assetId: 1, storyId: 2 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("swallows synchronous send failures", () => {
    const send = mock(() => {
      throw new Error("network down");
    });
    const tracker = createEventTracker(send);
    expect(() => tracker.track({ type: "media_view", storyId: "media:video" })).not.toThrow();
  });

  it("swallows rejected send promises", async () => {
    const send = mock(() => Promise.reject(new Error("network down")));
    const tracker = createEventTracker(send);
    tracker.track({ type: "media_view", storyId: "media:audio" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
