/**
 * 评论归属地解析。
 *
 * 国内精度（省/市）来自内网 ip2region 服务，通过 Cloudflare VPC Service 绑定
 * `IP2REGION` 访问（执事需在 Cloudflare 面板创建 VPC Service ddns → 127.0.0.1:8090）。
 * 绑定不存在或调用失败时，退回 Cloudflare 自身的 `CF-IPCountry` / `request.cf`。
 * 任何情况下解析失败都不应阻断评论写入。
 */

export interface GeoLocation {
    /** 展示用归属地标签，如 `江苏省·南京市`、`美国`；无法解析时为空字符串 */
    label: string;
    country: string;
    province: string;
    city: string;
}

export interface Ip2RegionResponse {
    country?: string;
    region?: string;
    province?: string;
    city?: string;
    isp?: string;
    raw?: string;
    ip?: string;
}

/** VPC Service / Service binding 都实现了 `fetch`，测试里用普通对象即可替代 */
export interface GeoFetcher {
    fetch(input: string, init?: RequestInit): Promise<Response>;
}

export const EMPTY_LOCATION: GeoLocation = { label: "", country: "", province: "", city: "" };

/** ip2region 用 `0` 表示「无数据」 */
function clean(value: string | undefined | null): string {
    if (!value) return "";
    const trimmed = value.trim();
    if (!trimmed || trimmed === "0") return "";
    return trimmed;
}

const COUNTRY_NAMES: Record<string, string> = {
    CN: "中国", HK: "中国香港", MO: "中国澳门", TW: "中国台湾",
    US: "美国", JP: "日本", KR: "韩国", SG: "新加坡", MY: "马来西亚",
    TH: "泰国", VN: "越南", ID: "印度尼西亚", PH: "菲律宾", IN: "印度",
    GB: "英国", DE: "德国", FR: "法国", IT: "意大利", ES: "西班牙",
    NL: "荷兰", BE: "比利时", CH: "瑞士", AT: "奥地利", SE: "瑞典",
    NO: "挪威", DK: "丹麦", FI: "芬兰", PL: "波兰", CZ: "捷克",
    PT: "葡萄牙", IE: "爱尔兰", GR: "希腊", RO: "罗马尼亚", HU: "匈牙利",
    RU: "俄罗斯", UA: "乌克兰", TR: "土耳其", IL: "以色列", AE: "阿联酋",
    SA: "沙特阿拉伯", QA: "卡塔尔", KZ: "哈萨克斯坦", PK: "巴基斯坦",
    BD: "孟加拉国", NP: "尼泊尔", LK: "斯里兰卡", MM: "缅甸", KH: "柬埔寨",
    LA: "老挝", MN: "蒙古", CA: "加拿大", MX: "墨西哥", BR: "巴西",
    AR: "阿根廷", CL: "智利", CO: "哥伦比亚", PE: "秘鲁",
    AU: "澳大利亚", NZ: "新西兰", ZA: "南非", EG: "埃及", NG: "尼日利亚",
    KE: "肯尼亚", MA: "摩洛哥",
};

const CN_REGION_NAMES: Record<string, string> = {
    AH: "安徽省", BJ: "北京市", CQ: "重庆市", FJ: "福建省", GS: "甘肃省",
    GD: "广东省", GX: "广西壮族自治区", GZ: "贵州省", HAIN: "海南省", HE: "河北省",
    HL: "黑龙江省", HA: "河南省", HB: "湖北省", HN: "湖南省", JL: "吉林省",
    JS: "江苏省", JX: "江西省", LN: "辽宁省", NM: "内蒙古自治区", NX: "宁夏回族自治区",
    QH: "青海省", SN: "陕西省", SD: "山东省", SH: "上海市", SX: "山西省",
    SC: "四川省", TJ: "天津市", XJ: "新疆维吾尔自治区", XZ: "西藏自治区",
    YN: "云南省", ZJ: "浙江省",
};

const CN_REGION_ALIASES: Record<string, string> = {
    anhui: "安徽省", beijing: "北京市", chongqing: "重庆市", fujian: "福建省",
    gansu: "甘肃省", guangdong: "广东省", guangxi: "广西壮族自治区", guizhou: "贵州省",
    hainan: "海南省", hebei: "河北省", heilongjiang: "黑龙江省", henan: "河南省",
    hubei: "湖北省", hunan: "湖南省", jilin: "吉林省", jiangsu: "江苏省",
    jiangxi: "江西省", liaoning: "辽宁省", neimenggu: "内蒙古自治区", "inner mongolia": "内蒙古自治区",
    ningxia: "宁夏回族自治区", qinghai: "青海省", shaanxi: "陕西省", shandong: "山东省",
    shanghai: "上海市", shanxi: "山西省", sichuan: "四川省", tianjin: "天津市",
    xinjiang: "新疆维吾尔自治区", xizang: "西藏自治区", tibet: "西藏自治区",
    yunnan: "云南省", zhejiang: "浙江省",
};

const CN_CITY_NAMES: Record<string, string> = {
    beijing: "北京市", shanghai: "上海市", tianjin: "天津市", chongqing: "重庆市",
    guangzhou: "广州市", shenzhen: "深圳市", dongguan: "东莞市", foshan: "佛山市",
    zhuhai: "珠海市", huizhou: "惠州市", nanjing: "南京市", suzhou: "苏州市",
    wuxi: "无锡市", xuzhou: "徐州市", hangzhou: "杭州市", ningbo: "宁波市",
    wuhan: "武汉市", chengdu: "成都市", xian: "西安市", xi'an: "西安市",
    qingdao: "青岛市", jinan: "济南市", zhengzhou: "郑州市", changsha: "长沙市",
    kunming: "昆明市", xiamen: "厦门市", fuzhou: "福州市", hefei: "合肥市",
};

/** ISO 3166-1 alpha-2 → 中文国家名；未收录时原样返回国家码 */
export function countryNameFromCode(code: string | undefined | null): string {
    const normalized = clean(code).toUpperCase();
    if (!normalized || normalized === "XX" || normalized === "T1") return "";
    return COUNTRY_NAMES[normalized] || normalized;
}

export function isIPv4(ip: string): boolean {
    const parts = clean(ip).split(".");
    if (parts.length !== 4) return false;
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 内网 / 环回 / 保留地址无归属地可查，直接跳过 ip2region 调用 */
export function isPrivateIp(ip: string): boolean {
    const value = clean(ip);
    if (!value) return true;
    if (value === "::1" || value.toLowerCase().startsWith("fc") || value.toLowerCase().startsWith("fd")) {
        return true;
    }
    if (!isIPv4(value)) return false;
    const [a = 0, b = 0] = value.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
}

/** 从请求头取真实访客 IP：Cloudflare 优先，其次反代常用的 x-real-ip */
export function getClientIp(headers: { get(name: string): string | null | undefined }): string {
    const cfIp = clean(headers.get("cf-connecting-ip"));
    if (cfIp) return cfIp;
    const realIp = clean(headers.get("x-real-ip"));
    if (realIp) return realIp;
    // x-forwarded-for 可能是 `client, proxy1, proxy2`
    const forwarded = clean(headers.get("x-forwarded-for"));
    if (forwarded) return clean(forwarded.split(",")[0]);
    return "";
}

/**
 * 组合展示标签：国内到市，境外只到国家。
 * `北京市 / 北京市` 这类直辖市会被折叠成单段。
 */
export function composeLabel(country: string, province: string, city: string): string {
    const c = clean(country);
    const p = clean(province);
    const ct = clean(city);

    if (p) {
        if (ct && ct !== p) return `${p}·${ct}`;
        return p;
    }
    if (c && ct) return `${c}·${ct}`;
    return c || ct || "";
}

/**
 * 调用内网 ip2region 服务。失败（超时 / 非 2xx / 非法 JSON）时返回 null，
 * 由调用方退回 Cloudflare 国家级信息。
 */
export async function lookupIp2Region(
    fetcher: GeoFetcher,
    ip: string,
    options: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<Ip2RegionResponse | null> {
    const baseUrl = (options.baseUrl || "http://ip2region.internal").replace(/\/+$/, "");
    const timeoutMs = options.timeoutMs ?? 1500;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetcher.fetch(`${baseUrl}/lookup?ip=${encodeURIComponent(ip)}`, {
            method: "GET",
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = (await res.json()) as Ip2RegionResponse;
        if (!data || typeof data !== "object") return null;
        return data;
    } catch (error) {
        console.warn("ip2region lookup failed", error);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 选择 ip2region 的调用方式：
 * 1. VPC Service 绑定 `IP2REGION`（执事在 Cloudflare 面板创建 ddns → 127.0.0.1:8090 后绑定）
 * 2. 公网可达的 `IP2REGION_URL`（本地开发 / 隧道公开地址时使用）
 * 都没有则返回 null，归属地退化到国家级。
 */
export function geoFetcherFromEnv(
    env: Partial<Env> | undefined | null,
): { fetcher: GeoFetcher; baseUrl: string } | null {
    if (!env) return null;
    if (env.IP2REGION && typeof env.IP2REGION.fetch === "function") {
        return {
            fetcher: env.IP2REGION as unknown as GeoFetcher,
            baseUrl: clean(env.IP2REGION_BASE_URL) || "http://ip2region.internal",
        };
    }
    const url = clean(env.IP2REGION_URL);
    if (url) {
        return {
            fetcher: { fetch: (input, init) => fetch(input, init) },
            baseUrl: url,
        };
    }
    return null;
}

export interface ResolveGeoOptions {
    ip: string;
    /** `CF-IPCountry` 请求头或 `request.cf.country` */
    cfCountry?: string | null;
    /** Cloudflare `request.cf` 地理字段，通常比 CF-IPCountry 更精确 */
    cfCity?: string | null;
    cfRegion?: string | null;
    cfRegionCode?: string | null;
    fetcher?: GeoFetcher | null;
    baseUrl?: string;
    timeoutMs?: number;
}

function normalizeCnRegion(value: string | null | undefined, regionCode: string | null | undefined): string {
    const code = clean(regionCode).toUpperCase().replace(/^CN[-_]/, "");
    if (CN_REGION_NAMES[code]) return CN_REGION_NAMES[code];

    const normalized = clean(value).toLowerCase().replace(/[\s_-]+/g, " ").replace(/ province$/, "");
    return CN_REGION_ALIASES[normalized] || clean(value);
}

function normalizeCnCity(value: string | null | undefined): string {
    const raw = clean(value);
    if (!raw) return "";
    const normalized = raw.toLowerCase().replace(/[\s_-]+/g, " ");
    if (CN_CITY_NAMES[normalized]) return CN_CITY_NAMES[normalized];
    if (/市$/.test(raw)) return raw;
    return raw;
}

/** 使用 Cloudflare 的 request.cf 补足 IPv6 或 ip2region 不可用时的省市信息。 */
export function locationFromCloudflare(options: Pick<ResolveGeoOptions, "cfCountry" | "cfCity" | "cfRegion" | "cfRegionCode">): GeoLocation {
    const country = countryNameFromCode(options.cfCountry);
    const isChina = clean(options.cfCountry).toUpperCase() === "CN" || country === "中国";
    const province = isChina ? normalizeCnRegion(options.cfRegion, options.cfRegionCode) : "";
    const city = isChina ? normalizeCnCity(options.cfCity) : "";
    const label = composeLabel(country, province, city);
    return { label, country, province, city };
}

/**
 * 解析归属地。永不抛错：任何异常都退化为国家级或空标签。
 */
export async function resolveGeoLocation(options: ResolveGeoOptions): Promise<GeoLocation> {
    const ip = clean(options.ip);
    if (!ip || isPrivateIp(ip)) {
        return locationFromCloudflare(options);
    }

    // ip2region 只提供 IPv4 数据；IPv6 直接走 Cloudflare request.cf
    if (options.fetcher && isIPv4(ip)) {
        const data = await lookupIp2Region(options.fetcher, ip, {
            baseUrl: options.baseUrl,
            timeoutMs: options.timeoutMs,
        });
        if (data) {
            const country = clean(data.country) || cfCountryName;
            const province = clean(data.province);
            const city = clean(data.city);
            const label = composeLabel(country, province, city);
            if (label) {
                return { label, country, province, city };
            }
        }
    }

    return locationFromCloudflare(options);
}
