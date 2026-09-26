import "../../test/setup";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { AdminLayout } from "../admin-layout";

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(cleanup);

// jsdom in test/setup exposes window.location but not the bare `location`
// / `history` globals that wouter's default location hook reads.
const g = globalThis as Record<string, unknown>;
if (typeof g.location === "undefined")
  g.location = (g.window as Window).location;
if (typeof g.history === "undefined") g.history = (g.window as Window).history;

function renderLayout() {
  return render(
    <AdminLayout title="AI Studio" description="desc">
      <p>page content</p>
    </AdminLayout>,
  );
}

describe("AdminLayout mobile drawer", () => {
  it("opens the drawer from the menu button and closes it with Escape", () => {
    const { getByRole, getByText, queryByRole } = renderLayout();

    // Drawer is closed initially; page content is visible right away.
    expect(queryByRole("dialog")).toBeNull();
    expect(getByText("page content")).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "admin.menu" }));
    const dialog = getByRole("dialog");
    // Navigation links are reachable inside the drawer.
    // (within: the desktop sidebar renders the same links, hidden by CSS.)
    expect(
      within(dialog).getByRole("link", { name: "story.nav.ai_studio" }),
    ).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();
  });

  it("closes the drawer when the overlay is clicked", () => {
    const { getByRole, getByTestId, queryByRole } = renderLayout();

    fireEvent.click(getByRole("button", { name: "admin.menu" }));
    expect(getByRole("dialog")).not.toBeNull();

    fireEvent.click(getByTestId("drawer-overlay"));
    expect(queryByRole("dialog")).toBeNull();
  });

  it("closes the drawer after tapping a navigation link", () => {
    const { getByRole, queryByRole } = renderLayout();

    fireEvent.click(getByRole("button", { name: "admin.menu" }));
    const dialog = getByRole("dialog");

    fireEvent.click(
      within(dialog).getByRole("link", { name: "story.nav.ai_studio" }),
    );
    expect(queryByRole("dialog")).toBeNull();
  });
});
