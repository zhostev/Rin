import { drizzle } from "drizzle-orm/d1";
import { CacheImpl } from "../utils/cache";

export async function handleScheduled(
  _controller: ScheduledController | null,
  env: Env,
  ctx: ExecutionContext,
) {
  const schema = await import("../db/schema");
  const db = drizzle(env.DB, { schema });

  const serverConfig = new CacheImpl(db, env, "server.config", "database");
  const clientConfig = new CacheImpl(db, env, "client.config");
  const cache = new CacheImpl(db, env, "cache", undefined, clientConfig);

  const { friendCrontab } = await import("../services/friends");
  const { rssCrontab } = await import("../services/rss");
  const { sitemapCrontab } = await import("../services/sitemap");
  const { backfillUvBaseline } = await import("../services/analytics-backfill");
  const { analyticsCrontab } = await import("../services/analytics-rollup");

  await friendCrontab(env, ctx, db, cache, serverConfig, clientConfig);
  await rssCrontab(env, db);
  await sitemapCrontab(env, db);
  // 必须先于聚合执行：聚合按 baseline + analytics_daily 重算 uv。
  await backfillUvBaseline(db, serverConfig);
  await analyticsCrontab(env, db, serverConfig);
}
