ALTER TABLE `comments` ADD COLUMN `ip` text;
--> statement-breakpoint
ALTER TABLE `comments` ADD COLUMN `location` text;
--> statement-breakpoint
ALTER TABLE `comments` ADD COLUMN `country` text;
--> statement-breakpoint
ALTER TABLE `comments` ADD COLUMN `province` text;
--> statement-breakpoint
ALTER TABLE `comments` ADD COLUMN `city` text;
--> statement-breakpoint
UPDATE `info` SET `value` = '15' WHERE `key` = 'migration_version';
