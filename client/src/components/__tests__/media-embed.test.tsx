import { describe, expect, it } from "bun:test";
import { buildMediaMarkup } from "../media-embed";

describe("media embed markup", () => {
  it("creates a stable media reference for article content", () => {
    expect(buildMediaMarkup("video", "video-1", "Demo <video>")).toBe(
      '<video data-rin-media-id="video-1" title="Demo video" controls></video>\n',
    );
  });
});
