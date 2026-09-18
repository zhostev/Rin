import { describe, expect, it } from "bun:test";
import { getClientIp } from "../client-ip";

function headers(map: Record<string, string>) {
    return {
        get(name: string) {
            return map[name.toLowerCase()] ?? null;
        },
    };
}

describe("getClientIp", () => {
    it("prefers cf-connecting-ip", () => {
        expect(
            getClientIp(headers({ "cf-connecting-ip": "1.2.3.4", "x-real-ip": "5.6.7.8" })),
        ).toBe("1.2.3.4");
    });

    it("falls back to x-real-ip", () => {
        expect(getClientIp(headers({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    });

    it("uses the first hop of x-forwarded-for", () => {
        expect(getClientIp(headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    });

    it("returns empty string when no headers", () => {
        expect(getClientIp(headers({}))).toBe("");
    });
});
