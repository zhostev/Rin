import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ensureMediaAssetsColumns, execMigrationLenient } from "./media";

/**
 * 将 Stage 1 增量迁移（server/sql/0013.sql）应用到测试库。
 *
 * 直接执行仓库内真实的迁移 SQL（而不是手写一份 DDL），保证测试建表
 * 与生产迁移严格一致。`--> statement-breakpoint` 行会被 SQLite 当作
 * `--` 行注释忽略，可直接整体执行。
 *
 * 旧 fixture media_assets 表的对齐逻辑见 ./media（补 0013 时代列），
 * 否则 0013 末尾的 `media_assets_kind_idx` 索引会因缺 `kind` 列而失败。
 */
export function applyStoryMigration(sqlite: Database) {
    const sql = readFileSync(join(import.meta.dir, "../../sql/0013.sql"), "utf8");
    ensureMediaAssetsColumns(sqlite);
    execMigrationLenient(sqlite, sql);
}
