// When the app comes back to the screen: sync, or not. A full snapshot on
// every return (F12) is wasted when one just finished; a sync that has been
// running for over a minute (the screen went off mid-upload and Android
// froze the request, B3) is stuck: it's cancelled and a fresh one starts.

/** A sync that finished less than this ago isn't run again on return. */
export const RECENT_SYNC_MS = 30_000;
/** A sync still running after this long, seen on return, is restarted. */
export const STUCK_SYNC_MS = 60_000;

export type SyncClock = { paired: boolean; syncing: boolean; startedAt: number | null; finishedAt: number | null };

export function onForeground(s: SyncClock, now: number): "skip" | "sync" | "restart" {
  if (!s.paired) return "skip";
  if (s.syncing) return s.startedAt !== null && now - s.startedAt > STUCK_SYNC_MS ? "restart" : "skip";
  if (s.finishedAt !== null && now - s.finishedAt < RECENT_SYNC_MS) return "skip";
  return "sync";
}
