import { describe, expect, it } from "bun:test";
// Stage 2 媒体栈重写后，services/media 只导出 AdminMediaService /
// StreamWebhookService。旧的 TUS 直传 / token 解析 / extractMediaIds
// 已被 features/media/* 的 CloudflareStreamClient 等取代，对应覆盖在
// features/media/__tests__/clients.test.ts 与 webhook.test.ts。
// 这里只保留 webhook 验签这一安全关键行为的用例（走当前实现）。
import { verifyStreamWebhookSignature } from "../../features/media/webhook";

describe("stream webhook signatures", () => {
  it("accepts a valid signature and rejects a wrong secret or missing header", async () => {
    const body = JSON.stringify({ uid: "stream-1", readyToStream: true });
    const secret = "secret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const signature = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");

    expect(await verifyStreamWebhookSignature(body, signature, secret)).toBe(true);
    expect(await verifyStreamWebhookSignature(body, signature, "wrong-secret")).toBe(false);
    expect(await verifyStreamWebhookSignature(body, null, secret)).toBe(false);
    expect(await verifyStreamWebhookSignature(`${body}tampered`, signature, secret)).toBe(false);
  });

  it("throws when the secret is not configured instead of silently passing", async () => {
    await expect(verifyStreamWebhookSignature("{}", "sig", "")).rejects.toThrow();
  });
});
