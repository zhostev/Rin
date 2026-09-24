-- Stage 4 · AI Studio：用量记账 ai_usage + 总开关/配额 ai_settings
--
-- 只增表、不改旧表。
-- ai_usage：每次 AI 调用记一行（job_id 可空：/api/ask 等非 job 调用直接记账）。
--   tokens_in/out 尽力而为（Workers AI 部分模型返回 usage），取不到记 0；
--   cost_usd_est 目前恒为 0（Workers AI 走绑定额度，无按 token 计费），
--   字段保留给未来接外部模型时用。
-- ai_settings：key/value 文本开关，预置 ai_enabled=1、daily_call_quota=200。
--
-- CREATE TABLE 在 SQLite/D1 中逐条执行，每条独立
-- statement-breakpoint（与 0020 风格一致）。

CREATE TABLE IF NOT EXISTS `ai_usage` (
  `id` integer PRIMARY KEY NOT NULL,
  `job_id` integer,
  `model` text DEFAULT '' NOT NULL,
  `tokens_in` integer DEFAULT 0 NOT NULL,
  `tokens_out` integer DEFAULT 0 NOT NULL,
  `cost_usd_est` real DEFAULT 0 NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`job_id`) REFERENCES `ai_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text DEFAULT '' NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_usage_created_idx` ON `ai_usage` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_usage_model_idx` ON `ai_usage` (`model`);
--> statement-breakpoint
INSERT OR IGNORE INTO `ai_settings` (`key`, `value`) VALUES ('ai_enabled', '1');
--> statement-breakpoint
INSERT OR IGNORE INTO `ai_settings` (`key`, `value`) VALUES ('daily_call_quota', '200');
--> statement-breakpoint
UPDATE `info` SET `value` = '21' WHERE `key` = 'migration_version';
