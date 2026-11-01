import { create } from "zustand";
import * as api from "../lib/tauri";
import { canonicalUrl, deeperExclude, foundTitles, leadHash, likedTitles, restoreDig, searchesDone, toggleLiked, withFallbackQueries, type KeptDig, type Liked } from "../lib/digger";
import { useAppStore } from "./useAppStore";
import type { BeatFacts, BeatFile, DigResult, Lead, SavedLead, WebLink, YoutubeVideo } from "../types";

// The Digger: raw beats from the beats folders, up to 5 picked to dig for
// similar ones (docs/GUARDRAILS.md: a deliberate addition for the Creation
// stage). The beats live in their folders; the last dig (result, rounds,
// results, picks) is kept by Rust in the config dir (`save_last_dig`) and
// restored on the next launch; each beat's offline analysis is cached by
// Rust per file (`analyze_beats`).

export const MAX_PICKS = 5;
/** Same as `MAX_ANALYZE` in src-tauri/src/beats.rs: paths per analysis call. */
export const MAX_ANALYZE = 20;

/** What the beats scan didn't show. */
export interface ScanInfo {
  total: number;
  capped: boolean;
  ignored: number;
}

/** One "Go deeper" round: web links (Google Search) or new YouTube searches (without it). */
export interface DeeperRound {
  links: WebLink[];
  queries: string[];
  /** The titles of the results the round was seeded from ("Use for next dig"). */
  seeds: string[];
}

/** One round's YouTube results: the search that ran and what it gave back. */
export interface RoundResults {
  query: string;
  videos: YoutubeVideo[];
}

/** `list` with `entry` at `round`, earlier rounds that never searched left empty. */
function withRound(list: RoundResults[], round: number, entry: RoundResults): RoundResults[] {
  const out = list.slice();
  while (out.length < round) out.push({ query: "", videos: [] });
  out[round] = entry;
  return out;
}

interface DiggerState {
  beats: BeatFile[];
  scanInfo: ScanInfo | null;
  /** Offline analysis per beat path: facts, null (couldn't be read), missing (not yet). */
  facts: Record<string, BeatFacts | null>;
  analysing: boolean;
  /** Measures the beats without facts yet, a batch at a time (no AI key needed). */
  analyseBeats: () => Promise<void>;
  /** Reads the last dig back (once per launch). */
  restoreLastDig: () => Promise<void>;
  /** "Try again" on the "web search isn't available" line. */
  retryWeb: (language: "fr" | "en", youtube: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
  /** Picked beat paths, in pick order (max MAX_PICKS). */
  picked: string[];
  query: string;
  load: () => Promise<void>;
  toggle: (path: string) => void;
  clearPicks: () => void;
  setQuery: (query: string) => void;
  /** The YouTube search box (DigResults): what was typed, whether a search runs. */
  webQuery: string;
  searching: boolean;
  searchError: string | null;
  /** The last search that answered (null before any search). */
  searchedFor: string | null;
  setWebQuery: (q: string) => void;
  /** Search YouTube; the results land in the round on screen (`shownRound`). */
  searchYoutube: (q: string) => Promise<void>;
  /** The round on screen: 0 is the dig, n is rounds[n - 1]. Back to the
   * latest whenever a dig or a round arrives. */
  shownRound: number;
  setShownRound: (round: number) => void;
  /** YouTube results per round, indexed like the breadcrumb: 0 is the dig's
   * first search, n is rounds[n - 1]'s, each updated by a manual search
   * while that round is shown. */
  roundResults: RoundResults[];
  /** Results picked for the next round to go closer to (max MAX_LIKED);
   * a new dig clears them. */
  liked: Liked[];
  toggleLiked: (id: string, title: string) => void;
  /** The AI dig over the picks (Rust: digger.rs). */
  dig: DigResult | null;
  /** The picks the current `dig` is about. */
  dugFor: string[];
  digging: boolean;
  digError: string | null;
  runDig: (language: "fr" | "en", youtube: boolean) => Promise<void>;
  /** "Go deeper" rounds after the dig, in order. */
  rounds: DeeperRound[];
  diggingDeeper: boolean;
  deeperError: string | null;
  runDeeper: (language: "fr" | "en", youtube: boolean) => Promise<void>;
  /** A dig or round finished while another view was open (Sidebar LED). */
  unseen: boolean;
  clearUnseen: () => void;
  /** Leads saved in the beats folders' `_leads`: url hash (`leadHash`) → file path. */
  savedLeads: Map<string, string>;
  /** The same leads with their facts, newest first (the Saved prods tab). */
  leads: SavedLead[];
  loadLeads: () => Promise<void>;
  /** Writes the lead as a text file (Rust: leads.rs); its hash turns "Saved". */
  saveLead: (lead: Lead) => Promise<void>;
  /** Deletes one lead file. */
  deleteLead: (path: string) => Promise<void>;
  leadError: string | null;
  /** What the docked YouTube player (DigResults) is on: results and saved
   * prods share it. */
  playing: Playing | null;
  setPlaying: (p: Playing | null) => void;
}

/** A checked YouTube ID and a title for the embedded player. */
export interface Playing {
  id: string;
  title: string;
}

/** A stable empty map: a fresh one in a selector re-renders forever. */
const NO_LEADS: Map<string, string> = new Map();
const NO_LEAD_LIST: SavedLead[] = [];

/** A dig finished: flag it unless the Digger is on screen. */
function markUnseen(set: (s: Partial<DiggerState>) => void) {
  if (useAppStore.getState().view !== "digger") set({ unseen: true });
}

/** Bumped by every scan: an analysis loop from an older scan stops. */
let analysisRun = 0;
/** The last dig is read back once; nothing is saved before that. */
let restored = false;

export const useDigger = create<DiggerState>((set, get) => ({
  beats: [],
  scanInfo: null,
  facts: {},
  analysing: false,
  analyseBeats: async () => {
    const run = ++analysisRun;
    set({ analysing: true });
    try {
      for (;;) {
        const { beats, facts } = get();
        const todo = beats.filter((b) => !(b.path in facts)).slice(0, MAX_ANALYZE).map((b) => b.path);
        if (!todo.length || run !== analysisRun) break;
        let got: { path: string; facts: BeatFacts | null }[];
        try {
          got = await api.analyzeBeats(todo);
        } catch {
          // Scope changed or Rust refused the batch: mark it unreadable, go on.
          got = todo.map((path) => ({ path, facts: null }));
        }
        if (run !== analysisRun) break;
        const next = { ...get().facts };
        for (const a of got) next[a.path] = a.facts;
        set({ facts: next });
      }
    } finally {
      if (run === analysisRun) set({ analysing: false });
    }
  },
  restoreLastDig: async () => {
    if (restored) return;
    try {
      const kept = restoreDig(await api.loadLastDig());
      // A dig made in this session before the file was read wins.
      if (kept && !get().dig) {
        // The picks come back with their dig (so it isn't shown as stale),
        // unless picks were made meanwhile; beats gone since are dropped.
        const { picked, beats } = get();
        const known = new Set(beats.map((b) => b.path));
        const back = beats.length ? kept.dugFor.filter((p) => known.has(p)) : kept.dugFor;
        set({ ...kept, picked: picked.length ? picked : back });
      }
    } catch {
      // Nothing kept, or unreadable: start fresh.
    } finally {
      restored = true;
    }
  },
  retryWeb: async (language, youtube) => {
    try {
      await api.resetWebSearch();
    } catch {
      // The round below says what's wrong if the web search still fails.
    }
    const dig = get().dig;
    if (dig) set({ dig: { ...dig, webError: null } });
    await get().runDeeper(language, youtube);
  },
  loading: false,
  error: null,
  picked: [],
  query: "",
  load: async () => {
    set({ loading: true, error: null });
    try {
      const scan = await api.scanBeatsFull();
      const beats = scan.beats;
      const known = new Set(beats.map((b) => b.path));
      set({ beats, scanInfo: { total: scan.total, capped: scan.capped, ignored: scan.ignored }, picked: get().picked.filter((p) => known.has(p)) });
      // Notes follow a renamed or moved beat.
      useAppStore.getState().syncBeatNotes(beats);
      void get().analyseBeats();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },
  toggle: (path) => {
    const picked = get().picked;
    if (picked.includes(path)) set({ picked: picked.filter((p) => p !== path) });
    else if (picked.length < MAX_PICKS) set({ picked: [...picked, path] });
  },
  clearPicks: () => set({ picked: [] }),
  setQuery: (query) => set({ query }),
  webQuery: "",
  searching: false,
  searchError: null,
  searchedFor: null,
  setWebQuery: (webQuery) => set({ webQuery }),
  searchYoutube: async (q) => {
    const query = q.trim();
    if (!query) return;
    // The results belong to the round on screen when the search started.
    const round = get().shownRound;
    set({ webQuery: query, searching: true, searchError: null });
    try {
      const videos = await api.youtubeSearch(query);
      // A slower, older search must not overwrite a newer one.
      if (get().webQuery === query) set({ searchedFor: query, roundResults: withRound(get().roundResults, round, { query, videos }) });
    } catch (e) {
      // The round keeps what it had; the error shows above it.
      if (get().webQuery === query) set({ searchedFor: null, searchError: e instanceof Error ? e.message : String(e) });
    } finally {
      if (get().webQuery === query) set({ searching: false });
    }
  },
  shownRound: 0,
  setShownRound: (shownRound) => set({ shownRound }),
  roundResults: [],
  liked: [],
  toggleLiked: (id, title) => set({ liked: toggleLiked(get().liked, id, title) }),
  dig: null,
  dugFor: [],
  digging: false,
  digError: null,
  runDig: async (language, youtube) => {
    const picks = get().picked;
    if (!picks.length || get().digging) return;
    set({ digging: true, digError: null });
    try {
      const names = picks.map((p) => get().beats.find((b) => b.path === p)?.name ?? "");
      // No searches from the model: the beat names' own searches stand in.
      const dig = withFallbackQueries(await api.digBeats(picks, language), names);
      // Measured again by the dig: the list shows them too.
      const facts = { ...get().facts };
      for (const p of picks) {
        const name = get().beats.find((b) => b.path === p)?.name;
        const f = dig.beats.find((b) => b.name === name);
        if (f) facts[p] = f;
      }
      // A fresh dig: no rounds, no per-round results, back to round 0. The
      // results picked for "Use for next dig" stay: they steer the next round.
      set({ dig, facts, dugFor: picks, rounds: [], roundResults: [], shownRound: 0, deeperError: null });
      markUnseen(set);
      // Start the first AI search right away (round 0's results); the others are one click.
      const first = dig.analysis.queries[0];
      if (first) {
        set({ webQuery: first });
        if (youtube) void get().searchYoutube(first);
      }
    } catch (e) {
      set({ digError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ digging: false });
    }
  },
  rounds: [],
  diggingDeeper: false,
  deeperError: null,
  runDeeper: async (language, youtube) => {
    const { dig, rounds: before, roundResults, liked, diggingDeeper } = get();
    if (!dig || diggingDeeper) return;
    set({ diggingDeeper: true, deeperError: null });
    try {
      const links = before.map((r) => r.links);
      // Everything already on screen (every round's), so the new searches go elsewhere.
      const shown = foundTitles([...dig.web, ...links.flat()].map((l) => l.text).concat(roundResults.flatMap((r) => r.videos.map((v) => v.title))));
      // The picks steer the round: their titles go to both prompts as data.
      const seeds = likedTitles(liked);
      const round = await api.digDeeper(dig.analysis, deeperExclude(dig.web, links), shown, searchesDone(before), seeds, language);
      // A new dig meanwhile made this round about the wrong picks.
      if (get().dig !== dig) return;
      const brought = round.web.length > 0 || round.queries.length > 0;
      if (brought) {
        // The new round goes on screen, so its first search lands in it.
        const rounds = [...get().rounds, { links: round.web, queries: round.queries, seeds }];
        set({ rounds, shownRound: rounds.length });
      }
      if (round.webError) set({ deeperError: round.webError });
      // The menu dot means "something new to look at", not "a round ran".
      if (brought) markUnseen(set);
      // Same as runDig: the first new search runs right away.
      const first = round.queries[0];
      if (first) {
        set({ webQuery: first });
        if (youtube) void get().searchYoutube(first);
      }
    } catch (e) {
      set({ deeperError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ diggingDeeper: false });
    }
  },
  unseen: false,
  clearUnseen: () => set({ unseen: false }),
  savedLeads: NO_LEADS,
  leads: NO_LEAD_LIST,
  loadLeads: async () => {
    try {
      const saved = await api.listLeads();
      // Keyed by the canonical address too: a lead saved as youtu.be/… is
      // "Saved" on the watch?v=… card of the same video.
      const map = new Map<string, string>();
      for (const l of saved) {
        if (l.unrecognised) continue;
        map.set(l.hash, l.path);
        if (l.url) map.set(leadHash(canonicalUrl(l.url)), l.path);
      }
      set({ savedLeads: map, leads: saved });
    } catch {
      // No beats folder or nothing readable: nothing is saved, nothing to show.
      set({ savedLeads: NO_LEADS, leads: NO_LEAD_LIST });
    }
  },
  saveLead: async (lead) => {
    set({ leadError: null });
    try {
      const url = canonicalUrl(lead.url);
      const path = await api.saveLead({ ...lead, url });
      set({ savedLeads: new Map(get().savedLeads).set(leadHash(url), path) });
      // The list reads the file back (its date, the clipped facts).
      await get().loadLeads();
    } catch (e) {
      set({ leadError: e instanceof Error ? e.message : String(e) });
    }
  },
  deleteLead: async (path) => {
    set({ leadError: null });
    try {
      await api.deleteLead(path);
      await get().loadLeads();
    } catch (e) {
      set({ leadError: e instanceof Error ? e.message : String(e) });
    }
  },
  leadError: null,
  playing: null,
  setPlaying: (playing) => set({ playing }),
}));

/** What is kept of the dig, from the store. */
function kept(s: DiggerState): KeptDig | null {
  if (!s.dig) return null;
  return { dig: s.dig, dugFor: s.dugFor, rounds: s.rounds, roundResults: s.roundResults, liked: s.liked, shownRound: s.shownRound, webQuery: s.webQuery };
}

// Keeps the last dig (Rust writes it), a moment after it changes.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useDigger.subscribe((s, prev) => {
  if (!restored) return;
  if (s.dig === prev.dig && s.rounds === prev.rounds && s.roundResults === prev.roundResults && s.liked === prev.liked && s.shownRound === prev.shownRound && s.dugFor === prev.dugFor) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void api.saveLastDig(kept(useDigger.getState())).catch(() => {});
  }, 800);
});

/** Whether the picks changed since the last dig. */
export function digIsStale(picked: string[], dugFor: string[]): boolean {
  return picked.length !== dugFor.length || picked.some((p) => !dugFor.includes(p));
}

/** Beats matching a search (name or folder), every word must match. */
export function filterBeats(beats: BeatFile[], query: string): BeatFile[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return beats;
  return beats.filter((b) => {
    const hay = `${b.name} ${b.folder}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
