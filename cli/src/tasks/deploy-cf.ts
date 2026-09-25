import { $ } from "bun";
import { readdir, unlink } from "node:fs/promises";
import stripIndent from "strip-indent";
import {
  fixTopField,
  getMigrationFileVersion,
  getMigrationVersion,
  updateMigrationVersion,
} from "../lib/db-migration";
const bunExec = process.execPath;

function env(name: string, defaultValue?: string, required = false) {
  const value = process.env[name] || defaultValue;
  if (required && !value) {
    throw new Error(`${name} is not defined`);
  }
  return value;
}

const renv = (name: string, defaultValue?: string) => env(name, defaultValue, true)!;

const WORKER_SECRET_KEYS = [
  "JWT_SECRET",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "RIN_GITHUB_CLIENT_ID",
  "RIN_GITHUB_CLIENT_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  // NOTE (fork): CLOUDFLARE_API_TOKEN is intentionally NOT synced here.
  // CI passes it for wrangler auth, but the production worker already has a
  // runtime token with extra permissions (e.g. Analytics Engine read for the
  // admin analytics query). Syncing would silently rotate it to the narrower
  // CI deploy token. Rotate the runtime token manually if ever needed.
  // Stream-only token (Stream:Edit). Preferred at runtime over the deploy token.
  "STREAM_API_TOKEN",
  // Runtime: verifies Cloudflare Stream webhook signatures (/api/media/stream/webhook).
  "STREAM_WEBHOOK_SECRET",
] as const;

function isQueueAlreadyPresentError(stderr: string) {
  return stderr.includes("already exists") || stderr.includes("already taken") || stderr.includes("[code: 11009]");
}

export function collectWorkerSecrets(source: Record<string, string | undefined> = process.env) {
  const secrets: Record<string, string> = {};

  for (const key of WORKER_SECRET_KEYS) {
    const value = source[key];
    if (value && value.length > 0) {
      secrets[key] = value;
    }
  }

  return secrets;
}

async function syncWorkerSecrets(workerName: string) {
  const secrets = collectWorkerSecrets();
  const secretKeys = Object.keys(secrets);

  if (secretKeys.length === 0) {
    console.log("ℹ️ No worker secrets provided; skipping secret sync");
    return;
  }

  const tempFile = ".wrangler-secrets.json";
  await Bun.write(tempFile, JSON.stringify(secrets, null, 2));

  try {
    await $`${bunExec} x wrangler secret bulk ${tempFile} --name ${workerName}`;
    console.log(`✅ Synced ${secretKeys.length} worker secret(s)`);
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}

async function buildClient() {
  const distIndex = Bun.file("./dist/client/index.html");
  if (await distIndex.exists()) {
    console.log("✅ Using pre-built client from ./dist/client");
    return;
  }

  console.log("🔨 Building client...");
  await $`cd client && ${bunExec} run build`.quiet();
  console.log("✅ Client built successfully");
}

type R2BucketInfo = {
  name: string;
  endpoint: string;
  accessHost: string;
};

export function buildR2BucketInfo(r2BucketName: string, accountId: string): R2BucketInfo {
  return {
    name: r2BucketName,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    accessHost: `https://${r2BucketName}.${accountId}.r2.dev`,
  };
}

export function buildWranglerTriggersConfig(preview = false) {
  return preview
    ? ""
    : stripIndent(`
        [triggers]
        crons = ["*/20 * * * *"]
      `);
}

export function buildWranglerQueueConfig(taskQueueName: string, preview = false) {
  return stripIndent(`
    [[queues.producers]]
    binding = "TASK_QUEUE"
    queue = "${taskQueueName}"

    [[queues.consumers]]
    queue = "${taskQueueName}"
    max_batch_size = 1
    max_batch_timeout = 5
  `);
}

export function buildWranglerObservabilityConfig(preview = false) {
  if (!preview) {
    return "";
  }

  return stripIndent(`
    [observability]

    [observability.logs]
    enabled = true
    invocation_logs = true

    [observability.traces]
    enabled = false
  `);
}


export function buildWranglerR2BucketConfig(r2BucketName: string) {
  return stripIndent(`
    [[r2_buckets]]
    binding = "R2_BUCKET"
    bucket_name = "${r2BucketName}"
    preview_bucket_name = "${r2BucketName}"
  `);
}

/**
 * Cloudflare Stream binding. Dashboard-only STREAM bindings are wiped when
 * generated wrangler.toml omits [stream] — same class of bug as R2 / former IP2REGION.
 * Official format is `[stream]` (not `[[streams]]`). Requires wrangler >= 4.80.0
 * or the field is ignored with "unexpected top-level field stream".
 */
export function buildWranglerStreamConfig() {
  return stripIndent(`
    [stream]
    binding = "STREAM"
  `);
}

/**
 * Stream-related `[vars]` entries. Emitted unconditionally (empty when unset) for
 * the same reason as the [stream] binding: the generated wrangler.toml replaces
 * the remote config wholesale, so an omitted key would leave a stale dashboard
 * value in place and make deploys non-reproducible.
 */
export function buildWranglerStreamVars(
  source: Record<string, string | undefined> = process.env,
) {
  return `STREAM_PUBLIC_HOST = "${(source.STREAM_PUBLIC_HOST || "").trim()}"`;
}

/**
 * Workers Analytics Engine binding, emitted unconditionally. See the [stream]
 * comment above for why an omitted block is a deploy-time hazard.
 */
export function buildWranglerAnalyticsConfig() {
  return stripIndent(`
    [[analytics_engine_datasets]]
    binding = "ANALYTICS"
    dataset = "rin_analytics"
  `);
}

/** ENABLE_STREAM=true or any Stream-related env → persist [stream] binding. */
export function shouldEnableStreamBinding(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const flag = (source.ENABLE_STREAM || "").trim().toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") {
    return true;
  }
  if ((source.STREAM_PUBLIC_HOST || "").trim()) {
    return true;
  }
  if ((source.STREAM_WEBHOOK_SECRET || "").trim()) {
    return true;
  }
  if ((source.STREAM_API_TOKEN || "").trim()) {
    return true;
  }
  return false;
}

/**
 * Production deploys without R2_BUCKET_NAME omit [[r2_buckets]] and overwrite
 * the remote Worker, dropping an existing R2_BUCKET binding (blob 500s).
 * Set ALLOW_DEPLOY_WITHOUT_R2=true only for intentional S3-only deploys.
 */
export function assertR2BucketConfiguredForDeploy(options: {
  r2BucketName: string | undefined | null;
  preview?: boolean;
  allowWithoutR2?: boolean;
}) {
  const name = (options.r2BucketName || "").trim();
  if (name) {
    return name;
  }

  if (options.preview) {
    console.warn("⚠️ Preview deploy without R2_BUCKET_NAME — [[r2_buckets]] will be omitted");
    return "";
  }

  const allow =
    options.allowWithoutR2 === true || process.env.ALLOW_DEPLOY_WITHOUT_R2 === "true";

  if (allow) {
    console.warn(
      "⚠️ Deploying without R2_BUCKET_NAME (ALLOW_DEPLOY_WITHOUT_R2=true). " +
        "Existing Worker R2_BUCKET binding will be removed if present.",
    );
    return "";
  }

  throw new Error(
    "R2_BUCKET_NAME is required for production deploy. " +
      "Without it, generated wrangler.toml omits [[r2_buckets]] and wrangler deploy " +
      "overwrites the Worker, dropping the R2 binding (causing /api/blob/* 500). " +
      "Set R2_BUCKET_NAME to your bucket (e.g. rin), or ALLOW_DEPLOY_WITHOUT_R2=true for S3-only.",
  );
}

async function resolveR2BucketInfo(r2BucketName: string) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return null;
  if (!r2BucketName) {
    return null;
  }
  return buildR2BucketInfo(r2BucketName, accountId);
}

export async function runCloudflareDeploy(target: "all" | "server" | "client" = "all", preview = false) {
  if (target === "client") {
    await buildClient();
    await $`${bunExec} x wrangler pages deploy dist/client`;
    return;
  }

  const dbName = renv("DB_NAME", "rin");
  const workerName = renv("WORKER_NAME", "rin-server");
  const taskQueueName = env("TASK_QUEUE_NAME", env("AI_SUMMARY_QUEUE_NAME", `${workerName}-tasks`)) ?? `${workerName}-tasks`;
  const r2BucketName = assertR2BucketConfiguredForDeploy({
    r2BucketName: env("R2_BUCKET_NAME", ""),
    preview,
  });
  const s3Endpoint = env("S3_ENDPOINT", "");
  const s3AccessHost = env("S3_ACCESS_HOST", "");
  const s3Bucket = env("S3_BUCKET", "");
  const s3CacheFolder = renv("S3_CACHE_FOLDER", "cache/");
  const s3Folder = renv("S3_FOLDER", "images/");
  const s3Region = renv("S3_REGION", "auto");
  const s3ForcePathStyle = env("S3_FORCE_PATH_STYLE", "false");
  const webhookUrl = env("WEBHOOK_URL", "");
  const rssTitle = env("RSS_TITLE", "");
  const rssDescription = env("RSS_DESCRIPTION", "");
  const cacheStorageMode = env("CACHE_STORAGE_MODE", "s3");
  const name = env("NAME", "Rin");
  const description = env("DESCRIPTION", "A lightweight personal blogging system");
  const avatar = env("AVATAR", "");
  const pageSize = env("PAGE_SIZE", "5");
  const rssEnable = env("RSS_ENABLE", "false");
  const frontendUrl = env("FRONTEND_URL", "");
  const cloudflareAccountId = env("CLOUDFLARE_ACCOUNT_ID", "");
  let finalS3Endpoint = s3Endpoint;
  let finalS3Bucket = s3Bucket;
  let finalS3AccessHost = s3AccessHost;

  if (!finalS3Endpoint || !finalS3Bucket) {
    const r2Info = await resolveR2BucketInfo(r2BucketName || "");
    if (r2Info) {
      finalS3Endpoint ||= r2Info.endpoint;
      finalS3Bucket ||= r2Info.name;
    }
  }

  if (target !== "server") {
    await buildClient();
  }

  const serverDistIndex = Bun.file("./dist/server/_worker.js");
  const hasServerBuild = await serverDistIndex.exists();
  const serverMain = hasServerBuild ? "dist/server/_worker.js" : "server/src/_worker.ts";

  Bun.write(
    "wrangler.toml",
    stripIndent(`
      #:schema node_modules/wrangler/config-schema.json
      name = "${workerName}"
      main = "${serverMain}"
      compatibility_date = "2026-01-20"

      [assets]
      directory = "./dist/client"
      binding = "ASSETS"
      ${buildWranglerTriggersConfig(preview)}
      ${buildWranglerObservabilityConfig(preview)}

      [vars]
      R2_BUCKET_NAME = "${r2BucketName}"
      S3_FOLDER = "${s3Folder}"
      S3_CACHE_FOLDER="${s3CacheFolder}"
      S3_REGION = "${s3Region}"
      S3_ENDPOINT = "${finalS3Endpoint}"
      S3_ACCESS_HOST = "${finalS3AccessHost}"
      S3_BUCKET = "${finalS3Bucket}"
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
      CLOUDFLARE_ACCOUNT_ID = "${cloudflareAccountId}"
      ${buildWranglerStreamVars()}

      [placement]
      mode = "smart"
    `),
  );

  const { exitCode, stderr, stdout } = await $`${bunExec} x wrangler d1 create ${dbName}`.quiet().nothrow();
  if (exitCode !== 0 && !stderr.toString().includes("already exists")) {
    console.error(`Failed to create D1 "${dbName}"`);
    console.error(stripIndent(stdout.toString()));
    console.error(stripIndent(stderr.toString()));
    process.exit(1);
  }

  const queueCreate = await $`${bunExec} x wrangler queues create ${taskQueueName}`.quiet().nothrow();
  if (queueCreate.exitCode !== 0 && !isQueueAlreadyPresentError(queueCreate.stderr.toString())) {
    console.error(`Failed to create Queue "${taskQueueName}"`);
    console.error(stripIndent(queueCreate.stdout.toString()));
    console.error(stripIndent(queueCreate.stderr.toString()));
    process.exit(1);
  }

  const listJson = (JSON.parse(await $`${bunExec} x wrangler d1 list --json`.quiet().text()) as Array<{ name: string; uuid: string }>).find(
    (item) => item.name === dbName,
  );
  if (listJson) {
    await $`echo ${stripIndent(`
      [[d1_databases]]
      binding = "DB"
      database_name = "${listJson.name}"
      database_id = "${listJson.uuid}"
    `)} >> wrangler.toml`.quiet();
  }

  await $`echo ${stripIndent(`
    [ai]
    binding = "AI"
  `)} >> wrangler.toml`.quiet();

  await $`echo ${buildWranglerQueueConfig(taskQueueName, preview)} >> wrangler.toml`.quiet();

  if (r2BucketName) {
    await $`echo ${buildWranglerR2BucketConfig(r2BucketName)} >> wrangler.toml`.quiet();
    console.log(`✅ Bound R2_BUCKET → ${r2BucketName}`);
  }

  if (shouldEnableStreamBinding()) {
    await $`echo ${buildWranglerStreamConfig()} >> wrangler.toml`.quiet();
    console.log("✅ Bound STREAM");
  }

  await $`echo ${buildWranglerAnalyticsConfig()} >> wrangler.toml`.quiet();

  const migrationVersion = await getMigrationVersion("remote", dbName);
  // Migration 0011 indexes feeds.top, so repair the column before pending SQL runs.
  await fixTopField("remote", dbName);
  const files = await readdir("./server/sql", { recursive: false });
  const sqlFiles = files
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => {
      const version = getMigrationFileVersion(name);
      return version !== null && version > migrationVersion;
    })
    .sort((left, right) => {
      return (getMigrationFileVersion(left) || 0) - (getMigrationFileVersion(right) || 0);
    });

  for (const file of sqlFiles) {
    await $`${bunExec} x wrangler d1 execute ${dbName} --remote --file ./server/sql/${file} -y`;
    console.log(`Migrated ${file}`);
  }
  if (sqlFiles.length > 0) {
    const lastVersion = getMigrationFileVersion(sqlFiles[sqlFiles.length - 1] || "");
    if (lastVersion !== null) {
      await updateMigrationVersion("remote", dbName, lastVersion);
    }
  }
  if (target === "server") {
    await $`${bunExec} x wrangler deploy`;
    await syncWorkerSecrets(workerName);
    return;
  }

  await $`${bunExec} x wrangler deploy`;
  await syncWorkerSecrets(workerName);
}
