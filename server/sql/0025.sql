-- 0025 · 播客化 TTS：feeds 加朗读音频状态列
--
-- ai_tts_status: idle | pending | processing | completed | failed（feed-ai-tts.ts 读写）
-- ai_tts_error: 失败原因（公开序列化时剥离，仅管理员可见）
-- tts_asset_id: 指向 media_assets 的 audio 行（kind='audio', source='r2'）
ALTER TABLE `feeds` ADD COLUMN `ai_tts_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feeds` ADD COLUMN `ai_tts_error` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `feeds` ADD COLUMN `tts_asset_id` integer REFERENCES `media_assets`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE `info` SET `value` = '25' WHERE `key` = 'migration_version';
