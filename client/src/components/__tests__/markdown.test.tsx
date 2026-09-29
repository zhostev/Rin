import "../../test/setup";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "bun:test";
import { Markdown } from "../markdown";

afterEach(cleanup);

describe("Markdown images", () => {
  it("renders a mid-paragraph image as a standalone block, not inline", () => {
    // 还原用户反馈的场景：图片写在段落行内（前后无换行）。
    // 以前会按行内元素渲染（inline-block align-middle），把段落撑乱、
    // 文字被顶到图片两侧；现在一律独占一块。
    const { container } = render(
      <Markdown content={"像谁随手插在那儿的一笔留白。![鸭川](https://example.com/a.jpg)岸边的人三三两两地坐着。"} />,
    );
    const img = container.querySelector("img");
    expect(img).toBeDefined();
    const wrapper = img!.closest("p > span");
    expect(wrapper).toBeDefined();
    expect(wrapper!.className).toContain("block w-full");
    expect(wrapper!.className).not.toContain("align-middle");
  });

  it("keeps an image on its own line as a block", () => {
    const { container } = render(
      <Markdown content={"前面一段。\n\n![鸭川](https://example.com/a.jpg)\n\n后面一段。"} />,
    );
    const img = container.querySelector("img");
    expect(img).toBeDefined();
    const wrapper = img!.closest("p > span");
    expect(wrapper).toBeDefined();
    expect(wrapper!.className).toContain("block w-full");
  });
});
