import { afterEach, describe, expect, it } from "bun:test";
import {
  assertIp2regionConfiguredForDeploy,
  assertR2BucketConfiguredForDeploy,
  assertWranglerTomlContainsIp2region,
  buildWranglerObservabilityConfig,
  buildWranglerQueueConfig,
  buildWranglerR2BucketConfig,
  buildWranglerTriggersConfig,
  buildWranglerVpcServiceConfig,
  collectWorkerSecrets,
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

describe("buildWranglerVpcServiceConfig", () => {
  it("emits the IP2REGION VPC service binding for the given service", () => {
    const config = buildWranglerVpcServiceConfig("svc-ip2region");
    expect(config).toContain("[[vpc_services]]");
    expect(config).toContain('binding = "IP2REGION"');
    expect(config).toContain('service_id = "svc-ip2region"');
  });
});

describe("assertIp2regionConfiguredForDeploy", () => {
  const originalAllow = process.env.ALLOW_DEPLOY_WITHOUT_IP2REGION;

  afterEach(() => {
    if (originalAllow === undefined) {
      delete process.env.ALLOW_DEPLOY_WITHOUT_IP2REGION;
    } else {
      process.env.ALLOW_DEPLOY_WITHOUT_IP2REGION = originalAllow;
    }
  });

  it("returns the trimmed service id when set", () => {
    expect(
      assertIp2regionConfiguredForDeploy({
        ip2regionServiceId: "  e6a0817c-79c5-40ca-9776-a1c019defe70  ",
        preview: false,
      }),
    ).toBe("e6a0817c-79c5-40ca-9776-a1c019defe70");
  });

  it("throws on production deploy without IP2REGION_SERVICE_ID", () => {
    delete process.env.ALLOW_DEPLOY_WITHOUT_IP2REGION;
    expect(() =>
      assertIp2regionConfiguredForDeploy({ ip2regionServiceId: "", preview: false }),
    ).toThrow(/IP2REGION_SERVICE_ID is required/);
  });

  it("allows missing IP2REGION when ALLOW_DEPLOY_WITHOUT_IP2REGION=true", () => {
    process.env.ALLOW_DEPLOY_WITHOUT_IP2REGION = "true";
    expect(
      assertIp2regionConfiguredForDeploy({ ip2regionServiceId: "", preview: false }),
    ).toBe("");
  });

  it("warns but allows preview without IP2REGION", () => {
    expect(
      assertIp2regionConfiguredForDeploy({ ip2regionServiceId: "", preview: true }),
    ).toBe("");
  });
});

describe("assertWranglerTomlContainsIp2region", () => {
  it("accepts config emitted by buildWranglerVpcServiceConfig", () => {
    const config = buildWranglerVpcServiceConfig("svc-ip2region");
    expect(() => assertWranglerTomlContainsIp2region(config, "svc-ip2region")).not.toThrow();
  });

  it("throws when the VPC block is absent", () => {
    expect(() => assertWranglerTomlContainsIp2region("name = \"rin\"\n", "svc-ip2region")).toThrow(
      /missing \[\[vpc_services\]\]/,
    );
  });
});
