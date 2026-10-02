/**
 * MiniMax H3 视频任务的 cron 收尾（sweep）。
 *
 * aistudio.video 是异步任务：queue processor（processVideo）只负责向
 * minimax-relay 提交，job 保持 processing；本 sweep 每轮查出所有
 * processing 的 video job，轮询 relay 侧状态：
 * - succeeded → 存 {kind:'video'} artifact（含 relayJobId / prompt / 参数），
 *   job 置 completed（成片本身在 accept 时才下载入库，见 jobs.acceptArtifact）
 * - failed    → failJob（存 error artifact 说明 relay 侧原因），job 置 failed
 * - queued/running/unknown → 不动，等下一轮
 * - relay 查询本身失败（网络抖动/中转机离线）→ 不动、不误杀，下轮再试
 *
 * 由 runtime/scheduled-handler 在 "星/5" cron 触发（见 wrangler.toml）。
 */
import { and, asc, eq } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import { aiJobs } from "../../db/schema";
import { readJobInputRefs, saveArtifact, setJobStatus } from "./jobs";
import { failJob } from "./processors";
import { MINIMAX_VIDEO_MODEL, aiStudioJobType } from "./models";
import { queryRelayVideoJob, resolveMinimaxRelay } from "./minimax";

/** 每轮最多处理的 job 数（relay 查询是串行的，控制 cron 执行时长）。 */
export const MINIMAX_SWEEP_BATCH_LIMIT = 20;

export interface MinimaxSweepResult {
    checked: number;
    completed: number;
    failed: number;
}

export async function minimaxVideoSweep(env: Env, db: DB): Promise<MinimaxSweepResult> {
    const empty: MinimaxSweepResult = { checked: 0, completed: 0, failed: 0 };
    const relay = resolveMinimaxRelay(env);
    if (!relay.ok) {
        // 未配置中转：静默跳过（video 任务在提交阶段就会 failJob，这里不重复报错）
        return empty;
    }

    const rows = await db.query.aiJobs.findMany({
        columns: { id: true },
        where: and(
            eq(aiJobs.jobType, aiStudioJobType("video")),
            eq(aiJobs.status, "processing"),
        ),
        orderBy: asc(aiJobs.id),
        limit: MINIMAX_SWEEP_BATCH_LIMIT,
    });

    const result: MinimaxSweepResult = { checked: rows.length, completed: 0, failed: 0 };
    for (const row of rows) {
        const refs = await readJobInputRefs(db, row.id);
        const relayJobId =
            typeof refs["relayJobId"] === "string" && refs["relayJobId"]
                ? (refs["relayJobId"] as string)
                : null;
        if (!relayJobId) {
            // 提交后未能记下中转任务 id 的残留：无法追踪，按失败处理并说明原因
            await failJob(db, row.id, "提交后未能记录中转任务 id，无法追踪进度（请检查 relay 侧任务）");
            result.failed += 1;
            continue;
        }

        const queried = await queryRelayVideoJob(relay.config, relayJobId);
        if (!queried.ok) {
            // 中转暂时不可达：不动，下轮再试，避免网络抖动误杀长任务
            console.warn(`[minimax-sweep] job ${row.id}: ${queried.error}`);
            continue;
        }

        const status = queried.job.status;
        if (status === "succeeded") {
            await saveArtifact(db, row.id, {
                kind: "video",
                relayJobId,
                prompt: queried.job.prompt ?? String(refs["text"] ?? ""),
                duration: queried.job.duration ?? null,
                resolution: queried.job.resolution ?? null,
                ratio: queried.job.ratio ?? null,
                bytes: queried.job.bytes ?? null,
                model: MINIMAX_VIDEO_MODEL,
            });
            await setJobStatus(db, row.id, "completed");
            result.completed += 1;
        } else if (status === "failed") {
            await failJob(db, row.id, `视频生成失败：${queried.job.error ?? "未知原因"}`);
            result.failed += 1;
        }
        // queued / running / unknown：等下一轮
    }
    return result;
}
