// Aggregated analytics event tracker (Stage 3).
//
// POST /api/events with { type, assetId?, storyId? } — aggregated counts,
// no PII. Delivery rules:
//   - session dedupe: the same (type, assetId, storyId) fires at most once
//     per page session, so milestone listeners (play / 50%-read) can't double count;
//   - fire-and-forget: failures are silent and never affect the experience;
//   - the send function itself is injected, so the tracker stays unit-testable.

import type { AnalyticsEventBody, AnalyticsEventType } from "../api/media-center";

export type { AnalyticsEventBody, AnalyticsEventType };

export interface EventTracker {
  track(event: AnalyticsEventBody): void;
  /** test hook: which events were accepted (dedupe applied) */
  acceptedCount(): number;
}

function dedupeKey(event: AnalyticsEventBody): string {
  return `${event.type}:${event.assetId ?? ""}:${event.storyId ?? ""}`;
}

/**
 * Create a tracker around a send function (normally
 * (body) => client.mediaCenter.trackEvent(body)).
 * send may throw or reject — it is always swallowed.
 */
export function createEventTracker(
  send: (body: AnalyticsEventBody) => Promise<unknown> | void,
): EventTracker {
  const seen = new Set<string>();
  let accepted = 0;
  return {
    track(event: AnalyticsEventBody): void {
      const key = dedupeKey(event);
      if (seen.has(key)) return;
      seen.add(key);
      accepted += 1;
      try {
        const result = send(event);
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch(() => {
            // silent: analytics must never affect the experience
          });
        }
      } catch {
        // silent
      }
    },
    acceptedCount(): number {
      return accepted;
    },
  };
}
