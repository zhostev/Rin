/**
 * Stage 4 · AI Studio 总开关 / 日配额守卫 + ai_usage 记账。
 *
 * 规则（与前端 lane 约定一致）：
 * - ai_settings.ai_enabled = '0' 时所有 AI 路由返回 503 { error: { code: 'ai_disabled' } }
 * - 当日 ai_usage 行数 >= daily_call_quota 时返回 429 { error: { code: 'quota_exceeded' } }
 * - 每次 AI 调用（无论 job 内还是 /api/ask）记一行 ai_usage
 */
import { count, gte } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import { aiSettings, aiUsage } from "../../db/schema";

export const AI_ENABLED_KEY = "ai_enabled";
export const DAILY_CALL_QUOTA_KEY = "daily_call_quota";

export const DEFAULT_AI_ENABLED = true;
export const DEFAULT_DAILY_CALL_QUOTA = 200;

export interface AIStudioSettings {
    aiEnabled: boolean;
    dailyCallQuota: number;
}

export type AIGuardFailure = {
    ok: false;
    status: 503 | 429;
    code: "ai_disabled" | "quota_exceeded";
    message: string;
};

export type AIGuardResult = { ok: true } | AIGuardFailure;

function parseSettings(rows: Array<{ key: string; value: string }>): AIStudioSettings {
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const enabledRaw = map.get(AI_ENABLED_KEY);
    const quotaRaw = map.get(DAILY_CALL_QUOTA_KEY);
    const quota = quotaRaw !== undefined ? Number.parseInt(quotaRaw, 10) : NaN;
    return {
        aiEnabled: enabledRaw === undefined ? DEFAULT_AI_ENABLED : enabledRaw === "1",
        dailyCallQuota:
            Number.isFinite(quota) && quota > 0 ? quota : DEFAULT_DAILY_CALL_QUOTA,
    };
}

export async function readAISettings(db: DB): Promise<AIStudioSettings> {
    const rows = await db.select().from(aiSettings);
    return parseSettings(rows);
}

export async function writeAISettings(
    db: DB,
    patch: { aiEnabled?: boolean; dailyCallQuota?: number },
): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (patch.aiEnabled !== undefined) {
        await db
            .insert(aiSettings)
            .values({ key: AI_ENABLED_KEY, value: patch.aiEnabled ? "1" : "0", updatedAt: new Date(now * 1000) })
            .onConflictDoUpdate({
                target: aiSettings.key,
                set: { value: patch.aiEnabled ? "1" : "0", updatedAt: new Date(now * 1000) },
            });
    }
    if (patch.dailyCallQuota !== undefined) {
        const value = String(patch.dailyCallQuota);
        await db
            .insert(aiSettings)
            .values({ key: DAILY_CALL_QUOTA_KEY, value, updatedAt: new Date(now * 1000) })
            .onConflictDoUpdate({
                target: aiSettings.key,
                set: { value, updatedAt: new Date(now * 1000) },
            });
    }
}

/** 当日 0 点（unix 秒，UTC） */
export function dayStartUnix(nowSec: number = Math.floor(Date.now() / 1000)): number {
    return nowSec - (nowSec % 86400);
}

export async function countTodayCalls(db: DB, nowSec?: number): Promise<number> {
    const start = new Date(dayStartUnix(nowSec) * 1000);
    const rows = await db
        .select({ n: count() })
        .from(aiUsage)
        .where(gte(aiUsage.createdAt, start));
    return rows[0]?.n ?? 0;
}

export async function checkAIGuard(db: DB): Promise<AIGuardResult> {
    const settings = await readAISettings(db);
    if (!settings.aiEnabled) {
        return {
            ok: false,
            status: 503,
            code: "ai_disabled",
            message: "AI 功能已被管理员关闭",
        };
    }
    const used = await countTodayCalls(db);
    if (used >= settings.dailyCallQuota) {
        return {
            ok: false,
            status: 429,
            code: "quota_exceeded",
            message: `今日 AI 调用配额已用完（${settings.dailyCallQuota} 次/天）`,
        };
    }
    return { ok: true };
}

export interface UsageRecord {
    jobId?: number | null;
    model: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsdEst?: number;
}

/** 每次 AI 调用记一行 ai_usage。记账失败不抛错（不阻塞主流程）。 */
export async function recordUsage(db: DB, record: UsageRecord): Promise<void> {
    try {
        await db.insert(aiUsage).values({
            jobId: record.jobId ?? null,
            model: record.model,
            tokensIn: Math.max(0, Math.floor(record.tokensIn ?? 0)),
            tokensOut: Math.max(0, Math.floor(record.tokensOut ?? 0)),
            costUsdEst: record.costUsdEst ?? 0,
        });
    } catch (error) {
        console.error("[ai-studio] recordUsage failed:", error);
    }
}

export interface UsageSummary {
    days: number;
    total: { calls: number };
    byModel: Array<{ model: string; calls: number }>;
}

export async function summarizeUsage(db: DB, days: number): Promise<UsageSummary> {
    const since = new Date((dayStartUnix() - (Math.max(1, days) - 1) * 86400) * 1000);
    const totalRows = await db
        .select({ n: count() })
        .from(aiUsage)
        .where(gte(aiUsage.createdAt, since));
    const byModelRows = await db
        .select({ model: aiUsage.model, n: count() })
        .from(aiUsage)
        .where(gte(aiUsage.createdAt, since))
        .groupBy(aiUsage.model)
        .orderBy(aiUsage.model);
    return {
        days,
        total: { calls: totalRows[0]?.n ?? 0 },
        byModel: byModelRows.map((r) => ({ model: r.model, calls: r.n })),
    };
}
