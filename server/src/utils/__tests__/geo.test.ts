import { describe, it, expect, mock } from "bun:test";
import {
    composeLabel,
    countryNameFromCode,
    getClientIp,
    isIPv4,
    isPrivateIp,
    lookupIp2Region,
    resolveGeoLocation,
    type GeoFetcher,
} from "../geo";

function headers(values: Record<string, string>) {
    return {
        get(name: string) {
            return values[name.toLowerCase()] ?? null;
        },
    };
}

function fetcherReturning(body: unknown, init: ResponseInit = {}): GeoFetcher {
    return {
        fetch: mock(async () => new Response(JSON.stringify(body), { status: 200, ...init })),
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

describe("lookupIp2Region", () => {
    it("calls the binding with the lookup path", async () => {
        const fetcher = fetcherReturning({ country: "中国", province: "江苏省", city: "南京市" });
        const data = await lookupIp2Region(fetcher, "114.114.114.114");

        expect(data?.province).toBe("江苏省");
        const call = (fetcher.fetch as any).mock.calls[0][0] as string;
        expect(call).toContain("/lookup?ip=114.114.114.114");
    });

    it("honours a custom base url", async () => {
        const fetcher = fetcherReturning({ country: "中国" });
        await lookupIp2Region(fetcher, "1.1.1.1", { baseUrl: "http://127.0.0.1:8090/" });

        const call = (fetcher.fetch as any).mock.calls[0][0] as string;
        expect(call).toBe("http://127.0.0.1:8090/lookup?ip=1.1.1.1");
    });

    it("returns null on non-2xx responses", async () => {
        const fetcher: GeoFetcher = { fetch: async () => new Response("nope", { status: 502 }) };
        expect(await lookupIp2Region(fetcher, "1.1.1.1")).toBeNull();
    });

    it("returns null when the binding throws", async () => {
        const fetcher: GeoFetcher = {
            fetch: async () => {
                throw new Error("no route to host");
            },
        };
        expect(await lookupIp2Region(fetcher, "1.1.1.1")).toBeNull();
    });

    it("returns null on invalid JSON", async () => {
        const fetcher: GeoFetcher = { fetch: async () => new Response("<html>", { status: 200 }) };
        expect(await lookupIp2Region(fetcher, "1.1.1.1")).toBeNull();
    });
});

describe("resolveGeoLocation", () => {
    it("uses ip2region province/city for domestic ips", async () => {
        const fetcher = fetcherReturning({
            country: "中国",
            province: "江苏省",
            city: "南京市",
            isp: "电信",
        });

        const location = await resolveGeoLocation({
            ip: "114.114.114.114",
            cfCountry: "CN",
            fetcher,
        });

        expect(location).toEqual({
            label: "江苏省·南京市",
            country: "中国",
            province: "江苏省",
            city: "南京市",
        });
    });

    it("keeps country granularity for foreign ips", async () => {
        const fetcher = fetcherReturning({ country: "美国", province: "0", city: "0", isp: "Level3" });

        const location = await resolveGeoLocation({ ip: "8.8.8.8", cfCountry: "US", fetcher });

        expect(location.label).toBe("美国");
        expect(location.province).toBe("");
        expect(location.city).toBe("");
    });

    it("falls back to CF-IPCountry when the binding is unavailable", async () => {
        const location = await resolveGeoLocation({ ip: "8.8.8.8", cfCountry: "JP", fetcher: null });

        expect(location.label).toBe("日本");
        expect(location.country).toBe("日本");
    });

    it("falls back to CF-IPCountry when the binding fails", async () => {
        const fetcher: GeoFetcher = {
            fetch: async () => {
                throw new Error("VPC service unreachable");
            },
        };

        const location = await resolveGeoLocation({ ip: "114.114.114.114", cfCountry: "CN", fetcher });

        expect(location.label).toBe("中国");
    });

    it("uses Chinese CF province and city for IPv6", async () => {
        const fetcher = fetcherReturning({ country: "中国", province: "江苏省", city: "南京市" });

        const location = await resolveGeoLocation({
            ip: "240e:446:3249:b16:a019:a338:6089:5062",
            cfCountry: "CN",
            cfRegion: "Guangdong",
            cfRegionCode: "GD",
            cfCity: "Shenzhen",
            fetcher,
        });

        expect(location).toEqual({
            label: "广东省·深圳市",
            country: "中国",
            province: "广东省",
            city: "深圳市",
        });
        expect((fetcher.fetch as any).mock.calls.length).toBe(0);
    });

    it("prefers successful IPv4 ip2region data over CF geo", async () => {
        const fetcher = fetcherReturning({ country: "中国", province: "江苏省", city: "南京市" });

        const location = await resolveGeoLocation({
            ip: "114.114.114.114",
            cfCountry: "CN",
            cfRegion: "Guangdong",
            cfRegionCode: "GD",
            cfCity: "Shenzhen",
            fetcher,
        });

        expect(location.label).toBe("江苏省·南京市");
    });

    it("skips the binding for ipv6 and uses the country code", async () => {
        const fetcher = fetcherReturning({ country: "中国", province: "江苏省", city: "南京市" });

        const location = await resolveGeoLocation({
            ip: "2400:cb00:1234::1",
            cfCountry: "CN",
            fetcher,
        });

        expect(location.label).toBe("中国");
        expect((fetcher.fetch as any).mock.calls.length).toBe(0);
    });

    it("does not look up private ips", async () => {
        const fetcher = fetcherReturning({ country: "中国", province: "江苏省", city: "南京市" });

        const location = await resolveGeoLocation({ ip: "192.168.1.5", cfCountry: "", fetcher });

        expect(location.label).toBe("");
        expect((fetcher.fetch as any).mock.calls.length).toBe(0);
    });

    it("never throws for empty input", async () => {
        const location = await resolveGeoLocation({ ip: "" });
        expect(location.label).toBe("");
    });
});
