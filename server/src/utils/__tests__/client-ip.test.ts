import { describe, it, expect } from "bun:test";
import { getClientIp } from "../client-ip";

function headers(values: Record<string, string>) {
    return {
        get(name: string) {
            return values[name.toLowerCase()] ?? null;
        },
    };
}

describe("getClientIp (client-ip re-export)", () => {
    it("prefers cf-connecting-ip over x-real-ip", () => {
        expect(
            getClientIp(headers({ "cf-connecting-ip": "1.2.3.4", "x-real-ip": "5.6.7.8" })),
        ).toBe("1.2.3.4");
    });

    it("falls back to x-real-ip", () => {
        expect(getClientIp(headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    });
});
