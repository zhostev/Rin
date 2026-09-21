import { describe, expect, it } from "bun:test";
import { detectMediaType, mediaPlaybackUrl } from "../media-upload";

function fileOfType(name: string, type: string) {
  return new File(["x"], name, { type });
}

describe("media upload helpers", () => {
  it("routes images, audio and video to the media library", () => {
    expect(detectMediaType(fileOfType("cover.png", "image/png"))).toBe("image");
    expect(detectMediaType(fileOfType("clip.mp4", "video/mp4"))).toBe("video");
    expect(detectMediaType(fileOfType("talk.mp3", "audio/mpeg"))).toBe("audio");
    expect(detectMediaType(fileOfType("notes.pdf", "application/pdf"))).toBeNull();
  });

  it("encodes the asset id into the playback url", () => {
    expect(mediaPlaybackUrl("asset/1")).toEndWith("/api/media/asset%2F1/playback");
  });
});
