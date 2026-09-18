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
});
