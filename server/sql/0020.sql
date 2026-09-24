-- Stage 3 · 媒体中心：聚合分析事件表 media_events
--
-- 只增表、不改旧表。事件只做聚合统计，不收任何 PII
-- （不收 IP / UA / cookie），只记事件类型 + 可选的 asset_id / story_id。
-- 每条一行原始事件，聚合在查询时按天 GROUP BY（GET /api/events/daily）。
--
-- CREATE TABLE 在 SQLite/D1 中逐条执行，每条独立
-- statement-breakpoint（与 0014 风格一致）。

CREATE TABLE IF NOT EXISTS `media_events` (
  `id` integer PRIMARY KEY,
  `event_type` text NOT NULL,
  `asset_id` integer,
  `story_id` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_events_type_created_idx` ON `media_events` (`event_type`, `created_at`);
--> statement-breakpoint
UPDATE `info` SET `value` = '20' WHERE `key` = 'migration_version';
