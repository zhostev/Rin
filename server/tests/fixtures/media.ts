import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

/**
 * 将 Stage 2 媒体栈增量迁移（server/sql/0014.sql）应用到测试库。
 *
 * 0014 是 0013 的增量（ALTER TABLE media_assets），因此先应用 0013 建表，
 * 再应用 0014 加列——与生产迁移顺序一致。`--> statement-breakpoint`
 * 行会被 SQLite 当作 `--` 行注释忽略，可直接整体执行。
 */
export function applyMediaMigration(sqlite: Database) {
    const dir = join(import.meta.dir, "../../sql");
    sqlite.exec(readFileSync(join(dir, "0013.sql"), "utf8"));
    sqlite.exec(readFileSync(join(dir, "0014.sql"), "utf8"));
}
