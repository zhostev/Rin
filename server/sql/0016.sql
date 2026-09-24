CREATE TABLE `analytics_daily` (
	`date` text NOT NULL,
	`feed_id` integer NOT NULL,
	`pv` integer DEFAULT 0 NOT NULL,
	`uv` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `feed_id`)
);
--> statement-breakpoint
CREATE TABLE `analytics_dim_daily` (
	`date` text NOT NULL,
	`dim_type` text NOT NULL,
	`dim_value` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `dim_type`, `dim_value`)
);
--> statement-breakpoint
CREATE INDEX `analytics_daily_date_idx` ON `analytics_daily` (`date`);
--> statement-breakpoint
CREATE INDEX `analytics_dim_daily_date_type_idx` ON `analytics_dim_daily` (`date`,`dim_type`);
--> statement-breakpoint
DROP TABLE IF EXISTS `visits`;
--> statement-breakpoint
ALTER TABLE `visit_stats` ADD COLUMN `uv` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `visit_stats` ADD COLUMN `pv_baseline` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `visit_stats` ADD COLUMN `uv_baseline` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `visit_stats` SET `pv_baseline` = `pv`;
--> statement-breakpoint
UPDATE `info` SET `value` = '16' WHERE `key` = 'migration_version';
