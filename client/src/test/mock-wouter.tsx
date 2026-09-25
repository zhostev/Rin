import { mock } from "bun:test";
import type { ReactNode } from "react";

/**
 * Install a COMPLETE mock for the "wouter" module.
 *
 * This must provide every named export of wouter (Link, Redirect, Route,
 * Router, Switch, matchRoute, useLocation, useParams, useRoute, useRouter,
 * useSearch) — not just the ones the current test file needs.
 *
 * Why: Bun's mock.module() is not reliably scoped to a single test file;
 * a partial mock registered by one file can leak into other test files that
 * run afterwards. If the leaked mock is missing an export that another
 * file's import graph needs, the test run fails with:
 *   SyntaxError: Export named '<name>' not found in module
 *   'node_modules/wouter/esm/index.js'
 * Providing the full export surface makes leaks harmless.
 */
export function mockWouter(overrides: Record<string, unknown> = {}) {
  mock.module("wouter", () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
      <a href={href} {...rest}>
        {children}
      </a>
    ),
    Redirect: () => null,
    Route: ({ children }: { children: ReactNode }) => <>{children}</>,
    Router: ({ children }: { children: ReactNode }) => <>{children}</>,
    Switch: ({ children }: { children: ReactNode }) => <>{children}</>,
    matchRoute: () => [true, {}] as const,
    useLocation: (): [string, (to: string) => void] => ["/", mock()],
    useParams: () => ({}),
    useRoute: () => [true, {}] as const,
    useRouter: () => ({ base: "" }),
    useSearch: () => "",
    ...overrides,
  }));
}
