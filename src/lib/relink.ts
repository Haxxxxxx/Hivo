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

export interface Relink {
  from: string;
  to: string;
  reason: "moved" | "renamed";
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
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

/** `unreachable`: linked folders the scan couldn't read right now (unplugged
 * drive, unmounted share). Songs under them are missing, not moved. */
export function findRelinks(projects: ProjectInfo[], ws: Workspace, watched: string[], unreachable: string[] = []): Relink[] {
  const present = new Set(projects.map((p) => p.path));
  const orphans = Object.entries(ws.songs)
    .filter(
      ([path, meta]) =>
        !present.has(path) && Object.keys(meta).length > 0 && underWatched(path, watched) && !underWatched(path, unreachable),
    )
    .map(([path]) => path);
  const fresh = projects.filter((p) => !p.isTemplate && !ws.songs[p.path]).map((p) => p.path);
  if (!orphans.length || !fresh.length) return [];

  const out: Relink[] = [];
  const used = new Set<string>();
  const count = <T>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return m;
  };

  // Moved: a file name that's unique among both the orphans and the new files.
  const orphanNames = count(orphans, base);
  const freshNames = count(fresh, base);
  for (const from of orphans) {
    const name = base(from);
    if (orphanNames.get(name) !== 1 || freshNames.get(name) !== 1) continue;
    const to = fresh.find((f) => base(f) === name)!;
    out.push({ from, to, reason: "moved" });
    used.add(from).add(to);
  }

  // Renamed in place: one orphan and one new file left in the same folder.
  const leftOrphans = orphans.filter((p) => !used.has(p));
  const leftFresh = fresh.filter((p) => !used.has(p));
  const orphanDirs = count(leftOrphans, parent);
  const freshDirs = count(leftFresh, parent);
  for (const from of leftOrphans) {
    const dir = parent(from);
    if (orphanDirs.get(dir) !== 1 || freshDirs.get(dir) !== 1) continue;
    const to = leftFresh.find((f) => parent(f) === dir)!;
    out.push({ from, to, reason: "renamed" });
  }
  return out;
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
