CREATE TABLE IF NOT EXISTS `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`uid` integer NOT NULL,
	`feed_id` integer,
	`provider` text DEFAULT 'r2' NOT NULL,
	`type` text NOT NULL,
	`object_key` text NOT NULL UNIQUE,
	`mime_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`uid`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_uid_idx` ON `media_assets` (`uid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_feed_idx` ON `media_assets` (`feed_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_status_idx` ON `media_assets` (`status`);
--> statement-breakpoint
UPDATE `info` SET `value` = '13' WHERE `key` = 'migration_version';
