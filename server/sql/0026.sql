-- 0026 · media_assets 图片集分组：批量导入的同组图片共享 group_key
--
-- 背景：媒体库「从 URL 下载」批量导入 Instagram 轮播图时，多张图片只是标题带
-- (1/N) 序号、散列存放。加 group_key 列让同一次批量导入的图归为一个图片集，
-- 前端按 group_key 叠放展示（×N 角标，可展开）。
-- 同组 key 格式：instagram:<shortcode>（见 resolveFromUrlImageTargets）。
ALTER TABLE `media_assets` ADD COLUMN `group_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_assets_group_key_idx` ON `media_assets` (`group_key`);
--> statement-breakpoint
UPDATE `info` SET `value` = '26' WHERE `key` = 'migration_version';
