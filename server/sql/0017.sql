CREATE TABLE `sharing_reports` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`goals` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`metrics_json` text DEFAULT '{}' NOT NULL,
	`finance_json` text DEFAULT '{}' NOT NULL,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sharing_reports_status_idx` ON `sharing_reports` (`status`);
--> statement-breakpoint
CREATE INDEX `sharing_reports_period_idx` ON `sharing_reports` (`period_start`,`period_end`);
--> statement-breakpoint
CREATE TABLE `finance_transactions` (
	`id` integer PRIMARY KEY NOT NULL,
	`report_id` integer REFERENCES `sharing_reports`(`id`) ON DELETE SET NULL,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`occurred_at` text NOT NULL,
	`receipt_url` text DEFAULT '' NOT NULL,
	`is_anonymous` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `finance_transactions_report_idx` ON `finance_transactions` (`report_id`);
--> statement-breakpoint
CREATE INDEX `finance_transactions_type_date_idx` ON `finance_transactions` (`type`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `finance_transactions_status_idx` ON `finance_transactions` (`status`);
--> statement-breakpoint
UPDATE `info` SET `value` = '17' WHERE `key` = 'migration_version';
