import "../../test/setup";
import { mockWouter } from "../../test/mock-wouter";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AssetTranscript, MediaCenterItem, MediaCenterListResponse } from "../../api/media-center";

const audioItems: MediaCenterItem[] = [
  {
    id: 11,
    kind: "audio",
    title: "Podcast ep",
    duration: 1800,
    source: "r2",
    publicUrl: "/api/blob/audio/ep1.mp3",
    storyId: 1,
    storySlug: "pub-story",
    storyTitle: "Published Story",
    updatedAt: "2024-06-01T00:00:00.000Z",
    hasTranscript: true,
  },
  {
    id: 12,
    kind: "audio",
    title: "No transcript",
    duration: 300,
    source: "r2",
    publicUrl: "/api/blob/audio/ep2.mp3",
    storyId: 1,
    storySlug: "pub-story",
    storyTitle: "Published Story",
    updatedAt: "2024-06-01T00:00:00.000Z",
    hasTranscript: false,
  },
];

let listResponse: MediaCenterListResponse = { size: 2, data: audioItems, hasNext: false };
let transcriptResponse: AssetTranscript | null = {
  assetId: 11,
  language: "zh",
  text: "全文",
  segments: [
    { start: 0, end: 12, text: "开场白" },
    { start: 65, end: 80, text: "正文开始" },
  ],
};

/** Captures the mocked player's props so timecode seeks are assertable. */
let lastInitialTime: number | undefined;

mock.module("../../app/runtime", () => ({
  client: {
    mediaCenter: {
      listMedia: async () => ({ data: listResponse }),
      getTranscript: async () =>
        transcriptResponse ? { data: transcriptResponse } : { error: { value: "no" } },
    },
  },
}));

mock.module("../../components/audio-player", () => ({
  AudioPlayer: (props: { initialTime?: number }) => {
    lastInitialTime = props.initialTime;
    return <div data-testid="mock-audio-player" />;
  },
}));

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

mock.module("react-helmet", () => ({
  Helmet: () => null,
}));

mockWouter({ useSearch: () => "type=audio" });

const { MediaCenterPage } = await import("../media");

describe("MediaCenterPage audio transcripts", () => {
  afterEach(() => {
    cleanup();
    lastInitialTime = undefined;
    transcriptResponse = {
      assetId: 11,
      language: "zh",
      text: "全文",
      segments: [
        { start: 0, end: 12, text: "开场白" },
        { start: 65, end: 80, text: "正文开始" },
      ],
    };
  });

  it("shows the transcript toggle only for items with hasTranscript", async () => {
    const user = userEvent.setup();
    const { findByText, getAllByText } = render(<MediaCenterPage />);

    await findByText("Podcast ep");
    await findByText("No transcript");

    // Exactly one 文稿 toggle: only the item with hasTranscript.
    expect(getAllByText("media_page.audio.transcript")).toHaveLength(1);

    // Expanding loads and renders the segments.
    await user.click(getAllByText("media_page.audio.transcript")[0]!);
    expect(await findByText("开场白")).toBeDefined();
    expect(await findByText("正文开始")).toBeDefined();
  });

  it("clicking a timecode seeks the player to that offset", async () => {
    const user = userEvent.setup();
    const { findByText, getAllByText } = render(<MediaCenterPage />);

    await findByText("Podcast ep");
    await user.click(getAllByText("media_page.audio.transcript")[0]!);
    await findByText("正文开始");

    // 65s -> "1:05"
    await user.click(getAllByText("1:05")[0]!);
    expect(lastInitialTime).toBe(65);
  });

  it("shows the loading failure message when the transcript fetch fails", async () => {
    transcriptResponse = null;
    const user = userEvent.setup();
    const { findByText, getAllByText } = render(<MediaCenterPage />);

    await findByText("Podcast ep");
    await user.click(getAllByText("media_page.audio.transcript")[0]!);
    expect(await findByText("media_page.audio.transcript_failed")).toBeDefined();
  });
});
