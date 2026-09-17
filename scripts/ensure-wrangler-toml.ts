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
 * Values here match the CI placeholder and are only used for the dry-run
 * bundle step; real deploy still uses setup-wrangler + deploy secrets.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), "wrangler.toml");

if (existsSync(path)) {
  process.exit(0);
}

const content = `name = "rin"
compatibility_date = "2023-12-01"
compatibility_flags = ["nodejs_compat"]

[env]
production = { }

[[env.production.d1_databases]]
binding = "DB"
database_name = "rin"
database_id = "123456"
preview_database_id = "DB"
`;

writeFileSync(path, content, "utf8");
console.log("Wrote placeholder wrangler.toml for build dry-run");