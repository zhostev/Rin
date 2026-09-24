import "../../test/setup";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { AudioPlayer } from "../audio-player";
import type { AudioPayload } from "../../api/story";

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

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

function stubAudio(audio: HTMLAudioElement) {
  let currentTime = 0;
  const play = mock(() => Promise.resolve());
  const pause = mock(() => undefined);
  Object.defineProperties(audio, {
    play: { value: play, configurable: true },
    pause: { value: pause, configurable: true },
    currentTime: {
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
      configurable: true,
    },
  });
  return { play, pause, getCurrentTime: () => currentTime };
}

const payloadWithAudio = (overrides: Partial<AudioPayload> = {}): AudioPayload => ({
  title: "Episode 12",
  asset: {
    id: 42,
    kind: "audio",
    source: "r2",
    url: "https://r2.example/ep12.mp3",
    duration: 300,
  },
  duration: 300,
  chapters: [
    { title: "Intro", start: 0 },
    { title: "Main", start: 60 },
    { title: "Outro", start: 120 },
  ],
  ...overrides,
});

beforeEach(() => {
  Object.assign(globalThis, { localStorage: storageShim });
  backingStore.clear();
});

afterEach(() => {
  cleanup();
});

describe("AudioPlayer", () => {
  it("shows a gentle fallback card when the asset has no playable URL", () => {
    const { getByText } = render(<AudioPlayer payload={{ title: "Silent" }} />);
    expect(getByText("story.detail.no_audio").isConnected).toBe(true);
    expect(getByText("Silent").isConnected).toBe(true);
  });

  it("toggles play/pause and drives the audio element", () => {
    const { container, getByRole } = render(<AudioPlayer payload={payloadWithAudio()} />);
    const stubs = stubAudio(container.querySelector("audio")!);

    const playButton = getByRole("button", { name: "story.detail.play" });
    fireEvent.click(playButton);
    expect(stubs.play).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".ri-pause-fill")).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "story.detail.pause" }));
    expect(stubs.pause).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".ri-play-fill")).not.toBeNull();
  });

  it("restores the persisted progress on load", () => {
    backingStore.set("s7ea:audio:42", "75");
    const { container } = render(<AudioPlayer payload={payloadWithAudio()} />);
    const stubs = stubAudio(container.querySelector("audio")!);

    fireEvent(container.querySelector("audio")!, new window.Event("loadedmetadata"));

    expect(stubs.getCurrentTime()).toBe(75);
  });

  it("ignores persisted progress that is out of range", () => {
    backingStore.set("s7ea:audio:42", "999999");
    const { container } = render(<AudioPlayer payload={payloadWithAudio()} />);
    const stubs = stubAudio(container.querySelector("audio")!);

    fireEvent(container.querySelector("audio")!, new window.Event("loadedmetadata"));

    // the payload declares a 300s duration, so 999999 is rejected
    expect(stubs.getCurrentTime()).toBe(0);
  });

  it("seeks when a chapter is clicked and persists the position", () => {
    const { container, getByText } = render(<AudioPlayer payload={payloadWithAudio()} />);
    const stubs = stubAudio(container.querySelector("audio")!);

    fireEvent.click(getByText("Main"));

    expect(stubs.getCurrentTime()).toBe(60);
    expect(backingStore.get("s7ea:audio:42")).toBe("60");
  });

  it("cycles playback speed through 0.75/1/1.25/1.5/2", () => {
    const { container, getByRole } = render(<AudioPlayer payload={payloadWithAudio()} />);
    const audio = container.querySelector("audio")!;
    stubAudio(audio);

    const speedButton = getByRole("button", { name: "story.detail.speed" });
    expect(speedButton.textContent).toBe("1×");

    fireEvent.click(speedButton);
    expect(speedButton.textContent).toBe("1.25×");
    expect(audio.playbackRate).toBe(1.25);

    fireEvent.click(speedButton);
    expect(speedButton.textContent).toBe("1.5×");
    fireEvent.click(speedButton);
    expect(speedButton.textContent).toBe("2×");
    fireEvent.click(speedButton);
    expect(speedButton.textContent).toBe("0.75×");
    fireEvent.click(speedButton);
    expect(speedButton.textContent).toBe("1×");
  });

  it("throttles progress writes while playing", () => {
    const { container } = render(<AudioPlayer payload={payloadWithAudio()} />);
    const audio = container.querySelector("audio")!;
    stubAudio(audio);

    let writes = 0;
    const originalSetItem = storageShim.setItem;
    storageShim.setItem = (key: string, value: string) => {
      writes += 1;
      originalSetItem(key, value);
    };
    try {
      Object.defineProperty(audio, "currentTime", {
        get: () => 30,
        set: () => undefined,
        configurable: true,
      });
      fireEvent(audio, new window.Event("timeupdate"));
      fireEvent(audio, new window.Event("timeupdate"));
      expect(writes).toBe(1);
      // the single write carried the component-observed currentTime
      expect(backingStore.get("s7ea:audio:42")).toBe("30");
    } finally {
      storageShim.setItem = originalSetItem;
    }
  });

  it("highlights the chapter containing the current time", () => {
    const { container, getByText } = render(<AudioPlayer payload={payloadWithAudio()} />);
    const audio = container.querySelector("audio")!;
    stubAudio(audio);
    Object.defineProperty(audio, "currentTime", {
      get: () => 90,
      set: () => undefined,
      configurable: true,
    });

    fireEvent(audio, new window.Event("timeupdate"));

    expect(getByText("Main").closest("button")?.className).toContain("bg-theme/10");
    expect(getByText("Intro").closest("button")?.className).not.toContain("bg-theme/10");
  });
});
