import { describe, expect, it } from "bun:test";
import {
  buildComposeUserMessage,
  checkComposeGate,
  composeMaxTokensFloor,
  parseComposedArticle,
  renderMediaPlaceholders,
  type ComposeAsset,
} from "../ai-compose";

const imageAsset: ComposeAsset = {
  id: "img-1",
  type: "image",
  provider: "r2",
  note: "架构示意图",
};

const videoAsset: ComposeAsset = {
  id: "vid-1",
  type: "video",
  provider: "stream",
  note: "演示录屏",
};

describe("buildComposeUserMessage", () => {
  it("includes the topic and the requested word range", () => {
    const message = buildComposeUserMessage({
      topic: "聊聊本地优先软件",
      assets: [],
      length: "medium",
    });

    expect(message).toContain("聊聊本地优先软件");
    expect(message).toContain("1200");
    expect(message).toContain("2000");
  });

  it("numbers the assets from 1 and shows each note", () => {
    const message = buildComposeUserMessage({
      topic: "选题",
      assets: [imageAsset, videoAsset],
      length: "short",
    });

    expect(message).toContain("[[media:1]]");
    expect(message).toContain("架构示意图");
    expect(message).toContain("[[media:2]]");
    expect(message).toContain("演示录屏");
  });

  it("never leaks the real asset id into the prompt", () => {
    const message = buildComposeUserMessage({
      topic: "选题",
      assets: [imageAsset],
      length: "short",
    });

    expect(message).not.toContain("img-1");
  });

  it("includes the style when given and omits the section when not", () => {
    const withStyle = buildComposeUserMessage({
      topic: "选题",
      assets: [],
      length: "short",
      style: "冷静克制",
    });
    const withoutStyle = buildComposeUserMessage({
      topic: "选题",
      assets: [],
      length: "short",
    });

    expect(withStyle).toContain("冷静克制");
    expect(withoutStyle).not.toContain("风格");
  });
});

describe("parseComposedArticle", () => {
  it("parses front-matter and body", () => {
    const article = parseComposedArticle(
      ["---", "title: 本地优先软件", "summary: 一句话摘要", "tags: 软件, 架构", "---", "", "正文第一段。"].join("\n"),
    );

    expect(article.title).toBe("本地优先软件");
    expect(article.summary).toBe("一句话摘要");
    expect(article.tags).toEqual(["软件", "架构"]);
    expect(article.content).toBe("正文第一段。");
  });

  it("splits tags on ASCII commas, full-width commas and ideographic commas", () => {
    const article = parseComposedArticle(
      ["---", "title: T", "tags: a, b，c、d", "---", "", "正文"].join("\n"),
    );

    expect(article.tags).toEqual(["a", "b", "c", "d"]);
  });

  it("drops a bracketed tag list rather than keeping the brackets", () => {
    const article = parseComposedArticle(
      ["---", "title: T", "tags: [a, b]", "---", "", "正文"].join("\n"),
    );

    expect(article.tags).toEqual(["a", "b"]);
  });

  it("ignores unknown front-matter keys", () => {
    const article = parseComposedArticle(
      ["---", "title: T", "author: 模型", "---", "", "正文"].join("\n"),
    );

    expect(article.title).toBe("T");
    expect(article.content).toBe("正文");
  });

  it("falls back to the first h1 when there is no front-matter", () => {
    const article = parseComposedArticle("# 标题在这里\n\n正文第一段。");

    expect(article.title).toBe("标题在这里");
    expect(article.content).toBe("正文第一段。");
    expect(article.summary).toBe("");
    expect(article.tags).toEqual([]);
  });

  it("leaves the title empty when neither front-matter nor an h1 exists", () => {
    const article = parseComposedArticle("就是一段没有标题的正文。");

    expect(article.title).toBe("");
    expect(article.content).toBe("就是一段没有标题的正文。");
  });

  it("strips a fenced code wrapper the model may have added", () => {
    const article = parseComposedArticle(
      ["```markdown", "---", "title: T", "---", "", "正文", "```"].join("\n"),
    );

    expect(article.title).toBe("T");
    expect(article.content).toBe("正文");
  });

  it("tolerates quoted front-matter values", () => {
    const article = parseComposedArticle(
      ["---", 'title: "带引号的标题"', "---", "", "正文"].join("\n"),
    );

    expect(article.title).toBe("带引号的标题");
  });
});

describe("checkComposeGate", () => {
  const body = "正".repeat(200);

  it("passes a well-formed article", () => {
    expect(checkComposeGate({ title: "T", summary: "", tags: [], content: body })).toEqual({ ok: true });
  });

  it("rejects an empty title", () => {
    const result = checkComposeGate({ title: "  ", summary: "", tags: [], content: body });
    expect(result.ok).toBe(false);
  });

  it("rejects a body shorter than 100 characters", () => {
    const result = checkComposeGate({ title: "T", summary: "", tags: [], content: "太短了" });
    expect(result.ok).toBe(false);
  });

  it("measures the body with placeholders removed", () => {
    const padded = `${"[[media:1]]".repeat(20)}短`;
    const result = checkComposeGate({ title: "T", summary: "", tags: [], content: padded });
    expect(result.ok).toBe(false);
  });

  it("gives a reason that can be stored in ai_compose_error", () => {
    const result = checkComposeGate({ title: "", summary: "", tags: [], content: body });
    if (result.ok) throw new Error("expected the gate to reject");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("renderMediaPlaceholders", () => {
  it("renders an image placeholder as a markdown image using its note as alt text", () => {
    const out = renderMediaPlaceholders("前文\n\n[[media:1]]\n\n后文", [imageAsset]);

    expect(out).toContain("![架构示意图](/api/media/img-1/playback)");
  });

  it("renders a video placeholder as the editor's media markup", () => {
    const out = renderMediaPlaceholders("[[media:1]]", [videoAsset]);

    expect(out).toContain('<video data-rin-media-id="vid-1"');
    expect(out).toContain('data-rin-media-provider="stream"');
    expect(out).toContain('title="演示录屏"');
    expect(out).toContain("</video>");
  });

  it("omits the provider attribute for r2 assets", () => {
    const r2Video: ComposeAsset = { ...videoAsset, provider: "r2" };
    const out = renderMediaPlaceholders("[[media:1]]", [r2Video]);

    expect(out).not.toContain("data-rin-media-provider");
  });

  it("strips unknown placeholder numbers instead of leaving them in the body", () => {
    const out = renderMediaPlaceholders("前文 [[media:9]] 后文", [imageAsset]);

    expect(out).not.toContain("[[media:9]]");
    expect(out).toContain("前文");
    expect(out).toContain("后文");
  });

  it("appends assets the model never referenced", () => {
    const out = renderMediaPlaceholders("只引用了第一个 [[media:1]]", [imageAsset, videoAsset]);

    expect(out).toContain("img-1");
    expect(out).toContain("vid-1");
  });

  it("renders a repeated placeholder at every occurrence", () => {
    const out = renderMediaPlaceholders("[[media:1]] 中间 [[media:1]]", [imageAsset]);

    expect(out.match(/img-1/g)?.length).toBe(2);
  });

  it("does not append anything when every asset was used", () => {
    const out = renderMediaPlaceholders("[[media:1]][[media:2]]", [imageAsset, videoAsset]);

    expect(out.match(/img-1/g)?.length).toBe(1);
    expect(out.match(/vid-1/g)?.length).toBe(1);
  });

  it("sanitizes quotes and angle brackets in a note used as an attribute", () => {
    const nasty: ComposeAsset = { ...videoAsset, note: 'a"b<c>d' };
    const out = renderMediaPlaceholders("[[media:1]]", [nasty]);

    expect(out).not.toContain('a"b');
    expect(out).toContain('title="abcd"');
  });

  it("sanitizes brackets in a note used as image alt text", () => {
    const nasty: ComposeAsset = { ...imageAsset, note: "a[b]c" };
    const out = renderMediaPlaceholders("[[media:1]]", [nasty]);

    expect(out).toContain("![abc](/api/media/img-1/playback)");
  });

  it("returns the body unchanged when there are no assets", () => {
    expect(renderMediaPlaceholders("纯文本正文", [])).toBe("纯文本正文");
  });
});

describe("composeMaxTokensFloor", () => {
  it("scales with the requested length", () => {
    expect(composeMaxTokensFloor("short")).toBeLessThan(composeMaxTokensFloor("long"));
  });

  it("leaves room for the longest requested article", () => {
    expect(composeMaxTokensFloor("long")).toBeGreaterThanOrEqual(8000);
  });
});
