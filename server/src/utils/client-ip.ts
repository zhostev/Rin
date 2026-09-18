/**
 * Extract the visitor IP from common reverse-proxy / Cloudflare headers.
 * Used for admin-only comment IP display; not for geolocation.
 */

function clean(value: string | undefined | null): string {
    if (!value) return "";
    return value.trim();
}

/** Prefer Cloudflare, then x-real-ip, then first hop of x-forwarded-for. */
export function getClientIp(headers: { get(name: string): string | null | undefined }): string {
    const cfIp = clean(headers.get("cf-connecting-ip"));
    if (cfIp) return cfIp;
    const realIp = clean(headers.get("x-real-ip"));
    if (realIp) return realIp;
    const forwarded = clean(headers.get("x-forwarded-for"));
    if (forwarded) return clean(forwarded.split(",")[0]);
    return "";
}
