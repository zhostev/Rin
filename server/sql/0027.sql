-- 0027 · 英文翻译：feeds 加英文标题/摘要/正文与翻译状态列
--
-- 背景：站点 UI 切到英文时博客正文仍是中文。新增 *_en 三列存 AI 翻译结果，
-- translation_en_status: idle | pending | processing | completed | failed
-- （feed-ai-translation.ts 读写，队列模式抄 feed.ai-summary.generate）；
-- translation_en_error 仅管理员可见（公开序列化时剥离）。
ALTER TABLE `feeds` ADD COLUMN `title_en` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feeds` ADD COLUMN `summary_en` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feeds` ADD COLUMN `content_en` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feeds` ADD COLUMN `translation_en_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feeds` ADD COLUMN `translation_en_error` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `info` SET `value` = '27' WHERE `key` = 'migration_version';
