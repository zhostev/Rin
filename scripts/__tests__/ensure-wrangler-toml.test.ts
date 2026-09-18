import { describe, expect, it } from "bun:test";
import { buildPlaceholderToml, buildWranglerTomlFromEnv } from "../ensure-wrangler-toml";

describe("buildPlaceholderToml", () => {
  it("keeps dry-run placeholder shape without r2_buckets", () => {
    const toml = buildPlaceholderToml();
    expect(toml).toContain('name = "rin-server"');
    expect(toml).toContain('database_id = "local"');
    expect(toml).not.toContain("[[r2_buckets]]");
  });
});

describe("buildWranglerTomlFromEnv", () => {
  it("includes [[r2_buckets]] when R2_BUCKET_NAME is set", () => {
    const toml = buildWranglerTomlFromEnv({
      WORKER_NAME: "rin",
      R2_BUCKET_NAME: "rin",
      S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      S3_BUCKET: "rin",
      S3_FORCE_PATH_STYLE: "true",
      CACHE_STORAGE_MODE: "database",
      NAME: "弯曲的时间",
      DB_NAME: "rin",
      DB_ID: "abc-123",
      TASK_QUEUE_NAME: "rin-tasks",
    });

    expect(toml).toContain("[[r2_buckets]]");
    expect(toml).toContain('binding = "R2_BUCKET"');
    expect(toml).toContain('bucket_name = "rin"');
    expect(toml).toContain('R2_BUCKET_NAME = "rin"');
    expect(toml).toContain('CACHE_STORAGE_MODE = "database"');
    expect(toml).toContain('NAME = "弯曲的时间"');
    expect(toml).toContain('database_id = "abc-123"');
    expect(toml).toContain('name = "rin"');
  });

  it("omits r2_buckets when R2_BUCKET_NAME is empty", () => {
    const toml = buildWranglerTomlFromEnv({
      WORKER_NAME: "rin",
      R2_BUCKET_NAME: "",
    });
    expect(toml).not.toContain("[[r2_buckets]]");
  });


  it("includes [[vpc_services]] IP2REGION when IP2REGION_SERVICE_ID is set", () => {
    const toml = buildWranglerTomlFromEnv({
      WORKER_NAME: "rin",
      R2_BUCKET_NAME: "rin",
      DB_ID: "abc-123",
      IP2REGION_SERVICE_ID: "e6a0817c-79c5-40ca-9776-a1c019defe70",
      IP2REGION_BASE_URL: "http://ip2region.internal",
    });

    expect(toml).toContain("[[vpc_services]]");
    expect(toml).toContain('binding = "IP2REGION"');
    expect(toml).toContain('service_id = "e6a0817c-79c5-40ca-9776-a1c019defe70"');
    expect(toml).toContain('IP2REGION_BASE_URL = "http://ip2region.internal"');
  });

  it("omits vpc_services when IP2REGION_SERVICE_ID is empty", () => {
    const toml = buildWranglerTomlFromEnv({
      WORKER_NAME: "rin",
      R2_BUCKET_NAME: "rin",
      IP2REGION_SERVICE_ID: "",
    });
    expect(toml).not.toContain("[[vpc_services]]");
    expect(toml).not.toContain("IP2REGION");
  });

});
