// Shares that reached the app but weren't sent or left yet (on screen, or
// waiting their turn), remembered so a kill doesn't lose them
// (modules/hivo-share/index.ts). Pure.

export type PendingShare<S> = { dir: string; at: number; share: S };

/** At most this many are remembered (each holds copies in the cache). */
export const MAX_PENDING_SHARES = 10;
/** A share left unanswered this long is let go (its copies are swept). */
export const PENDING_SHARE_MS = 7 * 24 * 60 * 60 * 1000;

export function addPending<S>(list: PendingShare<S>[], dir: string, share: S, now: number): PendingShare<S>[] {
  const rest = list.filter((p) => p.dir !== dir && now - p.at < PENDING_SHARE_MS);
  return [...rest, { dir, at: now, share }].slice(-MAX_PENDING_SHARES);
}

export const removePending = <S>(list: PendingShare<S>[], dir: string): PendingShare<S>[] => list.filter((p) => p.dir !== dir);

export const pendingDirs = <S>(list: PendingShare<S>[]): string[] => list.map((p) => p.dir);

/**
 * The oldest remembered share not shown yet in this run, with only the files
 * still there (`exists`); null when none. A share whose files are all gone
 * and that had no text is skipped (nothing left to show).
 */
export function restorable<S extends { files: { uri: string }[]; text: string | null }>(list: PendingShare<S>[], shown: Set<string>, exists: (uri: string) => boolean): { dir: string; share: S } | null {
  for (const p of [...list].sort((a, b) => a.at - b.at)) {
    if (shown.has(p.dir)) continue;
    const files = p.share.files.filter((f) => exists(f.uri));
    if (files.length === 0 && !p.share.text?.trim()) continue;
    return { dir: p.dir, share: { ...p.share, files } };
  }
  return null;
}
