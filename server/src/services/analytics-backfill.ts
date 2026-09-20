import { ne, sql } from "drizzle-orm";
import type { DB } from "../core/hono-types";
import { visitStats } from "../db/schema";
import { HyperLogLog } from "../utils/hyperloglog";
import { recomputeVisitStats } from "./analytics-rollup";

export const ANALYTICS_UV_BACKFILL_KEY = "analytics.uv_baseline_backfilled";

const CHUNK_SIZE = 50;

type BackfillConfig = {
    getOrDefault<T>(key: string, defaultValue: T): Promise<T>;
    set(key: string, value: unknown, save?: boolean): Promise<void>;
};

function isFlagSet(value: unknown): boolean {
    return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * 一次性回填 uv_baseline。
 *
 * uv 是本功能新增的列，默认 0，而文章详情页直接读它。上线当天所有文章的公开 UV
 * 会从历史 HyperLogLog 估算值掉到 0，与设计文档 §2「文章详情页现有的公开 pv/uv
 * 展示与历史累计数字保持不变」冲突。
 *
 * 旧估算值仍然可恢复：hll_data 里的寄存器没有被删除，只是停止更新。这里把它
 * 反序列化后的基数写入 uv_baseline，再按 baseline + 聚合值重算 uv。
 *
 * 幂等：uv_baseline 由 hll_data 确定性推导（赋值而非累加），hll_data 已不再更新，
 * 因此重复执行结果相同；serverConfig 标记只是避免每 20 分钟重复扫表。
 */
export async function backfillUvBaseline(db: DB, serverConfig: BackfillConfig): Promise<number> {
    const flag = await serverConfig.getOrDefault<unknown>(ANALYTICS_UV_BACKFILL_KEY, false);
    if (isFlagSet(flag)) {
        return 0;
    }

    const rows = await db.select().from(visitStats).where(ne(visitStats.hllData, ""));
    const seeded: { feedId: number; row: typeof visitStats.$inferSelect; uvBaseline: number }[] = [];

    for (const row of rows) {
        if (!row.hllData) {
            continue;
        }

        const estimate = Math.round(new HyperLogLog(row.hllData).count());
        if (!Number.isFinite(estimate) || estimate <= 0) {
            continue;
        }

        seeded.push({ feedId: row.feedId, row, uvBaseline: estimate });
    }

    for (let i = 0; i < seeded.length; i += CHUNK_SIZE) {
        const batch = seeded.slice(i, i + CHUNK_SIZE);
        await db.insert(visitStats)
            .values(batch.map((entry) => ({ ...entry.row, uvBaseline: entry.uvBaseline })))
            .onConflictDoUpdate({
                target: visitStats.feedId,
                set: { uvBaseline: sql`excluded.uv_baseline` },
            });
    }

    await recomputeVisitStats(db, seeded.map((entry) => entry.feedId));
    await serverConfig.set(ANALYTICS_UV_BACKFILL_KEY, true, true);

    return seeded.length;
}
