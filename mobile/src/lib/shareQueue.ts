// Shares waiting for the share screen: one arriving while recording, or
// while another share is on screen, waits its turn instead of replacing it.

/** `dir`: the share's own cache folder (Android), its identity. */
export type Queued = { dir?: string | null };

/** Adds a share at the end, never the same one twice (a share delivered by
 * both the new-intent event and takeShared). */
export function enqueue<S extends Queued>(queue: S[], share: S): S[] {
  if (share.dir && queue.some((q) => q.dir === share.dir)) return queue;
  return [...queue, share];
}

/** The next share to show, and the rest. */
export function dequeue<S>(queue: S[]): { next: S | null; rest: S[] } {
  return queue.length === 0 ? { next: null, rest: queue } : { next: queue[0], rest: queue.slice(1) };
}

/** Shares waiting to go before pairing, for the pair screen's "waiting" line. */
export function waitingCount(outbox: { state: string }[], ideas: { deleted: boolean; sentAt: number | null; updatedAt: number; title: string; text: string }[]): number {
  return (
    outbox.filter((o) => o.state === "waiting" || o.state === "sending").length +
    ideas.filter((i) => !i.deleted && (i.sentAt === null || i.updatedAt > i.sentAt) && (i.title.trim() || i.text.trim())).length
  );
}
