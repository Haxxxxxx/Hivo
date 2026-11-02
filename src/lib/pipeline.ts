import type { PipelineColumn, PipelineConfig, ProjectInfo, SongMeta, SongStatus, Workspace } from "../types";
import { STATUSES, UNSORTED, lastSaveMs, newId, stageNames } from "./songs";

// The pipeline: ONE model behind the board, the list and the table.
//
// Columns sit on the fixed lifecycle stages (the crew database only knows
// those five, and "finished", stalled, the calendar and crew sync all run on
// them). A column has a name and a stage; putting a song in a column sets
// that stage. Several columns can share a stage ("Recording" and "Mixing"
// both in Production); every stage keeps at least one column. Crewmates see
// the stage, never the column.
//
// Shared by every view (lives in the workspace): columns, their names and
// order, which column a song is in, hand-sorted card order. Per view (not
// here): table sort, collapsed columns.

export const STAGE_ORDER: (SongStatus | null)[] = [null, ...STATUSES.map((s) => s.id)];
export const NAME_MAX = 40;

export function stageLabel(stage: SongStatus | null): string {
  return STATUSES.find((s) => s.id === stage)?.label ?? UNSORTED.label;
}

export function stageColor(stage: SongStatus | null): string {
  return STATUSES.find((s) => s.id === stage)?.color ?? UNSORTED.color;
}

export function cleanName(name: unknown): string {
  return typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
}

/** One column per stage, named after it. */
export function defaultPipeline(): PipelineConfig {
  return { columns: STAGE_ORDER.map((stage) => ({ id: stage ?? "unsorted", name: stageLabel(stage), stage })), order: {} };
}

const stageIndex = (stage: SongStatus | null) => STAGE_ORDER.indexOf(stage);

/** The workspace's pipeline, repaired: bad or duplicate columns dropped,
 * names cleaned, and any stage left without a column gets its default one
 * back (in lifecycle position), so no song can ever fall off the board. */
export function resolvePipeline(ws: Pick<Workspace, "pipeline">): PipelineConfig {
  const stored = ws.pipeline;
  if (!stored || !Array.isArray(stored.columns)) return defaultPipeline();
  const seen = new Set<string>();
  const columns: PipelineColumn[] = [];
  for (const c of stored.columns) {
    const stage = c?.stage ?? null;
    if (!c || typeof c.id !== "string" || !c.id || seen.has(c.id) || stageIndex(stage) < 0) continue;
    seen.add(c.id);
    // A column still named after its stage (in any language) shows in the
    // current one: switching language mustn't leave "Creation" in French.
    const name = cleanName(c.name);
    const isDefault = stageNames(stage).some((n) => n.toLowerCase() === name.toLowerCase());
    columns.push({ id: c.id, name: name && !isDefault ? name : stageLabel(stage), stage });
  }
  for (const stage of STAGE_ORDER) {
    if (columns.some((c) => c.stage === stage)) continue;
    let id = stage ?? "unsorted";
    while (seen.has(id)) id = `${id}-${newId().slice(0, 4)}`;
    seen.add(id);
    const at = columns.findIndex((c) => stageIndex(c.stage) > stageIndex(stage));
    columns.splice(at < 0 ? columns.length : at, 0, { id, name: stageLabel(stage), stage });
  }
  const order: Record<string, string[]> = {};
  if (stored.order && typeof stored.order === "object") {
    for (const c of columns) {
      const list = stored.order[c.id];
      if (Array.isArray(list)) order[c.id] = list.filter((p): p is string => typeof p === "string");
    }
  }
  return { columns, order };
}

/** The column a song is in: its pinned column if that still matches its
 * stage (the stage may have changed elsewhere: the drawer, the library, a
 * crewmate), else the first column of its stage. */
export function columnOf(meta: SongMeta | undefined, cfg: PipelineConfig): PipelineColumn {
  const stage = meta?.status ?? null;
  const pinned = meta?.column ? cfg.columns.find((c) => c.id === meta.column && c.stage === stage) : undefined;
  return pinned ?? cfg.columns.find((c) => c.stage === stage)!;
}

/** Hand-sorted songs first (in that order), then the rest, most recently saved first. */
function orderCards(songs: ProjectInfo[], order: string[] = []): ProjectInfo[] {
  const pos = new Map(order.map((p, i) => [p, i]));
  return [...songs].sort((a, b) => {
    const pa = pos.get(a.path);
    const pb = pos.get(b.path);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return lastSaveMs(b) - lastSaveMs(a) || a.name.localeCompare(b.name);
  });
}

export interface PipelineGroup {
  column: PipelineColumn;
  songs: ProjectInfo[];
}

/** Songs per column, in column order and card order. What every view renders. */
export function groupSongs(songs: ProjectInfo[], ws: Workspace, cfg = resolvePipeline(ws)): PipelineGroup[] {
  const groups = new Map(cfg.columns.map((c) => [c.id, [] as ProjectInfo[]]));
  for (const s of songs) groups.get(columnOf(ws.songs[s.path], cfg).id)!.push(s);
  return cfg.columns.map((column) => ({ column, songs: orderCards(groups.get(column.id)!, cfg.order[column.id]) }));
}

// ---- Shared filtering and sorting ----

/** Search across views: song name, crew title, tags, key. */
export function matchesQuery(song: ProjectInfo, meta: SongMeta | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [song.name, meta?.shareTitle ?? "", meta?.key ?? "", ...(meta?.tags ?? []).map((t) => `#${t}`)].join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export function filterSongs(songs: ProjectInfo[], ws: Workspace, query: string): ProjectInfo[] {
  return query.trim() ? songs.filter((s) => matchesQuery(s, ws.songs[s.path], query)) : songs;
}

export interface PipelineRow {
  song: ProjectInfo;
  column: PipelineColumn;
  /** Position on the board: column order, then card order. */
  boardIndex: number;
}

export type SortKey = "board" | "name" | "column" | "saved" | "bpm" | "key";

/** The board order as one flat list (the list and table views). */
export function flatRows(groups: PipelineGroup[]): PipelineRow[] {
  let i = 0;
  return groups.flatMap((g) => g.songs.map((song) => ({ song, column: g.column, boardIndex: i++ })));
}

/** What the table sorts on, for any kind of row (your songs, crew songs). */
export interface SortFields {
  name: string;
  /** Last save, ms (0 = unknown). */
  saved: number;
  bpm: number | null;
  key: string;
  /** Position on the board. */
  boardIndex: number;
}

/** A view's own sort. Never written back: sorting the table doesn't touch the board. */
export function sortBy<T>(rows: T[], fields: (r: T) => SortFields, key: SortKey, dir: 1 | -1): T[] {
  if (key === "board") return dir === 1 ? rows : [...rows].reverse();
  const val = (r: T): number | string => {
    const f = fields(r);
    switch (key) {
      case "name":
        return f.name.toLowerCase();
      case "column":
        return f.boardIndex;
      case "saved":
        return f.saved;
      case "bpm":
        return f.bpm ?? -1;
      case "key":
        return f.key.toLowerCase();
    }
  };
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return c * dir || fields(a).boardIndex - fields(b).boardIndex;
  });
}

/** `sortBy` for your songs. */
export function sortRows(rows: PipelineRow[], key: SortKey, dir: 1 | -1, ws: Workspace): PipelineRow[] {
  return sortBy(
    rows,
    (r) => ({ name: r.song.name, saved: lastSaveMs(r.song), bpm: r.song.tempoBpm, key: ws.songs[r.song.path]?.key ?? "", boardIndex: r.boardIndex }),
    key,
    dir,
  );
}

// ---- Edits (pure: workspace in, workspace out) ----

const withPipeline = (ws: Workspace, cfg: PipelineConfig): Workspace => ({ ...ws, pipeline: cfg });

export function renameColumn(ws: Workspace, id: string, name: string): Workspace {
  const clean = cleanName(name);
  const cfg = resolvePipeline(ws);
  if (!clean || !cfg.columns.some((c) => c.id === id)) return ws;
  return withPipeline(ws, { ...cfg, columns: cfg.columns.map((c) => (c.id === id ? { ...c, name: clean } : c)) });
}

/** Adds a column for `stage`, right after that stage's last column. */
export function addColumn(ws: Workspace, name: string, stage: SongStatus | null, id = newId()): Workspace {
  const clean = cleanName(name);
  const cfg = resolvePipeline(ws);
  if (!clean || stageIndex(stage) < 0 || cfg.columns.some((c) => c.id === id)) return ws;
  const last = cfg.columns.map((c) => c.stage).lastIndexOf(stage);
  const columns = [...cfg.columns];
  columns.splice(last + 1, 0, { id, name: clean, stage });
  return withPipeline(ws, { ...cfg, columns });
}

/** A column can go only if another column holds its stage. */
export function canRemoveColumn(cfg: PipelineConfig, id: string): boolean {
  const col = cfg.columns.find((c) => c.id === id);
  return !!col && cfg.columns.some((c) => c.id !== id && c.stage === col.stage);
}

/** Removes a column. Its songs keep their stage and move to the stage's
 * first remaining column, after the songs already there (nothing is
 * unshared, re-staged or lost). The last column of a stage can't be removed. */
export function removeColumn(ws: Workspace, id: string): Workspace {
  const cfg = resolvePipeline(ws);
  if (!canRemoveColumn(cfg, id)) return ws;
  const gone = cfg.columns.find((c) => c.id === id)!;
  const columns = cfg.columns.filter((c) => c.id !== id);
  const target = columns.find((c) => c.stage === gone.stage)!;
  const order = { ...cfg.order };
  if (order[id]?.length) order[target.id] = [...(order[target.id] ?? []), ...order[id].filter((p) => !order[target.id]?.includes(p))];
  delete order[id];
  const songs = { ...ws.songs };
  for (const [path, meta] of Object.entries(songs)) if (meta.column === id) songs[path] = { ...meta, column: target.id };
  return { ...ws, songs, pipeline: { columns, order } };
}

/** Moves a column to `toIndex` in the display order. */
export function moveColumn(ws: Workspace, id: string, toIndex: number): Workspace {
  const cfg = resolvePipeline(ws);
  const from = cfg.columns.findIndex((c) => c.id === id);
  if (from < 0) return ws;
  const columns = [...cfg.columns];
  const [col] = columns.splice(from, 1);
  columns.splice(Math.max(0, Math.min(toIndex, columns.length)), 0, col);
  return withPipeline(ws, { ...cfg, columns });
}

/** Puts a song in a column, before `beforePath` (or at the end). The stage
 * changes only if the column is on another stage: reordering within a stage
 * is never sent to the crew. `songs` = the songs on the board, to know the
 * column's current order. */
export function moveCard(
  ws: Workspace,
  songs: ProjectInfo[],
  path: string,
  toColumnId: string,
  beforePath: string | null = null,
  now = Date.now(),
): Workspace {
  const cfg = resolvePipeline(ws);
  const to = cfg.columns.find((c) => c.id === toColumnId);
  if (!to || !songs.some((s) => s.path === path) || beforePath === path) return ws;
  const meta = ws.songs[path] ?? {};
  const shown = groupSongs(songs, ws, cfg).find((g) => g.column.id === to.id)!.songs.map((s) => s.path);
  const current = shown.filter((p) => p !== path);
  const at = beforePath ? current.indexOf(beforePath) : -1;
  current.splice(at < 0 ? current.length : at, 0, path);
  // Dropped where it already sits: nothing changes, so nothing gets pinned
  // or hand-sorted (an accidental drag mustn't leave a mark).
  if (columnOf(meta, cfg).id === to.id && shown.length === current.length && shown.every((p, i) => p === current[i])) return ws;

  const stageChanged = (meta.status ?? null) !== to.stage;
  const nextMeta: SongMeta = { ...meta, column: to.id };
  if (stageChanged) Object.assign(nextMeta, { status: to.stage ?? undefined, stageUpdatedAtMs: now, stagePending: true, stageMovedBy: undefined });
  const nextSongs = { ...ws.songs, [path]: nextMeta };

  // Keep each hand-sorted list to the songs actually in that column now, so
  // a song that left (moved elsewhere, archived, deleted) doesn't come back
  // to an old slot and the lists don't grow forever.
  const order: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(cfg.order)) {
    const kept = list.filter((p) => p !== path && songs.some((s) => s.path === p) && columnOf(nextSongs[p], cfg).id === id);
    if (kept.length) order[id] = kept;
  }
  order[to.id] = current;
  return { ...ws, songs: nextSongs, pipeline: { ...cfg, order } };
}
