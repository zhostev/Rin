// Tests for the StreamPlayer state machine (theme story page).

import { describe, expect, it } from "bun:test";
import { getStreamPlayerState, streamIframeSrc } from "../stream-player";
import type { MediaAsset } from "../../api/story";

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 1,
    kind: "video",
    source: "stream",
    title: "Talk",
    ...overrides,
  };
}

describe("getStreamPlayerState", () => {
  it("plays when the transcode is ready", () => {
    expect(
      getStreamPlayerState(asset({ stream_status: "ready", stream_uid: "abc" })),
    ).toBe("ready");
  });

  it("plays via embed_url even without a stream_uid", () => {
    expect(
      getStreamPlayerState(asset({ stream_status: "ready", embed_url: "https://iframe.example/x" })),
    ).toBe("ready");
  });

  it("treats a playable asset with no status as ready (hand-entered uid)", () => {
    expect(getStreamPlayerState(asset({ stream_uid: "abc" }))).toBe("ready");
    expect(getStreamPlayerState(asset({ stream_uid: "abc" }), "abc")).toBe("ready");
  });

  it("falls back to the payload stream_uid for legacy payloads", () => {
    expect(getStreamPlayerState(undefined, "legacy-uid")).toBe("ready");
  });

  it("shows the transcoding state while uploading/processing", () => {
    expect(getStreamPlayerState(asset({ stream_status: "uploading" }))).toBe("processing");
    expect(getStreamPlayerState(asset({ stream_status: "processing", stream_uid: "abc" }))).toBe(
      "processing",
    );
  });

  it("shows the error state on terminal failure", () => {
    expect(
      getStreamPlayerState(
        asset({ stream_status: "error", stream_error: "transcode failed", stream_uid: "abc" }),
      ),
    ).toBe("error");
  });

  it("shows the gentle empty card when nothing is playable", () => {
    expect(getStreamPlayerState(asset({}))).toBe("empty");
    expect(getStreamPlayerState(undefined, undefined)).toBe("empty");
  });

  it("shows empty when ready but no playable URL exists", () => {
    expect(getStreamPlayerState(asset({ stream_status: "ready" }))).toBe("empty");
  });
});

describe("streamIframeSrc", () => {
  it("prefers the contracted embed_url", () => {
    expect(streamIframeSrc(asset({ embed_url: "https://iframe.example/x" }), "abc")).toBe(
      "https://iframe.example/x",
    );
  });

  it("falls back to the official iframe URL built from the uid", () => {
    expect(streamIframeSrc(asset({ stream_uid: "abc" }), "abc")).toBe(
      "https://iframe.videodelivery.net/abc",
    );
  });
});
