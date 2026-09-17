/**
 * Ensure wrangler.toml exists before `wrangler deploy --dry-run`.
 *
 * GitHub Actions generates this via `.github/actions/setup-wrangler`.
 * Cloudflare Workers Builds only runs `bun run build` and does not run that
 * action, so the file is missing (it is gitignored). Without an explicit
 * config, Wrangler 4 autodiscovers the monorepo workspace root and fails with:
 * "Wrangler was launched from within a monorepo, but there is no workerd
 * compatible package to use. Currently, workspace-root autoconfig is not
 * supported."
 *
 * Content matches `.github/actions/setup-wrangler` dry-run placeholder.
 * Real deploy still uses setup-wrangler + deploy secrets.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), "wrangler.toml");

if (existsSync(path)) {
  process.exit(0);
}

const content = `#:schema node_modules/wrangler/config-schema.json
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

writeFileSync(path, content, "utf8");
console.log("Wrote placeholder wrangler.toml for build dry-run");