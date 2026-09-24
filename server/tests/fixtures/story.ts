import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

/**
 * 将 Stage 1 增量迁移（server/sql/0013.sql）应用到测试库。
 *
 * 直接执行仓库内真实的迁移 SQL（而不是手写一份 DDL），保证测试建表
 * 与生产迁移严格一致。`--> statement-breakpoint` 行会被 SQLite 当作
 * `--` 行注释忽略，可直接整体执行。
 */
export function applyStoryMigration(sqlite: Database) {
    const sql = readFileSync(join(import.meta.dir, "../../sql/0013.sql"), "utf8");
    sqlite.exec(sql);
}
