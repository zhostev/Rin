import { describe, expect, test } from "bun:test";
import {
    buildRelaySubmitBody,
    normalizeMinimaxRelayUrl,
    parseRelayJobStatus,
    resolveMinimaxRelay,
    validateVideoParams,
} from "../minimax";
import { MINIMAX_VIDEO_MODEL } from "../models";

describe("validateVideoParams", () => {
    test("默认参数：6 秒 / 768P / 16:9", () => {
        const r = validateVideoParams({ text: "一只猫在月光下奔跑" });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.spec).toEqual({
                prompt: "一只猫在月光下奔跑",
                duration: 6,
                resolution: "768P",
                ratio: "16:9",
            });
        }
    });

    test("空 prompt 被拒绝", () => {
        expect(validateVideoParams({ text: "   " }).ok).toBe(false);
        expect(validateVideoParams({}).ok).toBe(false);
    });

    test("超长 prompt 被拒绝", () => {
        const r = validateVideoParams({ text: "x".repeat(7001) });
        expect(r.ok).toBe(false);
    });

    test("7000 字符恰好通过", () => {
        expect(validateVideoParams({ text: "x".repeat(7000) }).ok).toBe(true);
    });

    test("duration 越界被拒绝", () => {
        expect(validateVideoParams({ text: "a", params: { duration: 3 } }).ok).toBe(false);
        expect(validateVideoParams({ text: "a", params: { duration: 16 } }).ok).toBe(false);
        expect(validateVideoParams({ text: "a", params: { duration: 6.5 } }).ok).toBe(false);
        expect(validateVideoParams({ text: "a", params: { duration: 15 } }).ok).toBe(true);
    });

    test("非法 resolution / ratio 被拒绝", () => {
        expect(validateVideoParams({ text: "a", params: { resolution: "1080P" } }).ok).toBe(false);
        expect(validateVideoParams({ text: "a", params: { resolution: "2K" } }).ok).toBe(true);
        expect(validateVideoParams({ text: "a", params: { ratio: "adaptive" } }).ok).toBe(false);
        expect(validateVideoParams({ text: "a", params: { ratio: "9:16" } }).ok).toBe(true);
    });

    test("带首帧图片时 ratio 固定为 adaptive", () => {
        const r = validateVideoParams({ text: "a", assetId: 42, params: { ratio: "16:9" } });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.spec.ratio).toBe("adaptive");
            expect(r.spec.firstFrameAssetId).toBe(42);
        }
    });
});

describe("buildRelaySubmitBody", () => {
    test("文生视频 body", () => {
        const body = buildRelaySubmitBody({
            prompt: "海浪",
            duration: 6,
            resolution: "768P",
            ratio: "16:9",
        });
        expect(body).toEqual({
            model: MINIMAX_VIDEO_MODEL,
            prompt: "海浪",
            duration: 6,
            resolution: "768P",
            ratio: "16:9",
        });
    });

    test("图生视频带上 first_frame_url", () => {
        const body = buildRelaySubmitBody(
            {
                prompt: "动起来",
                duration: 4,
                resolution: "2K",
                ratio: "adaptive",
                firstFrameAssetId: 7,
            },
            "https://pub.example.com/abc.jpg",
        );
        expect(body["first_frame_url"]).toBe("https://pub.example.com/abc.jpg");
        expect(body["ratio"]).toBe("adaptive");
    });

    test("没有 URL 时不带 first_frame_url 字段", () => {
        const body = buildRelaySubmitBody({
            prompt: "动起来",
            duration: 4,
            resolution: "2K",
            ratio: "adaptive",
            firstFrameAssetId: 7,
        });
        expect("first_frame_url" in body).toBe(false);
    });

    test("幂等键可选携带", () => {
        const body = buildRelaySubmitBody(
            { prompt: "海浪", duration: 6, resolution: "768P", ratio: "16:9" },
            undefined,
            "aistudio-123",
        );
        expect(body["client_job_id"]).toBe("aistudio-123");
        const noKey = buildRelaySubmitBody({
            prompt: "海浪",
            duration: 6,
            resolution: "768P",
            ratio: "16:9",
        });
        expect("client_job_id" in noKey).toBe(false);
    });
});

describe("parseRelayJobStatus", () => {
    test("已知状态原样返回，未知值归一为 unknown", () => {
        expect(parseRelayJobStatus("queued")).toBe("queued");
        expect(parseRelayJobStatus("running")).toBe("running");
        expect(parseRelayJobStatus("succeeded")).toBe("succeeded");
        expect(parseRelayJobStatus("failed")).toBe("failed");
        expect(parseRelayJobStatus("cancelled")).toBe("unknown");
        expect(parseRelayJobStatus(null)).toBe("unknown");
        expect(parseRelayJobStatus("SUCCESS")).toBe("unknown");
    });
});

describe("resolveMinimaxRelay", () => {
    test("未配置时返回明确错误", () => {
        const r = resolveMinimaxRelay({} as Env);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("MINIMAX_RELAY_URL");
    });

    test("缺 secret 时报错", () => {
        const r = resolveMinimaxRelay({ MINIMAX_RELAY_URL: "https://ddns.hoo.ink:18081" } as Env);
        expect(r.ok).toBe(false);
    });

    test("非法 URL 时报错", () => {
        const r = resolveMinimaxRelay({
            MINIMAX_RELAY_URL: "not a url",
            MINIMAX_RELAY_SECRET: "s",
        } as Env);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("合法");
    });

    test("正常解析并清洗不可见字符", () => {
        const r = resolveMinimaxRelay({
            MINIMAX_RELAY_URL: "https://ddns.hoo.ink:18081/" + "\u200b",
            MINIMAX_RELAY_SECRET: "s" + "\u200b" + "ecret",
        } as Env);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.config.url).toBe("https://ddns.hoo.ink:18081");
            expect(r.config.secret).toBe("secret");
        }
    });
});

describe("normalizeMinimaxRelayUrl", () => {
    test("去末尾斜杠与空值", () => {
        expect(normalizeMinimaxRelayUrl("https://a.b:18081///")).toBe("https://a.b:18081");
        expect(normalizeMinimaxRelayUrl("")).toBeUndefined();
        expect(normalizeMinimaxRelayUrl(undefined)).toBeUndefined();
    });
});
