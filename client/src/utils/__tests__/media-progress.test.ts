// Tests for the Stage 3 local progress records (utils/media-progress).

import { afterEach, describe, expect, it } from "bun:test";
import {
  audioProgressKeyV3,
  clearProgress,
  collectContinueEntries,
  loadAudioProgressMeta,
  loadReadProgress,
  loadVideoProgress,
  readProgressKey,
  saveAudioProgressMeta,
  saveReadProgress,
  saveVideoProgress,
  videoProgressKey,
} from "../media-progress";

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  } as Storage;
}

const storage = makeStorage();
globalThis.localStorage = storage;

afterEach(() => {
  storage.clear();
});

describe("progress key builders", () => {
  it("uses the contracted key shapes", () => {
    expect(videoProgressKey(42)).toBe("s7ea:progress:video:42");
    expect(videoProgressKey("abc")).toBe("s7ea:progress:video:abc");
    expect(audioProgressKeyV3(7)).toBe("s7ea:progress:audio:7");
    expect(readProgressKey(9)).toBe("s7ea:progress:read:9");
  });
});

describe("video progress", () => {
  it("round-trips seconds and metadata", () => {
    saveVideoProgress({ assetId: 42, seconds: 75.5, title: "Talk", storySlug: "talk" });
    const loaded = loadVideoProgress(42);
    expect(loaded?.seconds).toBe(75.5);
    expect(loaded?.title).toBe("Talk");
    expect(loaded?.storySlug).toBe("talk");
    expect(typeof loaded?.updatedAt).toBe("number");
  });

  it("clamps negative seconds", () => {
    saveVideoProgress({ assetId: 1, seconds: -5 });
    expect(loadVideoProgress(1)?.seconds).toBe(0);
  });

  it("returns undefined for missing or garbage values", () => {
    expect(loadVideoProgress(999)).toBeUndefined();
    storage.setItem(videoProgressKey(2), "not-json");
    expect(loadVideoProgress(2)).toBeUndefined();
    storage.setItem(videoProgressKey(3), JSON.stringify({ seconds: "nope" }));
    expect(loadVideoProgress(3)).toBeUndefined();
  });
});

describe("audio progress metadata", () => {
  it("round-trips the enriched record", () => {
    saveAudioProgressMeta({ assetId: 7, seconds: 30, title: "Ep 1", storySlug: "show" });
    const loaded = loadAudioProgressMeta(7);
    expect(loaded?.seconds).toBe(30);
    expect(loaded?.title).toBe("Ep 1");
  });

  it("returns undefined for missing records", () => {
    expect(loadAudioProgressMeta(123)).toBeUndefined();
  });
});

describe("read progress", () => {
  it("round-trips the scroll fraction", () => {
    saveReadProgress({ storyId: 9, slug: "hello", fraction: 0.62, title: "Hello" });
    const loaded = loadReadProgress(9);
    expect(loaded?.fraction).toBe(0.62);
    expect(loaded?.slug).toBe("hello");
  });

  it("clamps fractions into 0..1 and rejects garbage", () => {
    saveReadProgress({ storyId: 1, slug: "a", fraction: 5 });
    expect(loadReadProgress(1)?.fraction).toBe(1);
    storage.setItem(readProgressKey(2), JSON.stringify({ fraction: -0.5 }));
    expect(loadReadProgress(2)).toBeUndefined();
    storage.setItem(readProgressKey(3), "garbage");
    expect(loadReadProgress(3)).toBeUndefined();
  });
});

describe("clearProgress", () => {
  it("removes the record for the given kind", () => {
    saveVideoProgress({ assetId: 1, seconds: 10 });
    saveReadProgress({ storyId: 1, slug: "a", fraction: 0.1 });
    clearProgress("video", 1);
    expect(loadVideoProgress(1)).toBeUndefined();
    expect(loadReadProgress(1)?.fraction).toBe(0.1);
  });
});

describe("collectContinueEntries", () => {
  it("returns [] when there is no local progress", () => {
    expect(collectContinueEntries()).toEqual([]);
  });

  it("collects video/audio/read entries newest-first with deep links", () => {
    storage.setItem(
      readProgressKey(9),
      JSON.stringify({ storyId: 9, slug: "hello", fraction: 0.5, title: "Hello", updatedAt: 1000 }),
    );
    storage.setItem(
      videoProgressKey(42),
      JSON.stringify({ assetId: 42, seconds: 75, title: "Talk", storySlug: "talk", updatedAt: 2000 }),
    );
    storage.setItem(
      audioProgressKeyV3(7),
      JSON.stringify({ assetId: 7, seconds: 30, title: "Ep 1", storySlug: "show", updatedAt: 3000 }),
    );

    const entries = collectContinueEntries();
    expect(entries).toHaveLength(3);
    // newest first: audio (3000) > video (2000) > read (1000)
    expect(entries[0]?.kind).toBe("audio");
    expect(entries[0]?.href).toBe("/media?type=audio&play=7");
    expect(entries[0]?.seconds).toBe(30);
    expect(entries[1]?.kind).toBe("video");
    expect(entries[2]?.kind).toBe("read");

    const video = entries.find((entry) => entry.kind === "video");
    expect(video?.href).toBe("/story/talk");
    expect(video?.seconds).toBe(75);

    const read = entries.find((entry) => entry.kind === "read");
    expect(read?.href).toBe("/story/hello");
    expect(read?.fraction).toBe(0.5);
  });

  it("falls back to /media?type=video when the video has no story slug", () => {
    saveVideoProgress({ assetId: 1, seconds: 5 });
    const entries = collectContinueEntries();
    expect(entries[0]?.href).toBe("/media?type=video");
  });

  it("respects the limit", () => {
    for (let i = 0; i < 10; i += 1) {
      saveReadProgress({ storyId: i, slug: `s-${i}`, fraction: 0.1 });
    }
    expect(collectContinueEntries(3)).toHaveLength(3);
  });

  it("skips garbage records instead of crashing", () => {
    storage.setItem(videoProgressKey(1), "{oops");
    storage.setItem(readProgressKey(2), JSON.stringify({ fraction: "x" }));
    expect(collectContinueEntries()).toEqual([]);
  });
});
