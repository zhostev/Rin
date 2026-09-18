import { describe, expect, it } from "bun:test";
import { buildStreamTusMetadata, extractMediaIds, STREAM_DIRECT_UPLOAD_MAX_BYTES, verifyStreamWebhookSignature } from "../media";

describe("media content references", () => {
  it("extracts unique media ids from audio and video blocks", () => {
    const content = [
      '<audio data-rin-media-id="audio-1" controls></audio>',
      '<video data-rin-media-id="video-1" controls></video>',
      '<audio data-rin-media-id="audio-1" controls></audio>',
    ].join("\n");

    expect(extractMediaIds(content)).toEqual(["audio-1", "video-1"]);
  });

  it("ignores arbitrary attribute values", () => {
    expect(extractMediaIds('<audio data-rin-media-id="../private" />')).toEqual([]);
  });
});

describe("stream webhook signatures", () => {
  it("accepts a valid Cloudflare signature and rejects stale requests", async () => {
    const body = JSON.stringify({ uid: "stream-1", readyToStream: true });
    const timestamp = 1_700_000_000;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
    const signature = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");

    expect(await verifyStreamWebhookSignature(`time=${timestamp},sig1=${signature}`, body, "secret", timestamp)).toBe(true);
    expect(await verifyStreamWebhookSignature(`time=${timestamp},sig1=${signature}`, body, "secret", timestamp + 301)).toBe(false);
  });
});


describe("stream TUS metadata", () => {
  it("encodes maxDurationSeconds and flags for Cloudflare Upload-Metadata", () => {
    const header = buildStreamTusMetadata({
      fileName: "clip.mp4",
      maxDurationSeconds: 600,
      creator: "user-1",
      requireSignedURLs: true,
      allowedOrigins: ["example.com"],
    });
    expect(header).toContain("maxdurationseconds NjAw");
    expect(header).toContain("requiresignedurls");
    expect(header).toContain(`name ${btoa("clip.mp4")}`);
    expect(header).toContain(`creator ${btoa("user-1")}`);
    expect(STREAM_DIRECT_UPLOAD_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});
