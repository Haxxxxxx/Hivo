// When the app comes back to the screen: sync, or not. A full snapshot on
// every return (F12) is wasted when one just finished; a sync that hasn't
// moved for over a minute (the screen went off mid-upload and Android froze
// the request, B3) is stuck: it's cancelled and a fresh one starts. "Moved"
// is the last progress (a chunk sent, a note synced), not the start: a long
// upload that keeps sending is never cut on a return (review #10).

/** A sync that finished less than this ago isn't run again on return. */
export const RECENT_SYNC_MS = 30_000;
/** A sync with no progress for this long, seen on return, is restarted. */
export const STUCK_SYNC_MS = 60_000;

/** `progressAt`: when the running sync started or last moved forward. */
export type SyncClock = { paired: boolean; syncing: boolean; progressAt: number | null; finishedAt: number | null };

export function onForeground(s: SyncClock, now: number): "skip" | "sync" | "restart" {
  if (!s.paired) return "skip";
  if (s.syncing) return s.progressAt !== null && now - s.progressAt > STUCK_SYNC_MS ? "restart" : "skip";
  if (s.finishedAt !== null && now - s.finishedAt < RECENT_SYNC_MS) return "skip";
  return "sync";
}
