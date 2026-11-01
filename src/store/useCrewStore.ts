import { statusInfo } from "../lib/songs";
import { crewText } from "../lib/crewMessages";
import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { crewErrorMessage, supabase } from "../lib/supabase";
import {
  chunks,
  goneCrewIds,
  isQuotaError,
  RELEASES_PER_CREW,
  releasePayloads,
  releaseRowMatches,
  releaseSharedHere,
  releaseTombstones,
  shareElsewhere,
  sharedHere,
  sharedPayloads,
  shareRoom,
  SONGS_PER_CREW,
  songRowMatches,
  stageSync,
  staleReleaseIds,
  staleShareIds,
  syncFingerprint,
  type ShareScope,
  type StageSync,
} from "../lib/crewSync";
import { applyPlaced, fetchAllPages, isMissingOnServer, placeCards } from "../lib/crewFetch";
import type { CrewColumnRow, CrewInvite, CrewMemberRow, CrewReleaseRow, CrewSongRow, CrewSummary, PipelineConfig, SongStatus } from "../types";
import { applyCardMove, columnsPayload, crewMove, crewPipeline, restoreSongs } from "../lib/crewBoard";
import { useAppStore } from "./useAppStore";

// The crew side of the app (docs/ARCHITECTURE.md): sign-in, crews, the
// crew's shared songs, and sync with the local workspace. Off entirely when
// no Supabase project is configured, and never active on sample data.
//
// Every sync is one cycle: pull the crew's rows, apply crewmates' stage moves
// locally, then push (see the rules in lib/crewSync.ts). Cycles never overlap;
// a change during a cycle queues one more. Cycles run on local changes
// (debounced), on crew switch, after realtime reconnects, and on focus/online.

const ACTIVE_CREW_KEY = "flm-active-crew";
/** Names of the crews I've been in (id → name), to say which one I'm no longer in. */
const CREW_NAMES_KEY = "flm-crew-names";
const PUSH_DELAY_MS = 1500;
const RETRY_MS = 30_000;
const FOCUS_MIN_GAP_MS = 20_000;
const SAFETY_SYNC_MS = 5 * 60_000;

export type { CrewInvite } from "../types";

type SyncState =
  | { kind: "idle" }
  | { kind: "syncing" }
  /** `skipped`: shared songs the database refused (a bad value), left out of
   * the push. `overLimit` / `releasesOverLimit`: new shares left out because
   * the share or release limit is reached (the rest synced). */
  | { kind: "synced"; atMs: number; skipped: number; overLimit: number; releasesOverLimit: number }
  | { kind: "error"; message: string };

/** What sharing songs did: left alone because they're shared with another
 * crew, or not shared because the share limit would be passed. */
export interface ShareResult {
  elsewhere: number;
  overLimit: number;
}

interface CrewState {
  enabled: boolean;
  ready: boolean;
  userId: string | null;
  email: string | null;
  crews: CrewSummary[];
  /** Loading the crew list failed (so an empty list doesn't mean "no crews"). */
  loadError: string | null;
  activeCrewId: string | null;
  members: CrewMemberRow[];
  songs: CrewSongRow[];
  /** The crew board's columns (empty: one per stage, never edited). */
  columns: CrewColumnRow[];
  /** Releases shared with the active crew (everyone's). */
  releases: CrewReleaseRow[];
  invite: string | null;
  /** Open invite codes of the active crew (owners only). */
  invites: CrewInvite[];
  sync: SyncState;
  /** Crews I found I'm no longer in (removed, or the crew was deleted), by
   * name ("" when unknown): my shares there were forgotten. Shown once. */
  removedFrom: string[];

  init: () => Promise<void>;
  dismissRemoved: () => void;
  /** Owner: rename the active crew. */
  renameCrew: (name: string) => Promise<void>;
  /** My name in the active crew. */
  setDisplayName: (name: string) => Promise<void>;
  /** Owner: make another member the owner (I become a member). */
  transferOwnership: (userId: string) => Promise<void>;
  /** Delete my rows on the crew server (ones this computer doesn't know). */
  removeServerShares: (ids: string[]) => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  loadCrews: () => Promise<void>;
  selectCrew: (id: string | null) => Promise<void>;
  createCrew: (name: string, displayName: string) => Promise<void>;
  joinCrew: (code: string, displayName: string) => Promise<void>;
  createInvite: () => Promise<string>;
  loadInvites: () => Promise<void>;
  revokeInvite: (code: string) => Promise<void>;
  /** Owner: remove a crewmate (their shared songs leave with them). */
  removeMember: (userId: string) => Promise<void>;
  leaveCrew: () => Promise<void>;
  /** Owner: delete the active crew for everyone (the crew's name typed back). */
  deleteCrew: (confirmName: string) => Promise<void>;
  /** Share or stop sharing songs with the active crew. Songs shared with
   * another crew are left alone (see moveShares). */
  /** Says how many songs were left out (shared with another crew, or past
   * the share limit: a bulk share is cut to the room left). */
  setShared: (paths: string[], shared: boolean) => ShareResult;
  /** Take songs off another crew's board and share them here instead. */
  moveShares: (paths: string[]) => Promise<void>;
  /** Move any crew song on the shared board. */
  moveCrewSong: (songId: string, stage: SongStatus | null) => Promise<void>;
  /** A crewmate moved my song while my move was waiting: keep theirs or mine. */
  resolveStageConflict: (path: string, keep: "theirs" | "mine") => void;
  syncNow: () => Promise<void>;
  /** Owner: save the crew board's columns (the whole set, src/lib/crewBoard.ts). */
  saveCrewColumns: (cfg: PipelineConfig) => Promise<void>;
  /** Share a release with the active crew, with all its tracks (or stop
   * sharing it; its tracks stay shared). Says how many tracks were left out. */
  shareRelease: (albumId: string, shared: boolean) => ShareResult;
  /** Move a crew card to a column, before another card (or at the end). */
  moveCrewCard: (songId: string, columnId: string, beforeId: string | null) => Promise<void>;
}

let initialized = false;
let channel: RealtimeChannel | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;
let cycleAgain = false;
let lastCycleMs = 0;
/** Last payload pushed per release id. */
const lastPushedRelease = new Map<string, string>();
/** Last payload pushed per song id, so unchanged songs aren't re-sent. */
const lastPushed = new Map<string, string>();
/** Payloads the database refused (bad value): not retried until they change. */
const rejected = new Map<string, string>();
/** What the last push was built from (syncFingerprint): a local change that
 * leaves it the same doesn't start a sync. */
let lastFingerprint: string | null = null;
/** A sync is due whatever the fingerprint says (the workspace just loaded). */
let forceNextSync = false;
/** Inside one of the store's own workspace writes (stage settles, forgotten
 * shares…): those never need a push of their own. */
let selfWriting = 0;
/** Someone else changed the workspace while a cycle ran. */
let changedDuringCycle = false;
/** Crews I'm no longer in, found while the real workspace wasn't loaded
 * (sample data, read-only): forgotten once it is. */
const pendingForget = new Set<string>();

function own(fn: () => void) {
  selfWriting++;
  try {
    fn();
  } finally {
    selfWriting--;
  }
}

function readCrewNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CREW_NAMES_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function rememberCrewNames(crews: CrewSummary[]) {
  try {
    const names = readCrewNames();
    for (const c of crews) names[c.id] = c.name;
    localStorage.setItem(CREW_NAMES_KEY, JSON.stringify(names));
  } catch {
    /* only used to name a crew in a notice */
  }
}

/** Upsert results: rows that went through, and new rows the limit refused. */
interface UpsertResult<T> {
  ok: T[];
  overLimit: number;
}

/** The order rows are shown in (they're read in id order, for stable pages). */
const byUpdatedDesc = (a: CrewSongRow, b: CrewSongRow) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.id.localeCompare(b.id);
const byReleaseDate = (a: CrewReleaseRow, b: CrewReleaseRow) =>
  (a.release_date ? 0 : 1) - (b.release_date ? 0 : 1) || (a.release_date ?? "").localeCompare(b.release_date ?? "") || a.id.localeCompare(b.id);

/** A refusal caused by one row's values (check, not-null, invalid input),
 * rather than the network, auth or a quota. */
function isBadValue(e: { code?: string }): boolean {
  return !!e.code && (e.code.startsWith("22") || e.code === "23514" || e.code === "23502");
}

/** RFC 4122 v4 (the database id type), with a fallback for old webviews. */
function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function readActiveCrew(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CREW_KEY);
  } catch {
    return null;
  }
}

function writeActiveCrew(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_CREW_KEY, id);
    else localStorage.removeItem(ACTIVE_CREW_KEY);
  } catch {
    /* per-device convenience only */
  }
}

export const useCrewStore = create<CrewState>((set, get) => {
  const scope = (): ShareScope | null => {
    const { activeCrewId, userId } = get();
    return activeCrewId && userId ? { crewId: activeCrewId, userId } : null;
  };

  /** After leaving or deleting a crew: the server already removed my songs
   * and releases from it, so forget those shares here and go back to the
   * crew list. */
  async function forgetCrew(sc: ShareScope) {
    forgetShares(sc, true);
    writeActiveCrew(null);
    await get().loadCrews();
  }

  /** The real workspace is loaded and can be saved (never sample data, never
   * an empty stand-in after a failed load). */
  const workspaceEditable = () => {
    const app = useAppStore.getState();
    return !app.demoMode && app.settingsLoaded && app.workspaceWritable;
  };

  /** Forget my shares with one crew (the server already dropped those rows).
   * `legacy`: shares from before crew scoping count too (only when the crew
   * is the active one, as leaving does). */
  function forgetShares(sc: ShareScope, legacy: boolean) {
    const inCrew = (crewId: string | undefined, userId: string | undefined) =>
      legacy ? (crewId ?? sc.crewId) === sc.crewId && (userId ?? sc.userId) === sc.userId : crewId === sc.crewId && userId === sc.userId;
    own(() => {
      const app = useAppStore.getState();
      for (const [path, meta] of Object.entries(app.workspace.songs)) {
        if (meta.shareId && inCrew(meta.shareCrewId, meta.shareUserId)) {
          lastPushed.delete(meta.shareId);
          app.updateSong(path, { shared: false, shareId: undefined, shareCrewId: undefined, shareUserId: undefined });
        }
      }
      for (const a of app.workspace.albums) {
        if (a.shareId && inCrew(a.shareCrewId, a.shareUserId)) {
          lastPushedRelease.delete(a.shareId);
          app.updateAlbum(a.id, { shared: false, shareId: undefined, shareCrewId: undefined, shareUserId: undefined });
        }
      }
      const tombs = (useAppStore.getState().workspace.deletedReleaseShares ?? []).filter((d) => inCrew(d.crewId, d.userId)).map((d) => d.id);
      if (tombs.length) app.clearDeletedReleaseShares(tombs);
    });
  }

  /** Crews my shares here point to that I'm no longer in: forget those shares
   * (so a rejoin never republishes them without asking) and say so once. */
  function forgetGoneCrews() {
    const userId = get().userId;
    if (!userId) return;
    const mine = get().crews.map((c) => c.id);
    if (!workspaceEditable()) return;
    const gone = new Set([...pendingForget, ...goneCrewIds(useAppStore.getState().workspace, userId, mine)]);
    pendingForget.clear();
    if (!gone.size) return;
    const names = readCrewNames();
    for (const crewId of gone) forgetShares({ crewId, userId }, false);
    set({ removedFrom: [...new Set([...get().removedFrom, ...[...gone].map((id) => names[id] ?? "")])] });
  }

  /** Signed in with a crew chosen: the crew's rows can be read (sample data too). */
  const canPull = () => !!supabase && !!scope();

  /** …and the real workspace loaded: my shares can be pushed. */
  const canSync = () => canPull() && workspaceEditable();

  /** Fetch the active crew's rows (every page). Returns false if the crew
   * changed meanwhile or I'm no longer a member (then my shares with it are
   * forgotten and the crew list is reloaded). */
  async function loadCrewData(): Promise<boolean> {
    const crewId = get().activeCrewId;
    const db = supabase;
    if (!db || !crewId) {
      set({ songs: [], members: [], columns: [], releases: [] });
      return false;
    }
    const [songs, members, columns, releases] = await Promise.all([
      fetchAllPages<CrewSongRow>((from, to) => db.from("songs").select("*").eq("crew_id", crewId).order("id").range(from, to)),
      db.from("crew_members").select("*").eq("crew_id", crewId).order("joined_at"),
      db.from("crew_columns").select("*").eq("crew_id", crewId).order("position"),
      fetchAllPages<CrewReleaseRow>((from, to) => db.from("releases").select("*").eq("crew_id", crewId).order("id").range(from, to)),
    ]);
    if (get().activeCrewId !== crewId) return false;
    if (songs.error) throw songs.error;
    if (members.error) throw members.error;
    const memberRows = members.data as CrewMemberRow[];
    const userId = get().userId;
    if (userId && !memberRows.some((m) => m.user_id === userId)) {
      // Removed from the crew (or it was deleted): the server dropped my
      // rows, so forget my shares with it; then back to the crew list.
      if (workspaceEditable()) {
        forgetShares({ crewId, userId }, true);
        set({ removedFrom: [...new Set([...get().removedFrom, readCrewNames()[crewId] ?? ""])] });
      } else pendingForget.add(crewId);
      void get().loadCrews().catch(() => {});
      return false;
    }
    // Only a crew server without these tables means "none"; anything else is an error.
    if (columns.error && !isMissingOnServer(columns.error)) throw columns.error;
    if (releases.error && !isMissingOnServer(releases.error)) throw releases.error;
    set({
      songs: [...songs.data].sort(byUpdatedDesc),
      members: memberRows,
      columns: columns.error ? [] : (columns.data as CrewColumnRow[]),
      releases: releases.error ? [] : [...releases.data].sort(byReleaseDate),
    });
    return true;
  }

  /** A realtime insert/update of one of the active crew's songs. */
  function upsertSong(crewId: string, row: CrewSongRow) {
    if (get().activeCrewId !== crewId || !row?.id) return;
    set({ songs: [row, ...get().songs.filter((s) => s.id !== row.id)] });
    applyRemoteMoves();
  }

  /** Apply the crew's stage moves to my local songs (adopt, settle, or flag
   * a conflict). Sending my own waiting moves is push()'s job. */
  function applyRemoteMoves() {
    const sc = scope();
    if (!sc || !canSync()) return;
    for (const a of stageSync(get().songs, useAppStore.getState().workspace, sc)) {
      if (a.kind !== "push") applyStage(a);
    }
  }

  function applyStage(a: Exclude<StageSync, { kind: "push" }>) {
    const app = useAppStore.getState();
    own(() => {
      if (a.kind === "adopt") {
        app.updateSong(a.path, { status: a.stage, stageBaseAt: a.at, stagePending: false, stageConflict: undefined, stageUpdatedAtMs: Date.parse(a.at) });
      } else if (a.kind === "settle") {
        app.updateSong(a.path, { stageBaseAt: a.at, stagePending: false, stageConflict: undefined });
      } else {
        app.updateSong(a.path, { stageConflict: a.conflict });
      }
    });
  }

  /** move_song_stage: applied only if the song is still at `expected`. */
  async function moveStage(id: string, stage: SongStatus | null, expected: string | null) {
    if (!supabase) throw new Error("crew sharing is off");
    const { data, error } = await supabase.rpc("move_song_stage", { p_song: id, p_stage: stage, p_expected_at: expected });
    if (error) throw error;
    const r = (Array.isArray(data) ? data[0] : data) as { applied: boolean; stage: SongStatus | null; stage_updated_at: string; stage_updated_by: string | null };
    set({ songs: get().songs.map((s) => (s.id === id ? { ...s, stage: r.stage, stage_updated_at: r.stage_updated_at, stage_updated_by: r.stage_updated_by } : s)) });
    return r;
  }

  function upsertRelease(crewId: string, row: CrewReleaseRow) {
    if (get().activeCrewId !== crewId || !row?.id) return;
    set({ releases: [...get().releases.filter((r) => r.id !== row.id), row] });
  }

  async function reloadColumns(crewId: string) {
    if (!supabase || get().activeCrewId !== crewId) return;
    const { data, error } = await supabase.from("crew_columns").select("*").eq("crew_id", crewId).order("position");
    if (!error && get().activeCrewId === crewId) set({ columns: data as CrewColumnRow[] });
  }

  function subscribe(crewId: string | null) {
    if (channel && supabase) void supabase.removeChannel(channel);
    channel = null;
    if (!supabase || !crewId) return;
    let joinedOnce = false;
    // Realtime never delivers DELETE events through a filter, and a deleted
    // row arrives with only its primary key. So inserts/updates are filtered
    // to this crew; deletes come unfiltered and are matched by key against
    // what's on screen (anything unknown is ignored).
    channel = supabase
      .channel(`crew:${crewId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "songs", filter: `crew_id=eq.${crewId}` }, (p) => upsertSong(crewId, p.new as CrewSongRow))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "songs", filter: `crew_id=eq.${crewId}` }, (p) => upsertSong(crewId, p.new as CrewSongRow))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "songs" }, (p) => {
        const id = (p.old as { id?: string })?.id;
        if (get().activeCrewId !== crewId || !id || !get().songs.some((s) => s.id === id)) return;
        set({ songs: get().songs.filter((s) => s.id !== id) });
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "releases", filter: `crew_id=eq.${crewId}` }, (p) => upsertRelease(crewId, p.new as CrewReleaseRow))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "releases", filter: `crew_id=eq.${crewId}` }, (p) => upsertRelease(crewId, p.new as CrewReleaseRow))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "releases" }, (p) => {
        const id = (p.old as { id?: string })?.id;
        if (get().activeCrewId !== crewId || !id || !get().releases.some((r) => r.id === id)) return;
        set({ releases: get().releases.filter((r) => r.id !== id) });
      })
      // The owner edited the board's columns (a whole set at a time): refetch them.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "crew_columns", filter: `crew_id=eq.${crewId}` }, () => void reloadColumns(crewId))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "crew_columns", filter: `crew_id=eq.${crewId}` }, () => void reloadColumns(crewId))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "crew_columns" }, (p) => {
        const id = (p.old as { id?: string })?.id;
        if (id && get().columns.some((c) => c.id === id)) void reloadColumns(crewId);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "crew_members", filter: `crew_id=eq.${crewId}` }, () => {
        if (get().activeCrewId === crewId) void loadCrewData().catch(() => {});
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "crew_members", filter: `crew_id=eq.${crewId}` }, () => {
        if (get().activeCrewId === crewId) void loadCrewData().catch(() => {});
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "crew_members" }, (p) => {
        const old = p.old as Partial<CrewMemberRow>;
        if (get().activeCrewId !== crewId || old.crew_id !== crewId) return;
        // Removed by the owner (or the crew was deleted): back to the crew list.
        if (old.user_id === get().userId) return void get().loadCrews().catch(() => {});
        // A crewmate left: their songs went with them.
        void loadCrewData().catch(() => {});
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // Events missed while disconnected are never replayed: refetch.
          if (joinedOnce) void cycle();
          joinedOnce = true;
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          set({ sync: { kind: "error", message: "Live updates paused. Reconnecting…" } });
        }
      });
  }

  /** Upsert rows, at most UPSERT_CHUNK per request. A chunk refused over a
   * bad value (a CHECK or a malformed field) or a limit is retried row by
   * row: bad rows are skipped (one song can't block everyone else's), and at
   * the limit the remaining new rows are left out and counted (they'd all
   * hit it too); nothing else is held back. */
  async function upsertRows<T extends { id: string }>(rows: T[], onlyNew: boolean, table: "songs" | "releases" = "songs"): Promise<UpsertResult<T>> {
    const out: UpsertResult<T> = { ok: [], overLimit: 0 };
    if (!supabase || !rows.length) return out;
    const opts = onlyNew ? { onConflict: "id", ignoreDuplicates: true } : { onConflict: "id" };
    const batches = chunks(rows);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const { error } = await supabase.from(table).upsert(batch, opts);
      if (!error) {
        batch.forEach((r) => rejected.delete(r.id));
        out.ok.push(...batch);
        continue;
      }
      if (!isBadValue(error) && !isQuotaError(error)) throw error;
      let full = false;
      for (const r of batch) {
        if (full) {
          out.overLimit++;
          continue;
        }
        const res = await supabase.from(table).upsert([r], opts);
        if (!res.error) {
          rejected.delete(r.id);
          out.ok.push(r);
        } else if (isBadValue(res.error)) rejected.set(r.id, JSON.stringify(r));
        else if (isQuotaError(res.error)) {
          full = true;
          out.overLimit++;
        } else throw res.error;
      }
      if (full) {
        out.overLimit += batches.slice(i + 1).reduce((n, b) => n + b.length, 0);
        break;
      }
    }
    return out;
  }

  /** Delete my rows by id, a chunk per request. */
  async function deleteMine(table: "songs" | "releases", ids: string[], userId: string) {
    if (!supabase) return;
    for (const part of chunks(ids, 100)) {
      const { error } = await supabase.from(table).delete().in("id", part).eq("owner_id", userId);
      if (error) throw error;
    }
  }

  interface PushResult {
    /** Shared songs the database refused (a bad value). */
    refused: number;
    /** New shares left out at the share limit. */
    overLimit: number;
    releasesOverLimit: number;
  }

  /** Push my shared songs and releases. Order matters at the limits: what I
   * stopped sharing goes first (it makes room), then stage moves and edits
   * of rows already there, then new rows, cut to the room left. */
  async function push(): Promise<PushResult> {
    const sc = scope();
    if (!supabase || !sc || !canSync()) return { refused: 0, overLimit: 0, releasesOverLimit: 0 };
    const app = useAppStore.getState();

    // Shares from before crew/account scoping belong to whoever syncs them first.
    own(() => {
      for (const [path, meta] of Object.entries(app.workspace.songs)) {
        if (meta.shareId && (!meta.shareCrewId || !meta.shareUserId) && sharedHere(meta, sc)) {
          app.updateSong(path, { shareCrewId: sc.crewId, shareUserId: sc.userId });
        }
      }
    });

    // 1. Rows I explicitly stopped sharing.
    const stale = staleShareIds(get().songs, useAppStore.getState().workspace, sc);
    if (stale.length) {
      await deleteMine("songs", stale, sc.userId);
      const gone = new Set(stale);
      stale.forEach((id) => lastPushed.delete(id));
      set({ songs: get().songs.filter((s) => !gone.has(s.id)) });
      own(() => {
        for (const [path, meta] of Object.entries(useAppStore.getState().workspace.songs)) {
          if (meta.shareId && gone.has(meta.shareId)) {
            useAppStore.getState().updateSong(path, { shareId: undefined, shareCrewId: undefined, shareUserId: undefined });
          }
        }
      });
    }

    const { workspace } = useAppStore.getState();
    // 2. Stage: the crew's moves first, then mine, each sent with the version
    // it was made on (a crewmate's move in between makes it a conflict).
    for (const a of stageSync(get().songs, workspace, sc)) {
      if (a.kind !== "push") {
        applyStage(a);
        continue;
      }
      const r = await moveStage(a.id, a.stage, a.base);
      if (r.applied) applyStage({ kind: "settle", path: a.path, at: r.stage_updated_at });
      else applyStage({ kind: "conflict", path: a.path, conflict: { mine: a.stage, theirs: r.stage, by: r.stage_updated_by, at: r.stage_updated_at } });
    }

    const remote = new Map(get().songs.filter((s) => s.owner_id === sc.userId && s.crew_id === sc.crewId).map((s) => [s.id, s]));
    const rows = sharedPayloads(useAppStore.getState().projects, useAppStore.getState().workspace, sc);
    // 3. Details of rows already there, without the stage, only when they
    // differ from what the server has (a restart sends nothing unchanged).
    const changed = rows
      .filter((r) => remote.has(r.id))
      .map(({ stage: _stage, ...rest }) => rest)
      .filter((r) => !songRowMatches(r, remote.get(r.id)!) && lastPushed.get(r.id) !== JSON.stringify(r) && rejected.get(r.id) !== JSON.stringify(r));
    for (const r of (await upsertRows(changed, false)).ok) lastPushed.set(r.id, JSON.stringify(r));
    // 4. New rows (with their stage), never overwriting an existing row,
    // cut to the room left under the share limit.
    const fresh = rows.filter((r) => !remote.has(r.id) && !lastPushed.has(r.id) && rejected.get(r.id) !== JSON.stringify(r));
    const room = Math.max(0, SONGS_PER_CREW - remote.size);
    const sent = await upsertRows(fresh.slice(0, room), true);
    for (const r of sent.ok) lastPushed.set(r.id, JSON.stringify({ ...r, stage: undefined }));
    const overLimit = Math.max(0, fresh.length - room) + sent.overLimit;

    const releasesOverLimit = await pushReleases(sc);
    return { refused: rows.filter((r) => rejected.has(r.id)).length, overLimit, releasesOverLimit };
  }

  /** My shared releases: delete what I unshared or deleted, send what
   * changed, then new ones within the crew's release limit. Returns how many
   * new ones the limit left out. */
  async function pushReleases(sc: ShareScope): Promise<number> {
    if (!supabase) return 0;
    const app = useAppStore.getState();
    // Adopt scope on first sync, like songs.
    own(() => {
      for (const a of app.workspace.albums) {
        if (a.shared && a.shareId && (!a.shareCrewId || !a.shareUserId) && releaseSharedHere(a, sc)) {
          app.updateAlbum(a.id, { shareCrewId: sc.crewId, shareUserId: sc.userId });
        }
      }
    });
    let workspace = useAppStore.getState().workspace;
    const stale = staleReleaseIds(get().releases, workspace, sc);
    const tombs = releaseTombstones(workspace, sc);
    if (stale.length) {
      await deleteMine("releases", stale, sc.userId);
      stale.forEach((id) => lastPushedRelease.delete(id));
      set({ releases: get().releases.filter((r) => !stale.includes(r.id)) });
      own(() => {
        for (const a of useAppStore.getState().workspace.albums) {
          if (a.shareId && stale.includes(a.shareId)) useAppStore.getState().updateAlbum(a.id, { shareId: undefined, shareCrewId: undefined, shareUserId: undefined });
        }
      });
    }
    // Deleted here and gone there (or never pushed): forget the markers.
    const done = tombs.filter((id) => !get().releases.some((r) => r.id === id));
    if (done.length) own(() => useAppStore.getState().clearDeletedReleaseShares(done));

    workspace = useAppStore.getState().workspace;
    const remote = new Map(get().releases.map((r) => [r.id, r]));
    const unsent = (r: { id: string }) => lastPushedRelease.get(r.id) !== JSON.stringify(r) && rejected.get(r.id) !== JSON.stringify(r);
    const payloads = releasePayloads(workspace, sc);
    // One refused release (a bad value) doesn't block the others, like songs.
    const changed = payloads.filter((r) => remote.has(r.id) && !releaseRowMatches(r, remote.get(r.id)!) && unsent(r));
    for (const r of (await upsertRows(changed, false, "releases")).ok) lastPushedRelease.set(r.id, JSON.stringify(r));
    const fresh = payloads.filter((r) => !remote.has(r.id) && unsent(r));
    const room = Math.max(0, RELEASES_PER_CREW - remote.size);
    const sent = await upsertRows(fresh.slice(0, room), false, "releases");
    for (const r of sent.ok) lastPushedRelease.set(r.id, JSON.stringify(r));
    return Math.max(0, fresh.length - room) + sent.overLimit;
  }

  /** One sync cycle (pull, apply, push), never two at once. On sample data
   * or a read-only workspace it only pulls, so the crew board stays fresh. */
  async function cycle(): Promise<void> {
    if (!canPull()) return;
    if (cycleRunning) {
      cycleAgain = true;
      return;
    }
    cycleRunning = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    try {
      do {
        cycleAgain = false;
        changedDuringCycle = false;
        lastCycleMs = Date.now();
        set({ sync: { kind: "syncing" } });
        try {
          let result: PushResult = { refused: 0, overLimit: 0, releasesOverLimit: 0 };
          if (canSync()) forgetGoneCrews();
          const fp = () => {
            const sc = scope();
            const app = useAppStore.getState();
            return sc ? syncFingerprint(app.projects, app.workspace, sc) : null;
          };
          const before = canSync() ? fp() : null;
          if (await loadCrewData()) {
            if (canSync()) {
              applyRemoteMoves();
              result = await push();
              // What this push covered: the state now, unless someone else
              // changed it meanwhile (then the state it started from, so
              // that change still gets its own sync).
              lastFingerprint = changedDuringCycle ? before : fp();
            }
          }
          set({ sync: { kind: "synced", atMs: Date.now(), skipped: result.refused, overLimit: result.overLimit, releasesOverLimit: result.releasesOverLimit } });
        } catch (e) {
          set({ sync: { kind: "error", message: crewErrorMessage(e) } });
          retryTimer = setTimeout(() => void cycle(), RETRY_MS);
          return;
        }
      } while (cycleAgain && canPull());
    } finally {
      cycleRunning = false;
    }
  }

  /** A local change: sync shortly, if it changed anything the crew sees. */
  function localChange(loaded: boolean) {
    if (selfWriting) return;
    if (cycleRunning) changedDuringCycle = true;
    if (loaded) forceNextSync = true;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const sc = scope();
      if (!sc || !canSync()) return;
      const app = useAppStore.getState();
      if (!forceNextSync && lastFingerprint !== null && syncFingerprint(app.projects, app.workspace, sc) === lastFingerprint) return;
      forceNextSync = false;
      void cycle();
    }, PUSH_DELAY_MS);
  }

  function resetSession() {
    subscribe(null);
    if (pushTimer) clearTimeout(pushTimer);
    if (retryTimer) clearTimeout(retryTimer);
    pushTimer = retryTimer = null;
    lastPushed.clear();
    lastPushedRelease.clear();
    rejected.clear();
    lastFingerprint = null;
  }

  return {
    enabled: !!supabase,
    ready: false,
    userId: null,
    email: null,
    crews: [],
    loadError: null,
    activeCrewId: null,
    members: [],
    songs: [],
    columns: [],
    releases: [],
    invite: null,
    invites: [],
    sync: { kind: "idle" },
    removedFrom: [],

    dismissRemoved: () => set({ removedFrom: [] }),

    init: async () => {
      // Once per app run (React runs startup effects twice in development).
      if (initialized) return;
      initialized = true;
      if (!supabase) return set({ ready: true });
      try {
        const { data } = await supabase.auth.getSession();
        set({ userId: data.session?.user.id ?? null, email: data.session?.user.email ?? null });
      } catch {
        // Offline at launch with an expired token: show signed out; the
        // auth listener below picks the session back up when it refreshes.
      }
      set({ ready: true });
      supabase.auth.onAuthStateChange((_event, session) => {
        const userId = session?.user.id ?? null;
        if (userId === get().userId) return;
        resetSession();
        set({ userId, email: session?.user.email ?? null, crews: [], loadError: null, activeCrewId: null, songs: [], members: [], columns: [], releases: [], invite: null, invites: [], sync: { kind: "idle" } });
        // Not awaited: supabase-js forbids awaiting its own calls in this callback.
        if (userId) setTimeout(() => void get().loadCrews().catch(() => {}), 0);
      });
      if (get().userId) await get().loadCrews().catch(() => {});
      // Sync shortly after local changes (statuses, tags, a new scan…), and
      // once the workspace has loaded if it wasn't yet.
      useAppStore.subscribe((state, prev) => {
        const loaded = state.workspaceWritable && !prev.workspaceWritable;
        if (!loaded && state.workspace === prev.workspace && state.projects === prev.projects) return;
        localChange(loaded);
      });
      const wake = () => {
        if (Date.now() - lastCycleMs > FOCUS_MIN_GAP_MS) void cycle();
      };
      window.addEventListener("focus", wake);
      window.addEventListener("online", wake);
      // Safety net for anything realtime missed (it never replays events).
      setInterval(() => {
        if (Date.now() - lastCycleMs > SAFETY_SYNC_MS) void cycle();
      }, SAFETY_SYNC_MS);
    },

    sendCode: async (email) => {
      if (!supabase) return;
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
      if (error) throw new Error(crewErrorMessage(error));
    },

    verifyCode: async (email, code) => {
      if (!supabase) return;
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
      if (error) throw new Error(crewErrorMessage(error));
    },

    signOut: async () => {
      if (!supabase) return;
      writeActiveCrew(null);
      // This device only: the web dashboard or another computer stays signed in.
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw new Error(crewErrorMessage(error));
    },

    loadCrews: async () => {
      if (!supabase || !get().userId) return;
      const { data, error } = await supabase
        .from("crew_members")
        .select("crew_id, role, display_name, crews(name)")
        .eq("user_id", get().userId!);
      if (error) {
        set({ loadError: crewErrorMessage(error) });
        throw new Error(crewErrorMessage(error));
      }
      const crews: CrewSummary[] = (data ?? []).map((r) => ({
        id: r.crew_id as string,
        name: ((r.crews as unknown as { name: string } | null)?.name ?? "Crew") as string,
        role: r.role as CrewSummary["role"],
        displayName: r.display_name as string,
      }));
      set({ crews, loadError: null });
      rememberCrewNames(crews);
      // Shares here with a crew I'm no longer in: forget them (never republished on a rejoin).
      forgetGoneCrews();
      const remembered = readActiveCrew();
      const pick = crews.find((c) => c.id === remembered)?.id ?? crews[0]?.id ?? null;
      await get().selectCrew(pick);
    },

    selectCrew: async (id) => {
      writeActiveCrew(id);
      lastPushed.clear();
      lastPushedRelease.clear();
      rejected.clear();
      lastFingerprint = null;
      set({ activeCrewId: id, invite: null, invites: [], songs: [], members: [], columns: [], releases: [], sync: { kind: "idle" } });
      subscribe(id);
      if (!id) return;
      // On sample data or before the workspace loads, this only pulls (the board still shows).
      return cycle();
    },

    createCrew: async (name, displayName) => {
      if (!supabase) return;
      const { data, error } = await supabase.rpc("create_crew", { p_name: name.trim(), p_display_name: displayName.trim() });
      if (error) throw new Error(crewErrorMessage(error));
      writeActiveCrew(data as string);
      await get().loadCrews();
    },

    joinCrew: async (code, displayName) => {
      if (!supabase) return;
      const { data, error } = await supabase.rpc("join_crew", { p_code: code.trim(), p_display_name: displayName.trim() });
      if (error) throw new Error(crewErrorMessage(error));
      if (!data) throw new Error(crewText("invalidInvite"));
      writeActiveCrew(data as string);
      await get().loadCrews();
    },

    createInvite: async () => {
      if (!supabase || !get().activeCrewId) throw new Error("Choose a crew first.");
      const { data, error } = await supabase.rpc("create_invite", { p_crew: get().activeCrewId, p_max_uses: 10 });
      if (error) throw new Error(crewErrorMessage(error));
      set({ invite: data as string });
      void get().loadInvites().catch(() => {});
      return data as string;
    },

    loadInvites: async () => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId) return;
      // Owners only (row-level security returns nothing to members).
      const { data, error } = await supabase
        .from("crew_invites")
        .select("code, crew_id, expires_at, max_uses, uses")
        .eq("crew_id", crewId)
        .order("expires_at");
      if (error) throw new Error(crewErrorMessage(error));
      if (get().activeCrewId !== crewId) return;
      const now = Date.now();
      set({ invites: (data as CrewInvite[]).filter((i) => Date.parse(i.expires_at) > now && i.uses < i.max_uses) });
    },

    revokeInvite: async (code) => {
      if (!supabase) return;
      const { error } = await supabase.from("crew_invites").delete().eq("code", code);
      if (error) throw new Error(crewErrorMessage(error));
      set({ invites: get().invites.filter((i) => i.code !== code), invite: get().invite === code ? null : get().invite });
    },

    removeMember: async (userId) => {
      const sc = scope();
      if (!supabase || !sc || userId === sc.userId) return;
      // Their shared songs leave with them (after_member_left on the server).
      const { error } = await supabase.from("crew_members").delete().eq("crew_id", sc.crewId).eq("user_id", userId);
      if (error) throw new Error(crewErrorMessage(error));
      await loadCrewData();
    },

    leaveCrew: async () => {
      const sc = scope();
      if (!supabase || !sc) return;
      const { error } = await supabase.from("crew_members").delete().eq("crew_id", sc.crewId).eq("user_id", sc.userId);
      if (error) throw new Error(crewErrorMessage(error));
      await forgetCrew(sc);
    },

    deleteCrew: async (confirmName) => {
      const sc = scope();
      if (!supabase || !sc) return;
      // Everything shared in it goes on the server (delete_crew); nothing local is touched.
      const { error } = await supabase.rpc("delete_crew", { p_crew: sc.crewId, p_confirm_name: confirmName });
      if (error) throw new Error(crewErrorMessage(error));
      await forgetCrew(sc);
    },

    setShared: (paths, shared) => {
      const sc = scope();
      const result: ShareResult = { elsewhere: 0, overLimit: 0 };
      if (!sc) return result;
      const app = useAppStore.getState();
      // A bulk share stops at the share limit (the server would refuse the rest).
      let room = shared ? shareRoom(get().songs, app.workspace, sc) : 0;
      const onServer = new Set(get().songs.filter((s) => s.owner_id === sc.userId).map((s) => s.id));
      for (const path of paths) {
        const meta = useAppStore.getState().workspace.songs[path] ?? {};
        if (shared) {
          // Shared (or being unshared) elsewhere: a new id would strand that
          // row, so leave it; moving it is explicit (moveShares).
          if (shareElsewhere(meta, sc)) {
            result.elsewhere++;
            continue;
          }
          const takesRoom = !sharedHere(meta, sc) && !(meta.shareId && onServer.has(meta.shareId));
          if (takesRoom) {
            if (room <= 0) {
              result.overLimit++;
              continue;
            }
            room--;
          }
          app.updateSong(path, { shared: true, shareId: meta.shareId ?? uuid(), shareCrewId: sc.crewId, shareUserId: sc.userId });
        } else if (sharedHere(meta, sc)) {
          // Keep the id so the next sync knows which row to delete.
          app.updateSong(path, { shared: false, shareCrewId: sc.crewId, shareUserId: sc.userId });
        }
      }
      return result;
    },

    moveShares: async (paths) => {
      const sc = scope();
      if (!supabase || !sc) return;
      const app = useAppStore.getState();
      const moving = paths.filter((p) => shareElsewhere(app.workspace.songs[p], sc)?.mine);
      const oldIds = moving.map((p) => app.workspace.songs[p].shareId!);
      if (!oldIds.length) return;
      // Take it off the other crew's board first (my rows only); share it
      // here only once that worked, so a row is never left behind.
      const { error } = await supabase.from("songs").delete().in("id", oldIds).eq("owner_id", sc.userId);
      if (error) throw new Error(crewErrorMessage(error));
      oldIds.forEach((id) => (lastPushed.delete(id), rejected.delete(id)));
      for (const path of moving) {
        useAppStore.getState().updateSong(path, { shared: true, shareId: uuid(), shareCrewId: sc.crewId, shareUserId: sc.userId });
      }
    },

    moveCrewSong: async (songId, stage) => {
      if (!supabase) return;
      const crewId = get().activeCrewId;
      const before = get().songs;
      const row = before.find((s) => s.id === songId);
      // Optimistic stage only: the version stays the one this move was made on.
      set({ songs: before.map((s) => (s.id === songId ? { ...s, stage } : s)) });
      let r;
      try {
        r = await moveStage(songId, stage, row?.stage_updated_at ?? null);
      } catch (e) {
        // Only this card, and only if this crew is still the one shown.
        if (get().activeCrewId === crewId) set({ songs: restoreSongs(get().songs, before, [songId]) });
        throw new Error(crewErrorMessage(e));
      }
      applyRemoteMoves();
      if (!r.applied) {
        const who = get().members.find((m) => m.user_id === r.stage_updated_by)?.display_name ?? crewText("someone");
        throw new Error(crewText("movedMeanwhile", undefined, { who, stage: statusInfo(r.stage ?? undefined).label }));
      }
    },

    resolveStageConflict: (path, keep) => {
      const app = useAppStore.getState();
      const c = app.workspace.songs[path]?.stageConflict;
      if (!c) return;
      if (keep === "theirs") {
        app.updateSong(path, { status: c.theirs ?? undefined, stageBaseAt: c.at, stagePending: false, stageConflict: undefined, stageUpdatedAtMs: Date.parse(c.at) });
      } else {
        // Mine again, now on top of their version: the next sync sends it.
        app.updateSong(path, { stageBaseAt: c.at, stagePending: true, stageConflict: undefined });
        void cycle();
      }
    },

    syncNow: () => cycle(),

    saveCrewColumns: async (cfg) => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId) return;
      const before = get().columns;
      const payload = columnsPayload(cfg, uuid);
      set({ columns: payload.map((c, i) => ({ ...c, crew_id: crewId, position: i })) });
      const { data, error } = await supabase.rpc("set_crew_columns", { p_crew: crewId, p_columns: payload });
      if (error) {
        if (get().activeCrewId === crewId) set({ columns: before });
        throw new Error(crewErrorMessage(error));
      }
      if (get().activeCrewId === crewId) set({ columns: data as CrewColumnRow[] });
    },

    shareRelease: (albumId, shared) => {
      const sc = scope();
      const app = useAppStore.getState();
      const album = app.workspace.albums.find((a) => a.id === albumId);
      const none: ShareResult = { elsewhere: 0, overLimit: 0 };
      if (!sc || !album) return none;
      const elsewhere = !!album.shareId && ((album.shareCrewId ?? sc.crewId) !== sc.crewId || (album.shareUserId ?? sc.userId) !== sc.userId);
      if (!shared) {
        if (!elsewhere) app.updateAlbum(albumId, { shared: false });
        return none;
      }
      if (elsewhere && album.shared) throw new Error("This release is shared with another crew. Stop sharing it there first.");
      if (elsewhere) {
        // Unshared there but not synced yet: that crew's row is deleted on its
        // next sync (marker); this crew gets its own id, so the two never mix.
        app.markReleaseShareDeleted({ id: album.shareId!, crewId: album.shareCrewId, userId: album.shareUserId });
        app.updateAlbum(albumId, { shared: true, shareId: uuid(), shareCrewId: sc.crewId, shareUserId: sc.userId });
      } else {
        app.updateAlbum(albumId, { shared: true, shareId: album.shareId ?? uuid(), shareCrewId: sc.crewId, shareUserId: sc.userId });
      }
      // The workspace change above starts the sync (debounced), like songs.
      return get().setShared(album.trackPaths, true);
    },

    moveCrewCard: async (songId, columnId, beforeId) => {
      if (!supabase) return;
      const { cfg, onServer } = crewPipeline(get().columns);
      const move = crewMove(get().songs, cfg, onServer, songId, columnId, beforeId);
      if (move.kind === "none") return;
      if (move.kind === "stage") return get().moveCrewSong(songId, move.stage);
      const crewId = get().activeCrewId;
      const before = get().songs;
      const touched = [songId, ...move.renumber.map((r) => r.songId)];
      const stage = cfg.columns.find((c) => c.id === columnId)!.stage;
      // Optimistic: the move carries the version it was made on.
      set({ songs: applyCardMove(before, move, stage) });
      const undo = (e: unknown) => {
        // Only these cards, and only if this crew is still the one shown.
        if (get().activeCrewId === crewId) set({ songs: restoreSongs(get().songs, before, touched) });
        throw new Error(crewErrorMessage(e));
      };
      type Row = { applied: boolean; stage: SongStatus | null; stage_updated_at: string; stage_updated_by: string | null; column_id: string | null; board_order: number | null };
      const call = async (id: string, order: number, expected: string) => {
        const { data, error } = await supabase!.rpc("move_crew_card", { p_song: id, p_column: columnId, p_order: order, p_expected_at: expected });
        if (error) throw error;
        return (Array.isArray(data) ? data[0] : data) as Row;
      };
      let r: Row;
      try {
        r = await call(songId, move.order, move.expectedAt);
      } catch (e) {
        return undo(e);
      }
      if (get().activeCrewId !== crewId) return;
      const settle = (id: string, x: Row) =>
        set({ songs: get().songs.map((s) => (s.id === id ? { ...s, stage: x.stage, stage_updated_at: x.stage_updated_at, stage_updated_by: x.stage_updated_by, column_id: x.column_id, board_order: x.board_order } : s)) });
      settle(songId, r);
      applyRemoteMoves();
      if (!r.applied) {
        const who = get().members.find((m) => m.user_id === r.stage_updated_by)?.display_name ?? crewText("someone");
        if (get().activeCrewId === crewId) set({ songs: restoreSongs(get().songs, before, move.renumber.map((x) => x.songId)) });
        throw new Error(crewText("movedMeanwhile", undefined, { who, stage: statusInfo(r.stage ?? undefined).label }));
      }
      // Place the column's other cards so the card sits where it was dropped
      // (same stage: no version needed), in one request.
      try {
        const placed = await placeCards((fn, args) => supabase!.rpc(fn, args), columnId, move.renumber, (id) => get().songs.find((s) => s.id === id)?.stage_updated_at);
        if (get().activeCrewId === crewId) set({ songs: applyPlaced(get().songs, placed) });
      } catch (e) {
        // Maybe part of the column was placed: show the server's order again.
        void loadCrewData().catch(() => {});
        throw new Error(crewErrorMessage(e));
      }
    },

    renameCrew: async (name) => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId) return;
      // Only the owner's update matches a row (crews_update); select() tells "no row" from success.
      const { data, error } = await supabase.from("crews").update({ name: name.trim() }).eq("id", crewId).select("id");
      if (error) throw new Error(crewErrorMessage(error));
      if (!data?.length) throw new Error(crewText("ownerOnly"));
      const crews = get().crews.map((c) => (c.id === crewId ? { ...c, name: name.trim() } : c));
      set({ crews });
      rememberCrewNames(crews);
    },

    setDisplayName: async (name) => {
      const sc = scope();
      if (!supabase || !sc) return;
      // members_update_self: only my own row, and only display_name.
      const { data, error } = await supabase.from("crew_members").update({ display_name: name.trim() }).eq("crew_id", sc.crewId).eq("user_id", sc.userId).select("user_id");
      if (error) throw new Error(crewErrorMessage(error));
      if (!data?.length) throw new Error(crewErrorMessage(new Error("not in this crew")));
      set({
        crews: get().crews.map((c) => (c.id === sc.crewId ? { ...c, displayName: name.trim() } : c)),
        members: get().members.map((m) => (m.user_id === sc.userId ? { ...m, display_name: name.trim() } : m)),
      });
    },

    transferOwnership: async (userId) => {
      const sc = scope();
      if (!supabase || !sc || userId === sc.userId) return;
      const { error } = await supabase.rpc("transfer_crew_ownership", { p_crew: sc.crewId, p_to: userId });
      if (error) throw new Error(crewErrorMessage(error));
      set({ crews: get().crews.map((c) => (c.id === sc.crewId ? { ...c, role: "member" } : c)) });
      await loadCrewData();
    },

    removeServerShares: async (ids) => {
      const sc = scope();
      if (!supabase || !sc || !ids.length) return;
      // Never a row this computer shares: those go by unsharing the song.
      const known = new Set(Object.values(useAppStore.getState().workspace.songs).flatMap((m) => (m.shareId ? [m.shareId] : [])));
      const drop = ids.filter((id) => !known.has(id));
      try {
        await deleteMine("songs", drop, sc.userId);
      } catch (e) {
        throw new Error(crewErrorMessage(e));
      }
      const gone = new Set(drop);
      drop.forEach((id) => lastPushed.delete(id));
      if (get().activeCrewId === sc.crewId) set({ songs: get().songs.filter((s) => !gone.has(s.id)) });
    },
  };
});

/** In a crew (signed in, with an active crew): crew features show. Otherwise
 * the app is the solo app (Launch Kit included; crew-only UI hidden). */
export function useInCrew(): boolean {
  return useCrewStore((s) => s.enabled && !!s.userId && !!s.activeCrewId && s.crews.some((c) => c.id === s.activeCrewId));
}
