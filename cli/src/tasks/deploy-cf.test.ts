import { afterEach, describe, expect, it } from "bun:test";
import {
  assertR2BucketConfiguredForDeploy,
  buildWranglerObservabilityConfig,
  buildWranglerQueueConfig,
  buildWranglerR2BucketConfig,
  buildWranglerStreamConfig,
  buildWranglerTriggersConfig,
  collectWorkerSecrets,
  shouldEnableStreamBinding,
} from "./deploy-cf";

describe("collectWorkerSecrets", () => {
  it("includes supported non-empty worker secrets", () => {
    const secrets = collectWorkerSecrets({
      JWT_SECRET: "jwt-secret",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "password",
      RIN_GITHUB_CLIENT_ID: "client-id",
      RIN_GITHUB_CLIENT_SECRET: "client-secret",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
      CLOUDFLARE_API_TOKEN: "cf-token",
      UNUSED: "ignored",
    });

    expect(secrets).toEqual({
      JWT_SECRET: "jwt-secret",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "password",
      RIN_GITHUB_CLIENT_ID: "client-id",
      RIN_GITHUB_CLIENT_SECRET: "client-secret",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
      CLOUDFLARE_API_TOKEN: "cf-token",
    });
  });

  it("omits empty secret values", () => {
    const secrets = collectWorkerSecrets({
      JWT_SECRET: "",
      ADMIN_USERNAME: undefined,
      ADMIN_PASSWORD: "password",
    });

    expect(secrets).toEqual({
      ADMIN_PASSWORD: "password",
    });
  });
});

describe("buildWranglerTriggersConfig", () => {
  it("omits cron triggers for preview deploys", () => {
    expect(buildWranglerTriggersConfig(true)).toBe("");
  });

  it("includes cron triggers for production deploys", () => {
    expect(buildWranglerTriggersConfig(false)).toContain("[triggers]");
    expect(buildWranglerTriggersConfig(false)).toContain('crons = ["*/20 * * * *"]');
  });
});

describe("buildWranglerQueueConfig", () => {
  it("includes queue consumers for preview deploys", () => {
    const config = buildWranglerQueueConfig("rin-preview-tasks", true);
    expect(config).toContain('queue = "rin-preview-tasks"');
    expect(config).toContain("[[queues.consumers]]");
  });

  it("includes queue consumers for production deploys", () => {
    const config = buildWranglerQueueConfig("rin-tasks", false);
    expect(config).toContain("[[queues.producers]]");
    expect(config).toContain("[[queues.consumers]]");
  });
});

describe("buildWranglerObservabilityConfig", () => {
  it("enables invocation logs and disables traces for preview deploys", () => {
    const config = buildWranglerObservabilityConfig(true);
    expect(config).toContain("[observability]");
    expect(config).toContain("[observability.logs]");
    expect(config).toContain("enabled = true");
    expect(config).toContain("invocation_logs = true");
    expect(config).toContain("[observability.traces]");
    expect(config).toContain("enabled = false");
  });

  it("omits observability overrides for production deploys", () => {
    expect(buildWranglerObservabilityConfig(false)).toBe("");
  });
});

describe("assertR2BucketConfiguredForDeploy", () => {
  const originalAllow = process.env.ALLOW_DEPLOY_WITHOUT_R2;

  afterEach(() => {
    if (originalAllow === undefined) {
      delete process.env.ALLOW_DEPLOY_WITHOUT_R2;
    } else {
      process.env.ALLOW_DEPLOY_WITHOUT_R2 = originalAllow;
    }
  });

  it("returns the trimmed bucket name when set", () => {
    expect(
      assertR2BucketConfiguredForDeploy({ r2BucketName: "  rin  ", preview: false }),
    ).toBe("rin");
  });

  it("throws on production deploy without R2_BUCKET_NAME", () => {
    delete process.env.ALLOW_DEPLOY_WITHOUT_R2;
    expect(() =>
      assertR2BucketConfiguredForDeploy({ r2BucketName: "", preview: false }),
    ).toThrow(/R2_BUCKET_NAME is required/);
  });

  it("allows missing R2 when ALLOW_DEPLOY_WITHOUT_R2=true", () => {
    process.env.ALLOW_DEPLOY_WITHOUT_R2 = "true";
    expect(
      assertR2BucketConfiguredForDeploy({ r2BucketName: "", preview: false }),
    ).toBe("");
  });

  it("warns but allows preview without R2", () => {
    expect(
      assertR2BucketConfiguredForDeploy({ r2BucketName: "", preview: true }),
    ).toBe("");
  });
});

describe("buildWranglerR2BucketConfig", () => {
  it("emits R2_BUCKET binding for the given bucket", () => {
    const config = buildWranglerR2BucketConfig("rin");
    expect(config).toContain("[[r2_buckets]]");
    expect(config).toContain('binding = "R2_BUCKET"');
    expect(config).toContain('bucket_name = "rin"');
  });
});

describe("buildWranglerStreamConfig", () => {
  it("emits STREAM binding", () => {
    const config = buildWranglerStreamConfig();
    expect(config).toContain("[stream]");
    expect(config).toContain('binding = "STREAM"');
    // Official TOML; ignored by wrangler <4.80 (unexpected top-level field "stream").
    expect(config).toMatch(/\[stream\][\s\S]*binding = "STREAM"/);
  });
});

describe("shouldEnableStreamBinding", () => {
  it("is true when ENABLE_STREAM=true", () => {
    expect(shouldEnableStreamBinding({ ENABLE_STREAM: "true" })).toBe(true);
  });

  it("is true when STREAM_PUBLIC_HOST is set", () => {
    expect(
      shouldEnableStreamBinding({
        STREAM_PUBLIC_HOST: "https://customer-xxx.cloudflarestream.com",
      }),
    ).toBe(true);
  });

  it("is true when STREAM_WEBHOOK_SECRET is set", () => {
    expect(shouldEnableStreamBinding({ STREAM_WEBHOOK_SECRET: "secret" })).toBe(true);
  });

  it("is false when Stream is not configured", () => {
    expect(shouldEnableStreamBinding({ ENABLE_STREAM: "false" })).toBe(false);
    expect(shouldEnableStreamBinding({})).toBe(false);
  });
});
