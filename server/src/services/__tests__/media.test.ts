import { describe, expect, it } from "bun:test";
import { buildStreamTusMetadata, describeStreamProvisionFailure, extractMediaIds, provisionStreamTusUpload, resolveStreamApiToken, STREAM_DIRECT_UPLOAD_MAX_BYTES, StreamProvisionError, verifyStreamWebhookSignature } from "../media";

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

  it("extracts ids from playback links pasted into the content", () => {
    const content = [
      '![cover](/api/media/image-1/playback)',
      '<img src="https://example.com/api/media/image-2/playback" />',
      '<video data-rin-media-id="video-1" controls></video>',
    ].join("\n");

    expect(extractMediaIds(content)).toEqual(["video-1", "image-1", "image-2"]);
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

describe("stream api token resolution", () => {
  it("prefers the dedicated STREAM_API_TOKEN over the deploy token", () => {
    const env = {
      STREAM_API_TOKEN: "stream-scoped-token",
      CLOUDFLARE_API_TOKEN: "deploy-token",
    } as unknown as Env;

    expect(resolveStreamApiToken(env)).toBe("stream-scoped-token");
  });

  it("falls back to CLOUDFLARE_API_TOKEN when STREAM_API_TOKEN is unset or blank", () => {
    expect(resolveStreamApiToken({ CLOUDFLARE_API_TOKEN: "deploy-token" } as unknown as Env)).toBe("deploy-token");
    expect(resolveStreamApiToken({ STREAM_API_TOKEN: "   ", CLOUDFLARE_API_TOKEN: "deploy-token" } as unknown as Env)).toBe("deploy-token");
  });

  it("trims surrounding whitespace and returns empty when neither token is configured", () => {
    expect(resolveStreamApiToken({ STREAM_API_TOKEN: "  padded-token \n" } as unknown as Env)).toBe("padded-token");
    expect(resolveStreamApiToken({} as unknown as Env)).toBe("");
  });
});

describe("stream provision failures", () => {
  const cloudflare403 = '{"success":false,"errors":[{"code":10000,"message":"Authentication error","documentation_url":"https://developers.cloudflare.com/api"}],"result":null}';

  it("turns a 403 into a token permission hint", () => {
    const message = describeStreamProvisionFailure(403, cloudflare403);

    expect(message).toContain("403");
    expect(message).toContain("STREAM_API_TOKEN");
    expect(message).toContain("Stream:Edit");
  });

  it("never echoes the upstream response body to the caller", () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const message = describeStreamProvisionFailure(status, cloudflare403);
      expect(message).not.toContain("Authentication error");
      expect(message).not.toContain("documentation_url");
    }
  });

  it("blames the account id for a 404 and stays generic for unexpected statuses", () => {
    expect(describeStreamProvisionFailure(404, cloudflare403)).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(describeStreamProvisionFailure(500, cloudflare403)).toContain("500");
  });

  it("keeps the raw upstream body on the error for server-side logging", () => {
    const error = new StreamProvisionError(403, cloudflare403);

    expect(error.detail).toBe(cloudflare403);
    expect(error.status).toBe(403);
    expect(error.message).not.toContain("Authentication error");
  });

  it("throws the curated message when Cloudflare rejects the provision request", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(cloudflare403, { status: 403 })) as typeof fetch;
    try {
      const attempt = provisionStreamTusUpload({
        accountId: "account-1",
        apiToken: "bad-token",
        uploadLength: 1024,
        metadata: "maxdurationseconds NjAw",
      });

      await expect(attempt).rejects.toThrow(/Stream:Edit/);
      await expect(attempt).rejects.not.toThrow(/Authentication error/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
