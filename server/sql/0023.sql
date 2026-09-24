ALTER TABLE `media_assets` ADD COLUMN `poster_asset_id` integer;
--> statement-breakpoint
ALTER TABLE `media_assets` ADD COLUMN `subtitles_asset_id` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_poster_idx` ON `media_assets` (`poster_asset_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_subtitles_idx` ON `media_assets` (`subtitles_asset_id`);
--> statement-breakpoint
UPDATE `info` SET `value` = '23' WHERE `key` = 'migration_version';
