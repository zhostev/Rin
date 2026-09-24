// Tests for the R2VideoPlayer state machine and resume logic.

import "../../test/setup";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getR2VideoPlayerState, r2VideoResumeAt } from "../r2-video-player";
import { saveVideoProgress } from "../../utils/media-progress";
import type { MediaAsset } from "../../api/story";

// jsdom in test/setup has no URL, so window.localStorage throws; shim it.
const backingStore = new Map<string, string>();
const storageShim = {
  getItem: (key: string) => (backingStore.has(key) ? backingStore.get(key)! : null),
  setItem: (key: string, value: string) => {
    backingStore.set(key, String(value));
  },
  removeItem: (key: string) => {
    backingStore.delete(key);
  },
  clear: () => backingStore.clear(),
};

beforeEach(() => {
  Object.assign(globalThis, { localStorage: storageShim });
  backingStore.clear();
});

afterEach(() => {
  backingStore.clear();
});

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 7,
    kind: "video",
    source: "r2",
    url: "/api/blob/media/original/7/clip.mp4",
    title: "Clip",
    ...overrides,
  };
}

describe("getR2VideoPlayerState", () => {
  it("is ready when an R2 url exists", () => {
    expect(getR2VideoPlayerState(asset())).toBe("ready");
  });

  it("shows the gentle empty card when there is no playable url", () => {
    expect(getR2VideoPlayerState(asset({ url: undefined }))).toBe("empty");
    expect(getR2VideoPlayerState(undefined)).toBe("empty");
  });
});

describe("r2VideoResumeAt", () => {
  it("returns undefined when there is no record", () => {
    expect(r2VideoResumeAt(7, 120)).toBeUndefined();
  });

  it("returns the saved position", () => {
    saveVideoProgress({ assetId: 7, seconds: 42, title: "Clip" });
    expect(r2VideoResumeAt(7, 120)).toBe(42);
  });

  it("ignores positions within the first seconds", () => {
    saveVideoProgress({ assetId: 7, seconds: 1.5, title: "Clip" });
    expect(r2VideoResumeAt(7, 120)).toBeUndefined();
  });

  it("ignores positions at the very end of the video", () => {
    saveVideoProgress({ assetId: 7, seconds: 115, title: "Clip" });
    expect(r2VideoResumeAt(7, 120)).toBeUndefined();
  });

  it("still resumes when duration is unknown", () => {
    saveVideoProgress({ assetId: 7, seconds: 42, title: "Clip" });
    expect(r2VideoResumeAt(7, undefined)).toBe(42);
  });
});
