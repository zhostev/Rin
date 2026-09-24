/**
 * Stage 3 · 媒体中心：查询参数解析小工具。
 *
 * GET /api/media 的过滤参数全部是可选的，非法值返回 400 而不是静默忽略，
 * 让前端能立刻发现拼错的枚举值。
 */

export function parsePositiveInteger(value: string | undefined, fallback: number, maximum?: number): number {
    if (value === undefined || value === "") {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return NaN;
    }
    return maximum !== undefined ? Math.min(parsed, maximum) : parsed;
}

/** 解析可选的整数过滤参数；非法（非数字）时返回 NaN，由调用方判 400。 */
export function parseOptionalInteger(value: string | undefined): number | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * `updated` 三态过滤（与前端 media-filters.ts 的 tri-state 对齐）：
 *   'true'  → 只看有更新的；'false' → 只看未更新的；
 *   缺省/空 → 不过滤；其它取值 → 返回 'invalid'，由调用方判 400。
 */
export function parseUpdatedFlag(value: string | undefined): boolean | undefined | "invalid" {
    if (value === undefined || value === "") {
        return undefined;
    }
    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    return "invalid";
}
