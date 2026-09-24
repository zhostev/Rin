import { describe, expect, it } from "bun:test";
import { embedTexts } from "../embed";
import { EMBED_BATCH_SIZE, EMBEDDING_DIMENSIONS } from "../models";

const VEC = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i % 7) / 7);

function mockEnv() {
    const calls: string[][] = [];
    const env = {
        AI: {
            run: async (_model: unknown, input: { text: string[] }) => {
                calls.push(input.text);
                return { data: input.text.map(() => VEC) };
            },
        },
    } as any;
    return { env, calls };
}

describe("embedTexts", () => {
    it("fires onBatch once per actual AI call (for per-call usage accounting)", async () => {
        const { env, calls } = mockEnv();
        const seen: Array<{ batchIndex: number; batchSize: number }> = [];
        const texts = Array.from(
            { length: EMBED_BATCH_SIZE * 2 + 5 },
            (_, i) => `text-${i}`,
        );

        const vectors = await embedTexts(env, texts, {
            onBatch: (info) => {
                seen.push(info);
            },
        });

        expect(vectors).toHaveLength(texts.length);
        expect(calls).toHaveLength(3);
        expect(seen).toEqual([
            { batchIndex: 0, batchSize: EMBED_BATCH_SIZE },
            { batchIndex: 1, batchSize: EMBED_BATCH_SIZE },
            { batchIndex: 2, batchSize: 5 },
        ]);
    });

    it("does not call AI or onBatch for empty input", async () => {
        const { env, calls } = mockEnv();
        let fired = 0;
        const vectors = await embedTexts(env, [], {
            onBatch: () => {
                fired++;
            },
        });

        expect(vectors).toEqual([]);
        expect(calls).toHaveLength(0);
        expect(fired).toBe(0);
    });

    it("works without options", async () => {
        const { env } = mockEnv();
        const vectors = await embedTexts(env, ["a", "b"]);
        expect(vectors).toHaveLength(2);
        expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    });
});
