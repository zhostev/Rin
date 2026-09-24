ALTER TABLE `feeds` ADD COLUMN `ai_compose_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feeds` ADD COLUMN `ai_compose_error` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `info` SET `value` = '19' WHERE `key` = 'migration_version';
