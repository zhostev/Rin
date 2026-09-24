-- Stage 4 · 向量清单 manifest：story_id -> 实际写入 Vectorize 的 vector id 列表
--
-- 背景：chunk id 随 story 内容/切块变化（s{storyId}b{blockId}c{chunkIndex}），
-- 仅靠"当前内容推导 id"无法清理历史版本遗留的孤儿向量。
-- 每次 embed 成功后覆盖写入本次实际 upsert 的 id 列表；
-- 重建/更新前按旧清单删除，删除 story 时按清单删除。
-- 只增表、不改旧表。

CREATE TABLE IF NOT EXISTS `story_vectors` (
  `story_id` integer PRIMARY KEY NOT NULL,
  `vector_ids_json` text DEFAULT '[]' NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
