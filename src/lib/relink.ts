import type { ProjectInfo, Workspace } from "../types";

// Everything the app knows about a song (stage, tags, notes, credits, crew
// share, album slot) is keyed by its .flp path. Rename the file or move its
// folder in Finder/Explorer and that would all be orphaned. After a scan we
// carry it over when the match is unambiguous:
// - moved: the same file name turns up somewhere else in the linked folders;
// - renamed: the folder lost one song and gained one new .flp.
// Only records whose file vanished from a folder that's still linked are
// considered (an unlinked folder or unplugged drive isn't a move: the scan
// reports the linked folders it couldn't reach, and nothing under them is an
// orphan), and only onto new files with no record of their own. Anything
// ambiguous is left alone.
//
// A file can also drop out of one scan without going anywhere (FL Studio
// rewriting it during the focus rescan, a sync client swapping it): its
// record must not jump to an older file next to it ("Envy" → "Envy old").
// So, after a scan (`relinksAfterScan`), a record moves only once its file
// was missing from two scans in a row, and only onto a file that wasn't
// there the last time its own file was seen.

export interface Relink {
  from: string;
  to: string;
  reason: "moved" | "renamed";
}

/** What the store remembers between scans (never saved). */
export interface ScanMemory {
  /** Every path the previous scan listed; null before the first scan. */
  previous: Set<string> | null;
  /** Records whose file was missing from the previous scan, with the paths
   * listed the last time it was seen (null: unknown, e.g. it was already
   * missing at the first scan of this session). */
  missing: Map<string, Set<string> | null>;
}

export const emptyScanMemory = (): ScanMemory => ({ previous: null, missing: new Map() });

/** NFC and lowercased, `/` separators: a macOS path can be decomposed
 * ("E" + accent) where the workspace has it composed. */
const norm = (p: string) => p.normalize("NFC").replace(/\\/g, "/").toLowerCase();
/** The file name; for a BandLab sketch (keyed by its `<song>/BandLab`
 * folder) the song folder too, or every sketch would share one name. */
const base = (p: string) => {
  const parts = norm(p).split("/");
  const last = parts.pop() ?? "";
  return last === "bandlab" ? `${parts.pop() ?? ""}/${last}` : last;
};
const parent = (p: string) => norm(p).split("/").slice(0, -1).join("/");

function underWatched(path: string, watched: string[]): boolean {
  const p = norm(path);
  return watched.some((w) => {
    const root = norm(w).replace(/\/+$/, "");
    return p.startsWith(`${root}/`);
  });
}

/** Records whose file isn't in this scan, under a linked folder that was
 * reachable (an unreachable one's songs are missing, not moved). */
function orphansOf(projects: ProjectInfo[], ws: Workspace, watched: string[], unreachable: string[]): string[] {
  const present = new Set(projects.map((p) => p.path));
  return Object.entries(ws.songs)
    .filter(
      ([path, meta]) =>
        !present.has(path) && Object.keys(meta).length > 0 && underWatched(path, watched) && !underWatched(path, unreachable),
    )
    .map(([path]) => path);
}

/** One scan's relinks, with nothing remembered (see `relinksAfterScan` for
 * the two-scan rule the store uses). `unreachable`: linked folders the scan
 * couldn't read right now (unplugged drive, unmounted share). Songs under
 * them are missing, not moved. `allowed(from, to)` can veto a pairing. */
export function findRelinks(
  projects: ProjectInfo[],
  ws: Workspace,
  watched: string[],
  unreachable: string[] = [],
  only?: { orphans: string[]; allowed: (from: string, to: string) => boolean },
): Relink[] {
  const orphans = only?.orphans ?? orphansOf(projects, ws, watched, unreachable);
  const allowed = only?.allowed ?? (() => true);
  const fresh = projects.filter((p) => !p.isTemplate && !ws.songs[p.path]).map((p) => p.path);
  if (!orphans.length || !fresh.length) return [];

  const out: Relink[] = [];
  const used = new Set<string>();
  const count = <T>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return m;
  };

  // Orphans are counted all together, not only the ones due: a name or a
  // folder another missing record shares stays ambiguous. New files are
  // counted among the ones `allowed` for that orphan.
  const allOrphans = only ? orphansOf(projects, ws, watched, unreachable) : orphans;

  // Moved: a file name that's unique among both the orphans and the new files.
  const orphanNames = count(allOrphans, base);
  for (const from of orphans) {
    const name = base(from);
    const to = fresh.filter((f) => base(f) === name && !used.has(f) && allowed(from, f));
    if (orphanNames.get(name) !== 1 || to.length !== 1) continue;
    out.push({ from, to: to[0], reason: "moved" });
    used.add(from).add(to[0]);
  }

  // Renamed in place: one orphan and one new file left in the same folder.
  const orphanDirs = count(allOrphans.filter((p) => !used.has(p)), parent);
  const leftFresh = fresh.filter((p) => !used.has(p));
  for (const from of orphans.filter((p) => !used.has(p))) {
    const dir = parent(from);
    const to = leftFresh.filter((f) => parent(f) === dir && allowed(from, f));
    if (orphanDirs.get(dir) !== 1 || to.length !== 1) continue;
    out.push({ from, to: to[0], reason: "renamed" });
  }
  return out;
}

/** The relinks after one scan, and what to remember for the next one. A
 * record's file must be missing from two scans in a row, and it only moves
 * onto a file that wasn't listed the last time its own file was seen: a
 * file that was there all along ("Envy old.flp" next to "Envy.flp") is
 * never a rename of it. Without that knowledge (missing since before the
 * first scan of the session), any file without a record of its own counts,
 * as `findRelinks` alone does. */
export function relinksAfterScan(
  projects: ProjectInfo[],
  ws: Workspace,
  watched: string[],
  unreachable: string[],
  memory: ScanMemory,
): { relinks: Relink[]; memory: ScanMemory } {
  const present = new Set(projects.map((p) => p.path));
  const orphans = orphansOf(projects, ws, watched, unreachable);
  const missing = new Map<string, Set<string> | null>();
  const due: string[] = [];
  for (const path of orphans) {
    if (memory.missing.has(path)) {
      // Missing twice in a row (or more): it may move now.
      missing.set(path, memory.missing.get(path) ?? null);
      due.push(path);
    } else {
      // Missing for the first time: wait for the next scan. What was
      // listed when it was last seen is the previous scan, if it was in it.
      missing.set(path, memory.previous?.has(path) ? memory.previous : null);
    }
  }
  const relinks = due.length
    ? findRelinks(projects, ws, watched, unreachable, {
        orphans: due,
        allowed: (from, to) => !missing.get(from)?.has(to),
      })
    : [];
  for (const r of relinks) missing.delete(r.from);
  return { relinks, memory: { previous: present, missing } };
}

/** The folder part of a path as written (separators and case kept). */
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

/** The Launch Kit's picked master (an absolute path, usually next to the
 * project or in a folder under it) follows the song's folder when that
 * folder moved. A master elsewhere (an export folder) stays as it is. */
function moveMaster(meta: Workspace["songs"][string], from: string, to: string): Workspace["songs"][string] {
  const master = meta?.launchKit?.master;
  if (!master) return meta;
  const [oldDir, newDir] = [dirOf(from), dirOf(to)];
  if (norm(oldDir) === norm(newDir) || !isUnder(master, oldDir)) return meta;
  return { ...meta, launchKit: { ...meta.launchKit, master: newDir + master.slice(oldDir.length) } };
}

/** The workspace with each record (album slot, hand-sorted board position,
 * picked Launch Kit master) moved to its new path. */
export function applyRelinks(ws: Workspace, relinks: Relink[]): Workspace {
  if (!relinks.length) return ws;
  const map = new Map(relinks.map((r) => [r.from, r.to]));
  const songs = { ...ws.songs };
  for (const { from, to } of relinks) {
    if (!(from in songs)) continue;
    songs[to] = moveMaster(songs[from], from, to);
    delete songs[from];
  }
  const moved = (paths: string[]) => paths.some((p) => map.has(p));
  const pipeline = ws.pipeline && Object.values(ws.pipeline.order).some(moved)
    ? {
        ...ws.pipeline,
        order: Object.fromEntries(Object.entries(ws.pipeline.order).map(([col, paths]) => [col, moved(paths) ? paths.map((p) => map.get(p) ?? p) : paths])),
      }
    : ws.pipeline;
  return {
    ...ws,
    songs,
    albums: ws.albums.map((a) => (moved(a.trackPaths) ? { ...a, trackPaths: a.trackPaths.map((p) => map.get(p) ?? p) } : a)),
    ...(pipeline ? { pipeline } : {}),
  };
}

/** A network or device path (`\\nas\share`, `//nas/share`, `\\?\UNC\…`):
 * the same test as `paths::is_remote_or_device` in Rust, which never opens
 * one, so a folder linked that way is always unreachable. */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path.trimStart());
}

/** Whether `path` sits under `root` (any separators, any case). */
export function isUnder(path: string, root: string): boolean {
  return underWatched(path, [root]);
}

/** A linked folder moved (drive letter changed, remounted elsewhere): every
 * record under `from` goes to the same place under `to` (apply them with
 * `applyRelinks`, album slots follow). A record already at the new path is
 * kept as it is. */
export function rootRelinks(ws: Workspace, from: string, to: string): Relink[] {
  const fromLen = from.replace(/[\\/]+$/, "").length;
  const toRoot = to.replace(/[\\/]+$/, "");
  return Object.keys(ws.songs)
    .filter((p) => isUnder(p, from))
    .map((p) => ({ from: p, to: toRoot + p.slice(fromLen), reason: "moved" as const }))
    .filter((r) => r.from !== r.to && !ws.songs[r.to]);
}
