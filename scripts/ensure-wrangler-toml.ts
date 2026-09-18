/**
 * Ensure wrangler.toml exists before `wrangler deploy --dry-run` / Workers Builds.
 *
 * GitHub Actions generates this via `.github/actions/setup-wrangler`.
 * Cloudflare Workers Builds only runs `bun run build` (then either `bun run deploy`
 * or `wrangler versions upload`) and does not run that action.
 *
 * - Without R2_BUCKET_NAME: write the dry-run placeholder (matches setup-wrangler).
 * - With R2_BUCKET_NAME: write a production-shaped config including [[r2_buckets]],
 *   so `wrangler versions upload` cannot silently drop the R2 binding.
 * - On Workers Builds for main/master without R2_BUCKET_NAME: fail closed.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), "wrangler.toml");

function env(name: string, fallback = ""): string {
  return (process.env[name] || fallback).trim();
}

function workersBuildsBranch(): string {
  return (
    process.env.WORKERS_CI_BRANCH ||
    process.env.CF_PAGES_BRANCH ||
    process.env.GITHUB_REF_NAME ||
    ""
  ).trim();
}


async function resolveD1DatabaseId(dbName: string): Promise<string> {
  const fromEnv = env("DB_ID") || env("D1_DATABASE_ID");
  if (fromEnv && fromEnv !== "local") {
    return fromEnv;
  }

  try {
    const proc = Bun.spawn(["bunx", "wrangler", "d1", "list", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      return fromEnv || "local";
    }
    const rows = JSON.parse(stdout) as Array<{ name: string; uuid: string }>;
    const match = rows.find((row) => row.name === dbName);
    if (match?.uuid) {
      console.log(`✅ Resolved D1 ${dbName} → ${match.uuid}`);
      return match.uuid;
    }
  } catch (error) {
    console.warn("⚠️ Failed to resolve D1 database id via wrangler:", error);
  }

  return fromEnv || "local";
}

function isWorkersBuilds(): boolean {
  return Boolean(
    process.env.WORKERS_CI ||
      process.env.CLOUDFLARE_BUILDS ||
      process.env.CF_PAGES ||
      process.env.WORKERS_CI_BRANCH ||
      process.env.CF_PAGES_BRANCH,
  );
}

/** Dry-run placeholder — must stay compatible with `wrangler deploy --dry-run`. */
export function buildPlaceholderToml(): string {
  return `#:schema node_modules/wrangler/config-schema.json
name = "rin-server"
main = "server/src/_worker.ts"
compatibility_date = "2025-03-21"

[assets]
directory = "./dist/client"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"

[triggers]
crons = ["*/20 * * * *"]

[vars]
S3_FOLDER = "images/"
S3_CACHE_FOLDER = "cache/"
S3_REGION = "auto"
S3_ENDPOINT = "https://example.s3.endpoint"
S3_ACCESS_HOST = "https://example.s3.endpoint"
S3_BUCKET = "rin-bucket"
S3_FORCE_PATH_STYLE = "false"
RSS_TITLE = "Rin"
RSS_DESCRIPTION = "A lightweight personal blogging system"
FRONTEND_URL = ""
CACHE_STORAGE_MODE = "s3"

[[d1_databases]]
binding = "DB"
database_name = "rin"
database_id = "local"

[[queues.producers]]
binding = "TASK_QUEUE"
queue = "rin-tasks"

[[queues.consumers]]
queue = "rin-tasks"
max_batch_size = 1
max_batch_timeout = 5
`;
}

/**
 * Production-shaped config from Build environment variables.
 * Used when R2_BUCKET_NAME is set so versions upload keeps the R2 binding.
 */
export function buildWranglerTomlFromEnv(
  source: Record<string, string | undefined> = process.env,
): string {
  const workerName = (source.WORKER_NAME || "rin").trim() || "rin";
  const dbName = (source.DB_NAME || "rin").trim() || "rin";
  const dbId = (source.DB_ID || source.D1_DATABASE_ID || "").trim() || "local";
  const taskQueue = (
    source.TASK_QUEUE_NAME ||
    source.AI_SUMMARY_QUEUE_NAME ||
    `${workerName}-tasks`
  ).trim();
  const r2BucketName = (source.R2_BUCKET_NAME || "").trim();
  const s3Folder = (source.S3_FOLDER || "images/").trim() || "images/";
  const s3CacheFolder = (source.S3_CACHE_FOLDER || "cache/").trim() || "cache/";
  const s3Region = (source.S3_REGION || "auto").trim() || "auto";
  const s3Endpoint = (source.S3_ENDPOINT || "").trim();
  const s3AccessHost = (source.S3_ACCESS_HOST || "").trim();
  const s3Bucket = (source.S3_BUCKET || r2BucketName || "").trim();
  const s3ForcePathStyle = (source.S3_FORCE_PATH_STYLE || "true").trim() || "true";
  const cacheStorageMode = (source.CACHE_STORAGE_MODE || "database").trim() || "database";
  const name = (source.NAME || "Rin").trim() || "Rin";
  const description = (source.DESCRIPTION || "").trim();
  const avatar = (source.AVATAR || "").trim();
  const frontendUrl = (source.FRONTEND_URL || "").trim();
  const pageSize = (source.PAGE_SIZE || "5").trim() || "5";
  const rssEnable = (source.RSS_ENABLE || "false").trim() || "false";
  const rssTitle = (source.RSS_TITLE || "").trim();
  const rssDescription = (source.RSS_DESCRIPTION || "").trim();
  const webhookUrl = (source.WEBHOOK_URL || "").trim();

  const r2Block = r2BucketName
    ? `
[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "${r2BucketName}"
preview_bucket_name = "${r2BucketName}"
`
    : "";

  return `#:schema node_modules/wrangler/config-schema.json
# Generated by scripts/ensure-wrangler-toml.ts from Build environment variables
name = "${workerName}"
main = "server/src/_worker.ts"
compatibility_date = "2025-03-21"

[assets]
directory = "./dist/client"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"

[triggers]
crons = ["*/20 * * * *"]

[vars]
R2_BUCKET_NAME = "${r2BucketName}"
S3_FOLDER = "${s3Folder}"
S3_CACHE_FOLDER = "${s3CacheFolder}"
S3_REGION = "${s3Region}"
S3_ENDPOINT = "${s3Endpoint}"
S3_ACCESS_HOST = "${s3AccessHost}"
S3_BUCKET = "${s3Bucket}"
S3_FORCE_PATH_STYLE = "${s3ForcePathStyle}"
WEBHOOK_URL = "${webhookUrl}"
RSS_TITLE = "${rssTitle}"
RSS_DESCRIPTION = "${rssDescription}"
CACHE_STORAGE_MODE = "${cacheStorageMode}"
NAME = "${name}"
DESCRIPTION = "${description}"
AVATAR = "${avatar}"
PAGE_SIZE = "${pageSize}"
RSS_ENABLE = "${rssEnable}"
FRONTEND_URL = "${frontendUrl}"

[placement]
mode = "smart"

[[d1_databases]]
binding = "DB"
database_name = "${dbName}"
database_id = "${dbId}"

[ai]
binding = "AI"

[[queues.producers]]
binding = "TASK_QUEUE"
queue = "${taskQueue}"

[[queues.consumers]]
queue = "${taskQueue}"
max_batch_size = 1
max_batch_timeout = 5
${r2Block}`;
}

export async function main(): Promise<void> {
  const r2BucketName = env("R2_BUCKET_NAME");
  const allowWithoutR2 = env("ALLOW_DEPLOY_WITHOUT_R2") === "true";
  const branch = workersBuildsBranch();
  const isProtectedBranch = branch === "main" || branch === "master";

  if (!r2BucketName && isWorkersBuilds() && isProtectedBranch && !allowWithoutR2) {
    console.error(
      "R2_BUCKET_NAME is required in Cloudflare Workers Builds for main/master. " +
        "Without it, generated wrangler.toml omits [[r2_buckets]] and deploy " +
        "drops the remote R2_BUCKET binding (/api/blob → 500). " +
        "Set Build variable R2_BUCKET_NAME=rin, or ALLOW_DEPLOY_WITHOUT_R2=true for S3-only.",
    );
    process.exit(1);
  }

  if (r2BucketName) {
    const dbName = env("DB_NAME", "rin") || "rin";
    const dbId = await resolveD1DatabaseId(dbName);
    if (isWorkersBuilds() && (dbId === "local" || !dbId)) {
      console.error(
        "D1 database_id could not be resolved. Set Build variable DB_ID / D1_DATABASE_ID " +
          "to the UUID of your D1 database (Workers Builds → Settings), or ensure " +
          "`wrangler d1 list` works with the Builds Cloudflare credentials.",
      );
      process.exit(1);
    }
    const envWithDb = { ...process.env, DB_ID: dbId };
    writeFileSync(path, buildWranglerTomlFromEnv(envWithDb), "utf8");
    console.log(`✅ Wrote wrangler.toml with R2_BUCKET → ${r2BucketName}, DB → ${dbId}`);
    return;
  }

  if (existsSync(path)) {
    console.log("ℹ️ wrangler.toml already exists; leaving in place (no R2_BUCKET_NAME)");
    return;
  }

  writeFileSync(path, buildPlaceholderToml(), "utf8");
  console.log("Wrote placeholder wrangler.toml for build dry-run (no R2_BUCKET_NAME)");
}

if (import.meta.main) {
  await main();
}
