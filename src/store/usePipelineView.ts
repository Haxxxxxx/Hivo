import { create } from "zustand";
import type { SortKey } from "../lib/pipeline";

// Per-view display state of the pipelines (yours and the crew's): which view
// is open, which columns each view has collapsed, the table's sort, the
// search. Kept on this computer only and never written to the workspace or
// the crew server: sorting the table or collapsing a list section must not
// change the board, nor anyone else's.

export type PipelineViewKind = "board" | "list" | "table";
/** Your pipeline or the crew's: each keeps its own view state. */
export type PipelineScope = "mine" | "crew";
type Sort = { key: SortKey; dir: 1 | -1 };

interface PipelineViewState {
  view: Record<PipelineScope, PipelineViewKind>;
  /** Collapsed column ids, per scope and view ("mine.board"). */
  collapsed: Record<string, string[]>;
  tableSort: Record<PipelineScope, Sort>;
  /** Search, per scope, while the app is open (not saved). */
  query: Record<PipelineScope, string>;
  /** The crew board shows one member's songs only (from the crew
   * dashboard's member rows); null = everyone. Not saved. */
  crewMember: string | null;
  setView: (scope: PipelineScope, view: PipelineViewKind) => void;
  toggleCollapsed: (scope: PipelineScope, view: PipelineViewKind, columnId: string) => void;
  setTableSort: (scope: PipelineScope, key: SortKey) => void;
  setQuery: (scope: PipelineScope, query: string) => void;
  setCrewMember: (userId: string | null) => void;
}

const KEY = "hivo.pipelineView";
type Saved = Pick<PipelineViewState, "view" | "collapsed" | "tableSort">;
const SORT: Sort = { key: "board", dir: 1 };
const DEFAULTS: Saved = { view: { mine: "board", crew: "board" }, collapsed: {}, tableSort: { mine: SORT, crew: SORT } };
const KINDS: PipelineViewKind[] = ["board", "list", "table"];
const SORT_KEYS: SortKey[] = ["board", "name", "column", "saved", "bpm", "key"];

const kind = (v: unknown): PipelineViewKind => (KINDS.includes(v as PipelineViewKind) ? (v as PipelineViewKind) : "board");
const sort = (v: unknown): Sort => {
  const s = (v ?? {}) as Partial<Sort>;
  return { key: SORT_KEYS.includes(s.key as SortKey) ? (s.key as SortKey) : "board", dir: s.dir === -1 ? -1 : 1 };
};
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    if (!raw) return DEFAULTS;
    // Before the crew board had views, this held only your pipeline's state.
    const old = typeof raw.view === "string";
    const view = old ? { mine: kind(raw.view), crew: "board" as const } : { mine: kind((raw.view as Record<string, unknown>)?.mine), crew: kind((raw.view as Record<string, unknown>)?.crew) };
    const collapsed: Record<string, string[]> = {};
    for (const [k, v] of Object.entries((raw.collapsed ?? {}) as Record<string, unknown>)) collapsed[old ? `mine.${k}` : k] = ids(v);
    const ts = (raw.tableSort ?? {}) as Record<string, unknown>;
    const tableSort = old ? { mine: sort(ts), crew: SORT } : { mine: sort(ts.mine), crew: sort(ts.crew) };
    return { view, collapsed, tableSort };
  } catch {
    return DEFAULTS;
  }
}

function save(s: PipelineViewState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ view: s.view, collapsed: s.collapsed, tableSort: s.tableSort } satisfies Saved));
  } catch {
    // Storage full or blocked: the view just won't be remembered.
  }
}

export const usePipelineView = create<PipelineViewState>((set, get) => {
  const update = (patch: Partial<PipelineViewState>) => {
    set(patch);
    save(get());
  };
  return {
    ...load(),
    query: { mine: "", crew: "" },
    crewMember: null,
    setView: (scope, view) => update({ view: { ...get().view, [scope]: view } }),
    toggleCollapsed: (scope, view, columnId) => {
      const k = `${scope}.${view}`;
      const list = get().collapsed[k] ?? [];
      update({ collapsed: { ...get().collapsed, [k]: list.includes(columnId) ? list.filter((x) => x !== columnId) : [...list, columnId] } });
    },
    setTableSort: (scope, key) => {
      const cur = get().tableSort[scope];
      const next: Sort = { key, dir: cur.key === key ? (cur.dir === 1 ? -1 : 1) : key === "saved" ? -1 : 1 };
      update({ tableSort: { ...get().tableSort, [scope]: next } });
    },
    setQuery: (scope, query) => set({ query: { ...get().query, [scope]: query } }),
    setCrewMember: (crewMember) => set({ crewMember }),
  };
});

/** Collapsed column ids for one scope and view. */
export function useCollapsed(scope: PipelineScope, view: PipelineViewKind): string[] {
  return usePipelineView((s) => s.collapsed[`${scope}.${view}`]) ?? EMPTY;
}
const EMPTY: string[] = [];
