ALTER TABLE `media_assets` ADD COLUMN `moment_id` integer REFERENCES moments(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_moment_idx` ON `media_assets` (`moment_id`);
--> statement-breakpoint
UPDATE `info` SET `value` = '18' WHERE `key` = 'migration_version';
