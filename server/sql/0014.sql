-- Stage 2 · 媒体栈：media_assets 增列（Stream/Images 直传与 webhook 状态追踪）
--
-- 只增列、不改旧列：已有行全部可用。
--   stream_status 默认 'ready'：旧行（本地上传/S3 时代的媒体）无需 webhook 流转，
--     默认 ready 即视为可用，避免 NULL 状态。
--   title 新增：音频上传的 multipart title 参数需要落盘位置。
--   upload_session_json：直传会话追踪（uploadURL 单次有效，留作排障）。
--   stream_meta_json：webhook/GET 同步回来的 duration/thumbnail/readyToStream 等。
--   images_variants_json：Images 变体完整 URL（{thumb,medium,large,public...}）。
--
-- ALTER TABLE ... ADD COLUMN 在 SQLite/D1 中逐条执行，每条独立
-- statement-breakpoint（与 0013 风格一致）。

ALTER TABLE `media_assets` ADD COLUMN `title` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `media_assets` ADD COLUMN `stream_status` text DEFAULT 'ready';
--> statement-breakpoint
ALTER TABLE `media_assets` ADD COLUMN `stream_error` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `media_assets` ADD COLUMN `stream_meta_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `media_assets` ADD COLUMN `images_id` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `media_assets` ADD COLUMN `images_variants_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `media_assets` ADD COLUMN `upload_session_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_stream_uid_idx` ON `media_assets` (`stream_uid`);
--> statement-breakpoint
UPDATE `info` SET `value` = '14' WHERE `key` = 'migration_version';
