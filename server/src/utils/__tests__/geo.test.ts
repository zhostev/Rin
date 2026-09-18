import { describe, it, expect } from "bun:test";
import {
    composeLabel,
    countryNameFromCode,
    getClientIp,
    isIPv4,
    isPrivateIp,
    locationFromCloudflare,
    resolveGeoLocation,
} from "../geo";

function headers(values: Record<string, string>) {
    return {
        get(name: string) {
            return values[name.toLowerCase()] ?? null;
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

    it("falls back to the first x-forwarded-for hop", () => {
        expect(getClientIp(headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    });

    it("returns empty string when no header is present", () => {
        expect(getClientIp(headers({}))).toBe("");
    });
});

describe("isIPv4 / isPrivateIp", () => {
    it("detects ipv4", () => {
        expect(isIPv4("114.114.114.114")).toBe(true);
        expect(isIPv4("2400:cb00::1")).toBe(false);
        expect(isIPv4("999.1.1.1")).toBe(false);
    });

    it("detects private and reserved ranges", () => {
        expect(isPrivateIp("127.0.0.1")).toBe(true);
        expect(isPrivateIp("10.1.2.3")).toBe(true);
        expect(isPrivateIp("192.168.1.10")).toBe(true);
        expect(isPrivateIp("172.20.0.5")).toBe(true);
        expect(isPrivateIp("::1")).toBe(true);
        expect(isPrivateIp("114.114.114.114")).toBe(false);
        expect(isPrivateIp("2400:cb00::1")).toBe(false);
    });
});

describe("countryNameFromCode", () => {
    it("maps known codes to Chinese names", () => {
        expect(countryNameFromCode("CN")).toBe("中国");
        expect(countryNameFromCode("us")).toBe("美国");
        expect(countryNameFromCode("HK")).toBe("中国香港");
    });

    it("returns the raw code for unknown countries", () => {
        expect(countryNameFromCode("ZW")).toBe("ZW");
    });

    it("treats Cloudflare's unknown markers as empty", () => {
        expect(countryNameFromCode("XX")).toBe("");
        expect(countryNameFromCode("T1")).toBe("");
        expect(countryNameFromCode(null)).toBe("");
    });
});

describe("composeLabel", () => {
    it("joins province and city", () => {
        expect(composeLabel("中国", "江苏省", "南京市")).toBe("江苏省·南京市");
    });

    it("collapses municipalities", () => {
        expect(composeLabel("中国", "北京市", "北京市")).toBe("北京市");
    });

    it("keeps province only when city is missing", () => {
        expect(composeLabel("中国", "江苏省", "0")).toBe("江苏省");
    });

    it("falls back to country when there is no province", () => {
        expect(composeLabel("美国", "0", "0")).toBe("美国");
    });

    it("returns empty string when nothing is known", () => {
        expect(composeLabel("0", "0", "0")).toBe("");
    });
});

describe("locationFromCloudflare / resolveGeoLocation (CF-only)", () => {
    it("maps CF-IPCountry to a Chinese country label", async () => {
        const location = await resolveGeoLocation({ cfCountry: "JP" });
        expect(location).toEqual({
            label: "日本",
            country: "日本",
            province: "",
            city: "",
        });
    });

    it("uses Chinese CF province and city when provided", () => {
        const location = locationFromCloudflare({
            cfCountry: "CN",
            cfRegion: "Guangdong",
            cfRegionCode: "GD",
            cfCity: "Shenzhen",
        });

        expect(location).toEqual({
            label: "广东省·深圳市",
            country: "中国",
            province: "广东省",
            city: "深圳市",
        });
    });

    it("maps xi'an city alias", () => {
        const location = locationFromCloudflare({
            cfCountry: "CN",
            cfRegionCode: "SN",
            cfCity: "Xi'an",
        });
        expect(location.city).toBe("西安市");
        expect(location.province).toBe("陕西省");
        expect(location.label).toBe("陕西省·西安市");
    });

    it("keeps country-only granularity for foreign visitors even with city", () => {
        const location = locationFromCloudflare({
            cfCountry: "US",
            cfRegion: "California",
            cfCity: "San Francisco",
        });
        expect(location.label).toBe("美国");
        expect(location.province).toBe("");
        expect(location.city).toBe("");
    });

    it("works for IPv6 visitors via CF geo (no IP2REGION)", async () => {
        const location = await resolveGeoLocation({
            ip: "240e:446:3249:b16:a019:a338:6089:5062",
            cfCountry: "CN",
            cfRegion: "Jiangsu",
            cfRegionCode: "JS",
            cfCity: "Nanjing",
        });
        expect(location).toEqual({
            label: "江苏省·南京市",
            country: "中国",
            province: "江苏省",
            city: "南京市",
        });
    });

    it("never throws for empty input", async () => {
        const location = await resolveGeoLocation({});
        expect(location.label).toBe("");
    });
});
