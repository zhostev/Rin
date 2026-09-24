-- Stage 1 · 统一内容对象（Story / 内容包）增量迁移
--
-- 只增表、不改旧表：feeds / users / comments 等旧表定义原封不动。
--
-- distribution_records 故意不在本迁移中创建，理由：
--   1. 用户已明确把邮件订阅、Podcast、YouTube、B 站分发全部延期到分发阶段，
--      当前没有任何消费者会读写该表；
--   2. 建一个无人读写的死表只会扩大迁移面、增加每个环境的建表成本；
--   3. 分发阶段再以 0014+ 增量迁移加入，届时渠道需求已定、字段一次到位。
--
-- 下表 DDL 由 drizzle-kit generate 从 server/src/db/schema.ts 生成后逐表核对，
-- 仅做增量抽取（仓库无 drizzle journal，0001–0012 均为同风格手写增量）。

CREATE TABLE IF NOT EXISTS `media_assets` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'image' NOT NULL,
	`source` text DEFAULT 'r2' NOT NULL,
	`r2_key` text,
	`stream_uid` text,
	`mime` text DEFAULT '' NOT NULL,
	`duration` integer,
	`width` integer,
	`height` integer,
	`alt_text` text DEFAULT '',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_jobs` (
	`id` integer PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`input_refs_json` text DEFAULT '[]' NOT NULL,
	`model_ref` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `series` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stories` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`cover_asset_id` integer,
	`feed_id` integer,
	`published_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`verified_at` integer,
	FOREIGN KEY (`cover_asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `content_blocks` (
	`id` integer PRIMARY KEY NOT NULL,
	`story_id` integer NOT NULL,
	`type` text DEFAULT 'rich_text' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `transcripts` (
	`id` integer PRIMARY KEY NOT NULL,
	`asset_id` integer NOT NULL,
	`language` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`segments_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_series` (
	`series_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`series_id`, `story_id`),
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_relations` (
	`from_id` integer NOT NULL,
	`to_id` integer NOT NULL,
	`relation_type` text DEFAULT 'related' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`from_id`, `relation_type`, `to_id`),
	FOREIGN KEY (`from_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `revisions` (
	`id` integer PRIMARY KEY NOT NULL,
	`story_id` integer NOT NULL,
	`version` integer NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`snapshot_key` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_artifacts` (
	`id` integer PRIMARY KEY NOT NULL,
	`job_id` integer NOT NULL,
	`output_json` text DEFAULT '{}' NOT NULL,
	`accepted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `ai_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `stories_slug_unique` ON `stories` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `stories_feed_id_unique` ON `stories` (`feed_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `series_slug_unique` ON `series` (`slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_kind_idx` ON `media_assets` (`kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stories_slug_idx` ON `stories` (`slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stories_status_idx` ON `stories` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stories_feed_id_idx` ON `stories` (`feed_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `content_blocks_story_position_idx` ON `content_blocks` (`story_id`,`position`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `transcripts_asset_idx` ON `transcripts` (`asset_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_series_story_idx` ON `story_series` (`story_id`,`position`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_relations_to_idx` ON `story_relations` (`to_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `revisions_story_version_idx` ON `revisions` (`story_id`,`version`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_jobs_status_idx` ON `ai_jobs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_artifacts_job_idx` ON `ai_artifacts` (`job_id`);
--> statement-breakpoint
UPDATE `info` SET `value` = '13' WHERE `key` = 'migration_version';
