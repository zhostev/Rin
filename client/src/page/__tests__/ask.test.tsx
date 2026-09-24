import "../../test/setup";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AskResponse } from "../../api/ai-studio";

let askResponse: AskResponse | null = null;
let askError: { value: string } | null = null;

mock.module("../../app/runtime", () => ({
  client: {
    ask: {
      ask: async () => (askError ? { error: askError } : { data: askResponse }),
      recommend: async () => ({ data: { items: [] } }),
    },
  },
}));

mock.module("../../components/markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="ask-markdown">{content}</div>,
}));

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

mock.module("react-helmet", () => ({
  Helmet: () => null,
}));

mock.module("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useSearch: () => "",
}));

const { AskPage } = await import("../ask");

async function askAQuestion(question: string) {
  const user = userEvent.setup();
  const queries = render(<AskPage />);
  await user.type(queries.getByPlaceholderText("ask.placeholder"), question);
  await user.click(queries.getByText("ask.submit"));
  return queries;
}

describe("AskPage", () => {
  afterEach(() => {
    cleanup();
    askResponse = null;
    askError = null;
  });

  it("renders the question box with quick/full mode toggle", () => {
    const { getByPlaceholderText, getByText } = render(<AskPage />);
    expect(getByPlaceholderText("ask.placeholder")).toBeDefined();
    expect(getByText("ask.mode_quick")).toBeDefined();
    expect(getByText("ask.mode_full")).toBeDefined();
    expect(getByText("ask.submit")).toBeDefined();
  });

  it("renders the answer with clickable citations and verified date", async () => {
    askResponse = {
      answer: "测试回答正文",
      citations: [
        {
          storySlug: "demo",
          title: "演示内容包",
          blockId: "b1",
          text: "引用片段",
          url: "/story/demo",
        },
      ],
      coverage: "full",
      verifiedAt: "2026-09-24",
    };

    const { getByText, findByTestId } = await askAQuestion("站内有什么？");

    expect((await findByTestId("ask-markdown")).textContent).toBe("测试回答正文");
    expect(getByText("演示内容包")).toBeDefined();
    expect(getByText("ask.verified_at")).toBeDefined();
  });

  it("shows the not-covered state for coverage 'none' without fabricating an answer", async () => {
    askResponse = { answer: "", citations: [], coverage: "none" };

    const { getByText, findByText, queryByTestId } = await askAQuestion("不存在的内容？");

    expect(await findByText("ask.coverage_none_title")).toBeDefined();
    expect(getByText("ask.coverage_none_desc")).toBeDefined();
    expect(queryByTestId("ask-markdown")).toBeNull();
  });

  it("falls back to clearly-labeled demo data when the backend is unreachable", async () => {
    askError = { value: "Network error" };

    const { getByText, findByTestId } = await askAQuestion("随便问问");

    await findByTestId("ask-markdown");
    expect(getByText("ai_studio.demo_badge")).toBeDefined();
  });
});
