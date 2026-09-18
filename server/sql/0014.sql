ALTER TABLE `media_assets` ADD COLUMN `stream_uid` text;
--> statement-breakpoint
ALTER TABLE `media_assets` ADD COLUMN `playback_url` text;
--> statement-breakpoint
UPDATE `info` SET `value` = '14' WHERE `key` = 'migration_version';
