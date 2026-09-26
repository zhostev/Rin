import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { ImageWithFallback } from "./image-with-fallback";

function AdminNavItem({
  href,
  icon,
  label,
  onNavigate,
}: {
  href: string;
  icon: string;
  label: string;
  onNavigate?: () => void;
}) {
  const [location] = useLocation();
  const active = location === href || location.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors ${
        active
          ? "bg-theme text-white"
          : "t-primary hover:bg-neutral-100 dark:hover:bg-white/5"
      }`}
    >
      <i className={`${icon} text-base`} />
      <span>{label}</span>
    </Link>
  );
}

function AdminSidebarCard({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();

  return (
    <div className="rounded-2xl border border-black/10 bg-w p-5 dark:border-white/10">
      <Link
        href="/"
        onClick={onNavigate}
        className="flex items-center gap-4 rounded-xl px-2 py-2 transition-colors hover:bg-neutral-50 dark:hover:bg-white/5"
      >
        {siteConfig.avatar ? (
          <ImageWithFallback
            src={siteConfig.avatar}
            alt={siteConfig.name}
            className="h-12 w-12 rounded-2xl border border-black/10 dark:border-white/10"
          />
        ) : null}
        <div className="min-w-0">
          <p className="truncate text-base font-semibold t-primary">
            {siteConfig.name}
          </p>
          <p className="truncate text-sm text-neutral-500 dark:text-neutral-400">
            {t("admin.back_to_site")}
          </p>
        </div>
      </Link>

      <div className="mt-6">
        <p className="px-2 text-xs font-semibold uppercase tracking-[0.18em] text-neutral-400 dark:text-neutral-500">
          {t("admin.title")}
        </p>
        <nav className="mt-3 flex flex-col gap-2">
          <AdminNavItem
            href="/admin/writing"
            icon="ri-quill-pen-line"
            label={t("writing")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/stories"
            icon="ri-book-open-line"
            label={t("story.nav.stories")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/media"
            icon="ri-image-2-line"
            label={t("story.nav.media")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/series"
            icon="ri-stack-line"
            label={t("story.nav.series")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/ai-studio"
            icon="ri-sparkling-2-line"
            label={t("story.nav.ai_studio")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/maintenance"
            icon="ri-tools-line"
            label={t("story.nav.maintenance")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/settings"
            icon="ri-settings-3-line"
            label={t("settings.title")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/health"
            icon="ri-heart-pulse-line"
            label={t("health.title")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/queue-status"
            icon="ri-todo-line"
            label={t("queue_status.title")}
            onNavigate={onNavigate}
          />
          <AdminNavItem
            href="/admin/compat-tasks"
            icon="ri-history-line"
            label={t("compat_tasks.title")}
            onNavigate={onNavigate}
          />
        </nav>
      </div>
    </div>
  );
}

export function AdminLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [location] = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = () => setDrawerOpen(false);

  // Close the drawer whenever the route changes (e.g. programmatic navigation).
  useEffect(() => {
    closeDrawer();
  }, [location]);

  // Escape closes the drawer. No body scroll lock: locking body overflow
  // breaks position:fixed on iOS Safari.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      {/* Mobile top bar: sidebar becomes a drawer below lg */}
      <div className="sticky top-0 z-40 border-b border-black/5 bg-neutral-50/90 backdrop-blur dark:border-white/5 dark:bg-neutral-950/90 lg:hidden">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("admin.menu")}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-black/10 t-primary transition-colors hover:bg-neutral-100 dark:border-white/10 dark:hover:bg-white/5"
          >
            <i className="ri-menu-line text-lg" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold t-primary">{title}</p>
            <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
              {t("admin.title")}
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row lg:px-6">
        <aside className="hidden w-72 shrink-0 lg:sticky lg:top-6 lg:block lg:self-start">
          <AdminSidebarCard />
        </aside>

        <main className="min-w-0 flex-1">
          <div className="rounded-2xl border border-black/10 bg-w p-6 dark:border-white/10">
            <div className="border-b border-black/5 pb-5 dark:border-white/5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-theme/70">
                {t("admin.title")}
              </p>
              <h1 className="mt-2 break-words text-3xl font-semibold tracking-[-0.03em] t-primary [overflow-wrap:anywhere]">
                {title}
              </h1>
              <p className="mt-2 max-w-2xl break-words text-sm leading-6 text-neutral-500 dark:text-neutral-400 [overflow-wrap:anywhere]">
                {description}
              </p>
            </div>
            <div className="mt-6">{children}</div>
          </div>
        </main>
      </div>

      {/* Mobile navigation drawer */}
      {drawerOpen ? (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t("admin.title")}
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={closeDrawer}
            data-testid="drawer-overlay"
          />
          <div className="absolute inset-y-0 left-0 w-80 max-w-[85vw] overflow-y-auto bg-neutral-50 p-4 dark:bg-neutral-950">
            <AdminSidebarCard onNavigate={closeDrawer} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
