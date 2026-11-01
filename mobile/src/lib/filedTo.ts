// Where the computer filed an idea, a memo or an export (`filedTo` from
// /v1/ideas and /v1/inbox). Ideas and memos linked to an item carry
// `<kind>:<id>` (src/lib/phoneInbox.ts `targetKey` on the desktop); a
// BandLab export filed as a sketch carries the new song's key, a path
// ending in `/BandLab`.
import type { Item, Kind } from "./sync";

export function parseFiledTo(filedTo: string | null): { kind: Kind; id: string } | { path: string } | null {
  if (!filedTo) return null;
  const m = /^(prod|beat|song):(.+)$/s.exec(filedTo);
  return m ? { kind: m[1] as Kind, id: m[2] } : { path: filedTo };
}

/** The name to show for where it was filed, or null when there's nothing to say. */
export function filedTitle(filedTo: string | null, find: (kind: Kind, id: string) => Item | undefined): string | null {
  const p = parseFiledTo(filedTo);
  if (!p) return null;
  const last = (s: string) => s.split(/[\\/]/).filter(Boolean).pop() ?? null;
  if ("kind" in p) return find(p.kind, p.id)?.title ?? last(p.id);
  const song = find("song", p.path);
  if (song) return song.title;
  // "<folder>/<name>/BandLab": the song is <name>.
  const parts = p.path.split(/[\\/]/).filter(Boolean);
  if (parts.length >= 2 && parts[parts.length - 1].toLowerCase() === "bandlab") return parts[parts.length - 2];
  return last(p.path);
}
