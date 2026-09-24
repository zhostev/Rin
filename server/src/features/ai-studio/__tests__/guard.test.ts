import { describe, it, expect } from "bun:test";
import { aiSettings, aiUsage } from "../../../db/schema";
import {
    checkAIGuard,
    countTodayCalls,
    dayStartUnix,
    readAISettings,
    recordUsage,
    summarizeUsage,
    writeAISettings,
} from "../guard";

interface MockOptions {
    settings?: Record<string, string>;
    usageCount?: number;
    byModel?: Array<{ model: string; calls: number }>;
}

function makeDb(opts: MockOptions = {}) {
    const inserts: Array<{ table: unknown; values: unknown }> = [];
    const settingsRows = Object.entries(opts.settings ?? {}).map(([key, value]) => ({ key, value }));

    const usageChain: any = {};
    usageChain.where = () => usageChain;
    usageChain.groupBy = () => usageChain;
    usageChain.orderBy = async () => (opts.byModel ?? []).map((r) => ({ model: r.model, n: r.calls }));
    usageChain.then = (resolve: any, reject: any) =>
        Promise.resolve([{ n: opts.usageCount ?? 0 }]).then(resolve, reject);

    const db: any = {
        inserts,
        select: () => ({
            from: (table: unknown) => {
                if (table === aiSettings) return Promise.resolve(settingsRows);
                if (table === aiUsage) return usageChain;
                throw new Error("unexpected table");
            },
        }),
        insert: (table: unknown) => ({
            values: (values: unknown) => {
                inserts.push({ table, values });
                const chain: any = {
                    returning: async () => [],
                    onConflictDoUpdate: async () => undefined,
                    then: (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject),
                };
                return chain;
            },
        }),
    };
    return db;
}

describe("dayStartUnix", () => {
    it("floors to UTC midnight", () => {
        expect(dayStartUnix(86400 * 3 + 100)).toBe(86400 * 3);
        expect(dayStartUnix(86400 * 3)).toBe(86400 * 3);
    });
});

describe("readAISettings", () => {
    it("returns defaults when the table is empty", async () => {
        const settings = await readAISettings(makeDb());
        expect(settings).toEqual({ aiEnabled: true, dailyCallQuota: 200 });
    });

    it("parses stored values", async () => {
        const settings = await readAISettings(
            makeDb({ settings: { ai_enabled: "0", daily_call_quota: "50" } }),
        );
        expect(settings).toEqual({ aiEnabled: false, dailyCallQuota: 50 });
    });

    it("falls back on garbage quota", async () => {
        const settings = await readAISettings(makeDb({ settings: { daily_call_quota: "abc" } }));
        expect(settings.dailyCallQuota).toBe(200);
    });
});

describe("checkAIGuard", () => {
    it("returns 503 ai_disabled when ai_enabled=0", async () => {
        const result = await checkAIGuard(makeDb({ settings: { ai_enabled: "0" } }));
        expect(result).toMatchObject({ ok: false, status: 503, code: "ai_disabled" });
    });

    it("returns 429 quota_exceeded when the daily quota is used up", async () => {
        const result = await checkAIGuard(
            makeDb({ settings: { daily_call_quota: "10" }, usageCount: 10 }),
        );
        expect(result).toMatchObject({ ok: false, status: 429, code: "quota_exceeded" });
    });

    it("passes when under quota", async () => {
        const result = await checkAIGuard(
            makeDb({ settings: { daily_call_quota: "10" }, usageCount: 9 }),
        );
        expect(result).toEqual({ ok: true });
    });
});

describe("countTodayCalls", () => {
    it("returns the counted rows", async () => {
        expect(await countTodayCalls(makeDb({ usageCount: 7 }))).toBe(7);
    });
});

describe("recordUsage", () => {
    it("inserts a usage row with model and token counts", async () => {
        const db = makeDb();
        await recordUsage(db, { jobId: 3, model: "m", tokensIn: 10, tokensOut: 20 });
        expect(db.inserts.length).toBe(1);
        expect(db.inserts[0].table).toBe(aiUsage);
        expect(db.inserts[0].values).toMatchObject({ jobId: 3, model: "m", tokensIn: 10, tokensOut: 20 });
    });

    it("never throws (bookkeeping must not break the main flow)", async () => {
        const bad: any = { insert: () => { throw new Error("db down"); } };
        await recordUsage(bad, { model: "m" });
    });
});

describe("summarizeUsage", () => {
    it("returns the contracted shape", async () => {
        const summary = await summarizeUsage(
            makeDb({ usageCount: 5, byModel: [{ model: "m", calls: 5 }] }),
            30,
        );
        expect(summary).toEqual({
            days: 30,
            total: { calls: 5 },
            byModel: [{ model: "m", calls: 5 }],
        });
    });
});

describe("writeAISettings", () => {
    it("upserts ai_enabled and quota", async () => {
        const db = makeDb();
        await writeAISettings(db, { aiEnabled: false, dailyCallQuota: 42 });
        const byKey = new Map(db.inserts.map((i: any) => [i.values.key, i.values.value]));
        expect(byKey.get("ai_enabled")).toBe("0");
        expect(byKey.get("daily_call_quota")).toBe("42");
    });
});
