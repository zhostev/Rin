/**
 * 文章播客化 TTS · 文本预处理（纯函数）。
 *
 * 把文章 markdown 转成适合朗读的纯文本：去掉图片/代码块/表格语法、
 * 站内 [[media:N]] 占位符，标题转停顿；再按段落切成 TTS 友好的小块。
 */

/** 站内媒体引用占位符：[[media:1]]（AI 写作链路插入，读出来是噪音）。 */
const MEDIA_PLACEHOLDER_RE = /\[\[media:\d+\]\]/g;

/** 代码围栏块（含 ~~~ 风格）：整块删除，不朗读代码。 */
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g;

/** 图片：整段删除（alt 文本也不读，避免 "image" 噪音）。 */
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;

/** 链接：保留文字，去掉 URL。 */
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;

/** 行内代码：保留内容，去掉反引号。 */
const INLINE_CODE_RE = /`([^`]*)`/g;

/** HTML 标签。 */
const HTML_TAG_RE = /<[^>]+>/g;

/** 表格分隔行：|---|---| 或 --- 风格。 */
const TABLE_SEPARATOR_RE = /^\|?[\s:|-]+\|?\s*$/;

/** 分隔线。 */
const HR_RE = /^\s*(\*\*\*|---|___)\s*$/;

function stripTableRow(line: string): string {
    const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
    return cells.join("，");
}

/**
 * markdown → 朗读纯文本。纯函数，可单测。
 */
export function markdownToSpeechText(md: string): string {
    if (!md) return "";

    let text = md.replace(FENCED_CODE_RE, "\n");
    text = text.replace(MEDIA_PLACEHOLDER_RE, "");

    const out: string[] = [];
    for (const rawLine of text.split("\n")) {
        let line = rawLine;

        // 表格：分隔行丢弃，数据行拍平成逗号短句
        if (line.trim().startsWith("|") && TABLE_SEPARATOR_RE.test(line.trim())) continue;
        if (line.trim().startsWith("|")) {
            line = stripTableRow(line);
        }

        if (HR_RE.test(line)) continue;

        // 标题 → 文字 + 句号（停顿）
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            line = `${heading[2].trim()}。`;
        }

        // 引用 / 列表标记
        line = line.replace(/^>\s?/, "");
        line = line.replace(/^\s*[-*+]\s+/, "");
        line = line.replace(/^\s*\d+[.)]\s+/, "");

        line = line.replace(IMAGE_RE, "");
        line = line.replace(LINK_RE, "$1");
        line = line.replace(INLINE_CODE_RE, "$1");
        // 加粗/斜体标记
        line = line.replace(/(\*\*|__)(.*?)\1/g, "$2");
        line = line.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
        line = line.replace(HTML_TAG_RE, "");

        line = line.trim();
        if (line) out.push(line);
    }

    // 合并连续空行：上面已丢弃空行，直接单换行连接
    return out.join("\n");
}

/** 句子结束标点（中英）：用于超长段落的软切分。 */
const SENTENCE_END_RE = /(?<=[。！？!?；;])\s*/;

/**
 * 按段落切块，单块 ≤ maxChars。超长段落先按句号切，单句仍超限则硬切。
 * 纯函数，可单测。
 */
export function chunkSpeechText(text: string, maxChars = 1500): string[] {
    if (!text.trim()) return [];

    const chunks: string[] = [];
    let current = "";

    const pushCurrent = () => {
        const t = current.trim();
        if (t) chunks.push(t);
        current = "";
    };

    const appendPiece = (piece: string) => {
        if ((current + "\n" + piece).trim().length <= maxChars) {
            current = current ? `${current}\n${piece}` : piece;
            return;
        }
        pushCurrent();
        current = piece;
    };

    for (const paragraph of text.split("\n")) {
        const p = paragraph.trim();
        if (!p) continue;
        if (p.length <= maxChars) {
            appendPiece(p);
            continue;
        }
        // 超长段落：按句子切
        pushCurrent();
        let rest = p;
        while (rest.length > maxChars) {
            const sentences = rest.split(SENTENCE_END_RE);
            let acc = "";
            let consumed = 0;
            for (const s of sentences) {
                if ((acc + s).length <= maxChars) {
                    acc += s;
                    consumed += s.length;
                } else {
                    break;
                }
            }
            if (!acc) {
                // 单句仍超限：硬切
                chunks.push(rest.slice(0, maxChars));
                rest = rest.slice(maxChars);
            } else {
                chunks.push(acc);
                rest = rest.slice(consumed).trimStart();
            }
        }
        if (rest) chunks.push(rest);
    }
    pushCurrent();
    return chunks;
}
