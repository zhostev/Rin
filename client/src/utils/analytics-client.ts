// Shared analytics tracker wired to POST /api/events (Stage 3).
//
// Session dedupe works across pages: a video_play fired from the media
// center won't refire from the story page for the same asset. Failures are
// silent and never affect the experience.

import { client } from "../app/runtime";
import { createEventTracker, type EventTracker } from "./analytics";

let sharedTracker: EventTracker | null = null;

/** Process-wide tracker for page components. */
export function getSharedEventTracker(): EventTracker {
  if (!sharedTracker) {
    sharedTracker = createEventTracker((body) => {
      void client.mediaCenter.trackEvent(body);
    });
  }
  return sharedTracker;
}
