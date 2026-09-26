import { describe, it, expect } from "bun:test";
import {
    downloadImageBytes,
    extensionFromMime,
    filenameFromUrl,
    parseRemoteImageUrl,
    RemoteImageDownloadError,
    sniffImageMime,
} from "../from-url";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const AVIF = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]);

describe("parseRemoteImageUrl", () => {
    it("接受合法的 http/https 图片 URL", () => {
        const result = parseRemoteImageUrl("https://example.com/photo.jpg?x=1");
        expect("url" in result && result.url.hostname).toBe("example.com");
    });

    it("自动 trim 首尾空白", () => {
        const result = parseRemoteImageUrl("  https://example.com/a.png  ");
        expect("url" in result).toBe(true);
    });

    it("非字符串/空串/超长拒绝为 invalid_url", () => {
        expect(parseRemoteImageUrl(null)).toEqual({ error: "invalid_url" });
        expect(parseRemoteImageUrl(123)).toEqual({ error: "invalid_url" });
        expect(parseRemoteImageUrl("   ")).toEqual({ error: "invalid_url" });
        expect(parseRemoteImageUrl("not a url")).toEqual({ error: "invalid_url" });
        expect(parseRemoteImageUrl("https://" + "a".repeat(3000) + ".com/x")).toEqual({
            error: "invalid_url",
        });
    });

    it("非 http(s) 协议拒绝为 invalid_url", () => {
        expect(parseRemoteImageUrl("ftp://example.com/a.png")).toEqual({ error: "invalid_url" });
        expect(parseRemoteImageUrl("javascript:alert(1)")).toEqual({ error: "invalid_url" });
        expect(parseRemoteImageUrl("data:image/png;base64,AAA")).toEqual({ error: "invalid_url" });
    });

    it("URL 里带账密拒绝为 url_not_allowed", () => {
        expect(parseRemoteImageUrl("https://user:pass@example.com/a.png")).toEqual({
            error: "url_not_allowed",
        });
    });

    it.each([
        "http://localhost/a.png",
        "http://localhost:8080/a.png",
        "http://sub.localhost/a.png",
        "http://127.0.0.1/a.png",
        "http://127.1.2.3/a.png",
        "http://10.0.0.5/a.png",
        "http://172.16.4.9/a.png",
        "http://172.31.255.1/a.png",
        "http://192.168.1.1/a.png",
        "http://169.254.169.254/latest/meta-data/",
        "http://0.0.0.0/a.png",
        "http://224.0.0.1/a.png",
        "http://[::1]/a.png",
        "http://[::]/a.png",
        "http://[fe80::1]/a.png",
        "http://[fc00::1]/a.png",
        "http://[ff02::1]/a.png",
        "http://printer.local/a.png",
        "http://nas.internal/a.png",
    ])("内网/保留地址 %s 拒绝为 url_not_allowed", (raw) => {
        expect(parseRemoteImageUrl(raw)).toEqual({ error: "url_not_allowed" });
    });

    it("公网 IP 与普通域名放行", () => {
        expect("url" in parseRemoteImageUrl("http://8.8.8.8/a.png")).toBe(true);
        expect("url" in parseRemoteImageUrl("https://cdn.example.org/x/y.webp")).toBe(true);
    });

    it("path 里出现内网 IP 字样不影响（只看 hostname）", () => {
        const result = parseRemoteImageUrl("https://example.com/192.168.1.1.png");
        expect("url" in result).toBe(true);
    });

    it("172.15/172.32 不属于私网段，放行", () => {
        expect("url" in parseRemoteImageUrl("http://172.15.0.1/a.png")).toBe(true);
        expect("url" in parseRemoteImageUrl("http://172.32.0.1/a.png")).toBe(true);
    });
});

describe("sniffImageMime", () => {
    it.each([
        [PNG, "image/png"],
        [JPEG, "image/jpeg"],
        [WEBP, "image/webp"],
        [GIF, "image/gif"],
        [AVIF, "image/avif"],
    ])("识别魔数 %s", (bytes, mime) => {
        expect(sniffImageMime(bytes as Uint8Array)).toBe(mime);
    });

    it("未知/空字节返回 null", () => {
        expect(sniffImageMime(new Uint8Array([1, 2, 3, 4]))).toBeNull();
        expect(sniffImageMime(new Uint8Array(0))).toBeNull();
    });
});

describe("extensionFromMime", () => {
    it("映射常见图片 mime", () => {
        expect(extensionFromMime("image/jpeg")).toBe("jpg");
        expect(extensionFromMime("image/png")).toBe("png");
        expect(extensionFromMime("image/webp")).toBe("webp");
        expect(extensionFromMime("image/gif")).toBe("gif");
        expect(extensionFromMime("image/avif")).toBe("avif");
    });

    it("未知 mime 回退 jpg", () => {
        expect(extensionFromMime("image/xyz")).toBe("jpg");
        expect(extensionFromMime("")).toBe("jpg");
    });
});

describe("filenameFromUrl", () => {
    it("保留 URL path 里的文件名", () => {
        expect(filenameFromUrl(new URL("https://example.com/a/b/photo.PNG"), "image/png")).toBe(
            "photo.PNG",
        );
    });

    it("无扩展名时按 mime 补扩展名", () => {
        expect(filenameFromUrl(new URL("https://example.com/a/photo"), "image/jpeg")).toBe(
            "photo.jpg",
        );
    });

    it("根路径时用 image.<ext>", () => {
        expect(filenameFromUrl(new URL("https://example.com/"), "image/webp")).toBe("image.webp");
    });
});

function mockFetch(response: Response | ((url: string) => Response | Promise<Response>)) {
    return (async (url: string) => {
        return typeof response === "function" ? response(url) : response;
    }) as typeof fetch;
}

function pngResponse(headers: Record<string, string> = {}): Response {
    return new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png", ...headers },
    });
}

describe("downloadImageBytes", () => {
    it("成功下载并识别 mime", async () => {
        const { bytes, mime } = await downloadImageBytes(
            "https://example.com/a.png",
            10 * 1024 * 1024,
            mockFetch(pngResponse()),
        );
        expect(mime).toBe("image/png");
        expect(bytes.length).toBe(PNG.length);
    });

    it("上游非 2xx → download_failed（带 upstreamStatus）", async () => {
        const err = await downloadImageBytes(
            "https://example.com/a.png",
            1024,
            mockFetch(new Response("nope", { status: 404 })),
        ).catch((e) => e);
        expect(err).toBeInstanceOf(RemoteImageDownloadError);
        expect(err.code).toBe("download_failed");
        expect(err.upstreamStatus).toBe(404);
    });

    it("content-length 超限直接拒绝", async () => {
        const err = await downloadImageBytes(
            "https://example.com/a.png",
            1024,
            mockFetch(pngResponse({ "content-length": String(10 * 1024 * 1024) })),
        ).catch((e) => e);
        expect(err.code).toBe("image_too_large");
    });

    it("流式读取中超限中断", async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(600));
                controller.enqueue(new Uint8Array(600));
                controller.close();
            },
        });
        const err = await downloadImageBytes(
            "https://example.com/a.png",
            1000,
            mockFetch(new Response(stream, { headers: { "content-type": "image/png" } })),
        ).catch((e) => e);
        expect(err.code).toBe("image_too_large");
    });

    it("空 body → empty_image", async () => {
        const err = await downloadImageBytes(
            "https://example.com/a.png",
            1024,
            mockFetch(new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } })),
        ).catch((e) => e);
        expect(err.code).toBe("empty_image");
    });

    it("非图片字节 + 非图片 content-type → not_an_image", async () => {
        const err = await downloadImageBytes(
            "https://example.com/a.png",
            1024,
            mockFetch(
                new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
            ),
        ).catch((e) => e);
        expect(err.code).toBe("not_an_image");
    });

    it("魔数识别失败但 content-type 是 image/* 时回退 content-type", async () => {
        const { mime } = await downloadImageBytes(
            "https://example.com/a.png",
            1024,
            mockFetch(
                new Response(new Uint8Array([9, 9, 9, 9]), {
                    headers: { "content-type": "image/jpeg" },
                }),
            ),
        );
        expect(mime).toBe("image/jpeg");
    });

    it("fetch 抛错 → download_failed", async () => {
        const err = await downloadImageBytes("https://example.com/a.png", 1024, (async () => {
            throw new Error("boom");
        }) as typeof fetch).catch((e) => e);
        expect(err.code).toBe("download_failed");
    });
});
