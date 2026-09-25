export function stripImageMetadataFromUrl(url?: string | null) {
    if (!url) {
        return undefined;
    }

    return url.split("#", 2)[0];
}

export function parseImageMetadataFromUrl(url?: string | null) {
    if (!url) {
        return {
            src: undefined,
            blurhash: undefined,
            width: undefined,
            height: undefined,
        };
    }

    const [src, fragment = ""] = url.split("#", 2);
    const params = new URLSearchParams(fragment);
    const width = params.get("width");
    const height = params.get("height");

    return {
        src,
        blurhash: params.get("blurhash") || undefined,
        width: width ? Number.parseInt(width, 10) : undefined,
        height: height ? Number.parseInt(height, 10) : undefined,
    };
}

export function listMarkdownImageUrls(content: string) {
    const imagePattern = /!\[.*?\]\((\S+?)(?:\s+"[^"]*")?\)/g;
    const matches: string[] = [];

    for (const match of content.matchAll(imagePattern)) {
        if (match[1]) {
            matches.push(match[1]);
        }
    }

    return matches;
}

export function listHtmlImageUrls(content: string) {
    const imagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    const matches: string[] = [];

    for (const match of content.matchAll(imagePattern)) {
        if (match[1]) {
            matches.push(match[1]);
        }
    }

    return matches;
}

export function listContentImageUrls(content: string) {
    return [...listMarkdownImageUrls(content), ...listHtmlImageUrls(content)];
}

export function contentHasImagesMissingMetadata(content: string) {
    return listContentImageUrls(content).some((url) => {
        const metadata = parseImageMetadataFromUrl(url);
        return !metadata.blurhash || !metadata.width || !metadata.height;
    });
}

export function extractImage(content: string) {
    const urls = listContentImageUrls(content);
    for (const url of urls) {
        if (url.startsWith('data:')) continue;
        return stripImageMetadataFromUrl(url);
    }
    return undefined;
}

export function extractImageWithMetadata(content: string) {
    const urls = listContentImageUrls(content);
    for (const url of urls) {
        if (url.startsWith('data:')) continue;
        return url;
    }
    return undefined;
}

function escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip the site's own origin from content URLs so stored content stays
 * domain-independent: `https://example.com/api/blob/x.jpg` → `/api/blob/x.jpg`.
 *
 * Only rewrites the origin when it is immediately followed by `/`, so a bare
 * origin mention in prose (e.g. "see https://example.com") is left untouched.
 */
export function stripSiteOrigin(content: string, origin: string): string {
    if (!content || !origin) return content;
    const pattern = new RegExp(`${escapeRegExp(origin)}(?=/)`, "g");
    return content.replace(pattern, "");
}

/**
 * Resolve a possibly-relative URL against an origin.
 * Absolute inputs pass through unchanged via `new URL(candidate, base)`.
 */
export function toAbsoluteUrl(candidate: string | undefined, origin: string): string | undefined {
    if (!candidate) {
        return undefined;
    }
    try {
        return new URL(candidate, origin).toString();
    } catch {
        return undefined;
    }
}

/**
 * Rewrite relative src/href attributes in an HTML fragment to absolute URLs.
 * For off-site renderers (RSS readers) that cannot resolve relative URLs.
 */
export function absolutizeContentUrls(html: string, origin: string): string {
    if (!html || !origin) return html;
    return html.replace(
        /\b(src|href)="(\/[^"]*)"/g,
        (_m, attr: string, path: string) => `${attr}="${new URL(path, origin).toString()}"`,
    );
}
