import { describe, it, expect } from "bun:test";
import {
    clearStoryVectorIds,
    getStoryVectorIds,
    setStoryVectorIds,
} from "../embed";

function makeDb(row: any = undefined) {
    const calls: any[] = [];
    const db: any = {
        query: {
            storyVectors: {
                findFirst: async () => row,
            },
        },
        insert: (_table: any) => ({
            values: (vals: any) => {
                calls.push({ op: "insert", vals });
                return {
                    onConflictDoUpdate: async (args: any) => {
                        calls.push({ op: "upsert", args });
                    },
                };
            },
        }),
        delete: (_table: any) => ({
            where: async () => {
                calls.push({ op: "delete" });
            },
        }),
        _calls: calls,
    };
    return db;
}

describe("story vector manifest", () => {
    it("getStoryVectorIds 无记录返回 []", async () => {
        expect(await getStoryVectorIds(makeDb(undefined), 1)).toEqual([]);
    });

    it("getStoryVectorIds 解析 JSON 列表", async () => {
        const db = makeDb({ storyId: 1, vectorIdsJson: '["s1b2c0","s1h0"]' });
        expect(await getStoryVectorIds(db, 1)).toEqual(["s1b2c0", "s1h0"]);
    });

    it("getStoryVectorIds 脏数据返回 []", async () => {
        expect(await getStoryVectorIds(makeDb({ vectorIdsJson: "not-json" }), 1)).toEqual([]);
        expect(await getStoryVectorIds(makeDb({ vectorIdsJson: '{"a":1}' }), 1)).toEqual([]);
    });

    it("setStoryVectorIds 写入 JSON（upsert）", async () => {
        const db = makeDb();
        await setStoryVectorIds(db, 7, ["s7b1c0"]);
        const ins = db._calls.find((c: any) => c.op === "insert");
        expect(ins.vals.storyId).toBe(7);
        expect(JSON.parse(ins.vals.vectorIdsJson)).toEqual(["s7b1c0"]);
        expect(db._calls.some((c: any) => c.op === "upsert")).toBe(true);
    });

    it("clearStoryVectorIds 删除记录", async () => {
        const db = makeDb();
        await clearStoryVectorIds(db, 7);
        expect(db._calls.some((c: any) => c.op === "delete")).toBe(true);
    });
});
