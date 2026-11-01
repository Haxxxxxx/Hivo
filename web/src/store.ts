import { statusInfo } from "@shared/lib/songs";
import { crewText } from "@shared/lib/crewMessages";
import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { CrewColumnRow, CrewInvite, CrewMemberRow, CrewReleaseRow, CrewSongRow, CrewSummary, SongStatus } from "@shared/types";
import { applyCardMove, crewMove, crewPipeline, restoreSongs } from "@shared/lib/crewBoard";
import { applyPlaced, fetchAllPages, isMissingOnServer, placeCards } from "@shared/lib/crewFetch";
import { errorMessage, supabase } from "./supabase";
import { tr } from "@shared/i18n";
import { W } from "./dashboardCopy";

// The web dashboard's state: session, crews, the active crew's shared songs
// and members, live updates. Same rules as the desktop app; no local files.

const ACTIVE_CREW_KEY = "flm-crew-web-active";
const SAFETY_REFRESH_MS = 5 * 60_000;

interface WebState {
  ready: boolean;
  userId: string | null;
  email: string | null;
  crews: CrewSummary[];
  /** Loading the crew list failed (so an empty list doesn't mean "no crews"). */
  loadError: string | null;
  activeCrewId: string | null;
  songs: CrewSongRow[];
  members: CrewMemberRow[];
  /** The crew board's columns, as the owner set them in the app (empty: one per stage). */
  columns: CrewColumnRow[];
  /** Releases shared with the crew (from the app). */
  releases: CrewReleaseRow[];
  error: string | null;
  /** Realtime is connected; false after a channel error or timeout, until it reconnects. */
  live: boolean;

  init: () => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  loadCrews: () => Promise<void>;
  selectCrew: (id: string | null) => Promise<void>;
  createCrew: (name: string, displayName: string) => Promise<void>;
  joinCrew: (code: string, displayName: string) => Promise<void>;
  moveSong: (songId: string, stage: SongStatus | null) => Promise<void>;
  /** Move a card to a column, before another card (or at the end). */
  moveCard: (songId: string, columnId: string, beforeId: string | null) => Promise<void>;

  // Owner tools (the same calls as the desktop app). Row-level security and
  // the server functions check the owner again.
  /** Open invite codes of the active crew (owners only; members get none). */
  invites: CrewInvite[];
  loadInvites: () => Promise<void>;
  createInvite: () => Promise<string>;
  revokeInvite: (code: string) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  renameCrew: (name: string) => Promise<void>;
  /** Owner: make another member the owner (you become a member). */
  transferOwnership: (userId: string) => Promise<void>;
  /** Owner: delete the active crew for everyone (the name typed back). */
  deleteCrew: (confirmName: string) => Promise<void>;
  leaveCrew: () => Promise<void>;
}

let channel: RealtimeChannel | null = null;
let initialized = false;

const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(ACTIVE_CREW_KEY, id);
    else localStorage.removeItem(ACTIVE_CREW_KEY);
  } catch {
    /* convenience only */
  }
};
const remembered = () => {
  try {
    return localStorage.getItem(ACTIVE_CREW_KEY);
  } catch {
    return null;
  }
};

export const useWeb = create<WebState>((set, get) => {
  async function loadCrewData() {
    const id = get().activeCrewId;
    const db = supabase;
    if (!db || !id) return set({ songs: [], members: [], columns: [], releases: [] });
    // Every page (the API stops at 1000 rows per request without saying so).
    const [songs, members, columns, releases] = await Promise.all([
      fetchAllPages<CrewSongRow>((from, to) => db.from("songs").select("*").eq("crew_id", id).order("id").range(from, to)),
      db.from("crew_members").select("*").eq("crew_id", id).order("joined_at"),
      db.from("crew_columns").select("*").eq("crew_id", id).order("position"),
      fetchAllPages<CrewReleaseRow>((from, to) => db.from("releases").select("*").eq("crew_id", id).order("id").range(from, to)),
    ]);
    if (get().activeCrewId !== id) return;
    if (songs.error) throw songs.error;
    if (members.error) throw members.error;
    const memberRows = members.data as CrewMemberRow[];
    if (!memberRows.some((m) => m.user_id === get().userId)) {
      // Removed from the crew (or it was deleted): back to the crew list.
      return void get().loadCrews().catch((e) => set({ error: errorMessage(e) }));
    }
    // Only a crew server without these tables means "none"; anything else is an error.
    if (columns.error && !isMissingOnServer(columns.error)) throw columns.error;
    if (releases.error && !isMissingOnServer(releases.error)) throw releases.error;
    set({
      songs: [...songs.data].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.id.localeCompare(b.id)),
      members: memberRows,
      columns: columns.error ? [] : (columns.data as CrewColumnRow[]),
      releases: releases.error ? [] : releases.data,
      error: null,
    });
  }

  function upsertRelease(row: CrewReleaseRow) {
    if (!row?.id || row.crew_id !== get().activeCrewId) return;
    set({ releases: [...get().releases.filter((r) => r.id !== row.id), row] });
  }

  async function reloadColumns(id: string) {
    if (!supabase || get().activeCrewId !== id) return;
    const { data, error } = await supabase.from("crew_columns").select("*").eq("crew_id", id).order("position");
    if (!error && get().activeCrewId === id) set({ columns: data as CrewColumnRow[] });
  }

  /** Refetch (after a reconnect, or when the tab/phone comes back). */
  let lastRefresh = 0;
  function refresh() {
    if (!get().activeCrewId || Date.now() - lastRefresh < 5000) return;
    lastRefresh = Date.now();
    void loadCrewData().catch((e) => set({ error: errorMessage(e) }));
  }

  function subscribe(id: string | null) {
    if (channel && supabase) void supabase.removeChannel(channel);
    channel = null;
    if (!supabase || !id) return;
    let joinedOnce = false;
    const upsertSong = (row: CrewSongRow) => {
      if (get().activeCrewId !== id || !row?.id) return;
      set({ songs: [row, ...get().songs.filter((s) => s.id !== row.id)] });
    };
    const reloadMembers = () => {
      if (get().activeCrewId === id) void loadCrewData().catch(() => {});
    };
    // Realtime never delivers DELETE events through a filter, and a deleted
    // row arrives with only its primary key: deletes come unfiltered and are
    // matched by key (anything unknown is ignored).
    channel = supabase
      .channel(`web-crew:${id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "songs", filter: `crew_id=eq.${id}` }, (p) => upsertSong(p.new as CrewSongRow))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "songs", filter: `crew_id=eq.${id}` }, (p) => upsertSong(p.new as CrewSongRow))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "songs" }, (p) => {
        const gone = (p.old as { id?: string })?.id;
        if (get().activeCrewId !== id || !gone || !get().songs.some((s) => s.id === gone)) return;
        set({ songs: get().songs.filter((s) => s.id !== gone) });
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "releases", filter: `crew_id=eq.${id}` }, (p) => upsertRelease(p.new as CrewReleaseRow))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "releases", filter: `crew_id=eq.${id}` }, (p) => upsertRelease(p.new as CrewReleaseRow))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "releases" }, (p) => {
        const old = (p.old as { id?: string })?.id;
        if (old && get().releases.some((r) => r.id === old)) set({ releases: get().releases.filter((r) => r.id !== old) });
      })
      // The owner edited the columns in the app: refetch them.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "crew_columns", filter: `crew_id=eq.${id}` }, () => void reloadColumns(id))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "crew_columns", filter: `crew_id=eq.${id}` }, () => void reloadColumns(id))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "crew_columns" }, (p) => {
        const old = (p.old as { id?: string })?.id;
        if (old && get().columns.some((c) => c.id === old)) void reloadColumns(id);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "crew_members", filter: `crew_id=eq.${id}` }, reloadMembers)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "crew_members", filter: `crew_id=eq.${id}` }, reloadMembers)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "crew_members" }, (p) => {
        const old = p.old as Partial<CrewMemberRow>;
        if (get().activeCrewId !== id || old.crew_id !== id) return;
        // Removed by the owner (or the crew was deleted): back to the crew list.
        if (old.user_id === get().userId) return void get().loadCrews().catch((e) => set({ error: errorMessage(e) }));
        reloadMembers();
      })
      .subscribe((status) => {
        // Events missed while disconnected are never replayed: refetch.
        if (status === "SUBSCRIBED") {
          if (joinedOnce) refresh();
          joinedOnce = true;
          set({ live: true });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          set({ live: false });
        }
      });
  }

  return {
    ready: false,
    userId: null,
    email: null,
    crews: [],
    loadError: null,
    activeCrewId: null,
    songs: [],
    columns: [],
    releases: [],
    members: [],
    error: null,
    live: true,
    invites: [],

    init: async () => {
      if (initialized) return;
      initialized = true;
      if (!supabase) return set({ ready: true, error: tr(W).notConnected });
      try {
        const { data } = await supabase.auth.getSession();
        set({ userId: data.session?.user.id ?? null, email: data.session?.user.email ?? null });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
      supabase.auth.onAuthStateChange((_e, session) => {
        const userId = session?.user.id ?? null;
        if (userId === get().userId) return;
        subscribe(null);
        set({ userId, email: session?.user.email ?? null, crews: [], loadError: null, activeCrewId: null, songs: [], members: [], columns: [], releases: [], error: null });
        // Not awaited: supabase-js forbids awaiting its own calls in this callback.
        if (userId) setTimeout(() => void get().loadCrews().catch((e) => set({ error: errorMessage(e) })), 0);
      });
      // A phone left on the board: catch up when it's looked at again.
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());
      window.addEventListener("online", refresh);
      // Safety net for anything realtime missed (it never replays events).
      setInterval(() => document.visibilityState === "visible" && refresh(), SAFETY_REFRESH_MS);
      if (get().userId) await get().loadCrews().catch((e) => set({ error: errorMessage(e) }));
      set({ ready: true });
    },

    sendCode: async (email) => {
      if (!supabase) throw new Error(tr(W).notConnected);
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
      if (error) throw new Error(errorMessage(error));
    },

    verifyCode: async (email, code) => {
      if (!supabase) throw new Error(tr(W).notConnected);
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
      if (error) throw new Error(errorMessage(error));
    },

    signOut: async () => {
      if (!supabase) return;
      remember(null);
      // This browser only: the desktop app and other devices stay signed in.
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw new Error(errorMessage(error));
    },

    loadCrews: async () => {
      if (!supabase || !get().userId) return;
      const { data, error } = await supabase.from("crew_members").select("crew_id, role, display_name, crews(name)").eq("user_id", get().userId!);
      if (error) {
        set({ loadError: errorMessage(error) });
        throw new Error(errorMessage(error));
      }
      const crews: CrewSummary[] = (data ?? []).map((r) => ({
        id: r.crew_id as string,
        name: (r.crews as unknown as { name: string } | null)?.name ?? "Crew",
        role: r.role as CrewSummary["role"],
        displayName: r.display_name as string,
      }));
      set({ crews, loadError: null });
      const pick = crews.find((c) => c.id === remembered())?.id ?? crews[0]?.id ?? null;
      await get().selectCrew(pick);
    },

    selectCrew: async (id) => {
      remember(id);
      set({ activeCrewId: id, songs: [], members: [], columns: [], releases: [], invites: [], error: null });
      subscribe(id);
      if (id) await loadCrewData().catch((e) => set({ error: errorMessage(e) }));
    },

    createCrew: async (name, displayName) => {
      if (!supabase) return;
      const { data, error } = await supabase.rpc("create_crew", { p_name: name.trim(), p_display_name: displayName.trim() });
      if (error) throw new Error(errorMessage(error));
      remember(data as string);
      await get().loadCrews();
    },

    joinCrew: async (code, displayName) => {
      if (!supabase) return;
      const { data, error } = await supabase.rpc("join_crew", { p_code: code.trim(), p_display_name: displayName.trim() });
      if (error) throw new Error(errorMessage(error));
      if (!data) throw new Error(crewText("invalidInvite"));
      remember(data as string);
      await get().loadCrews();
    },

    moveSong: async (songId, stage) => {
      if (!supabase) return;
      const crewId = get().activeCrewId;
      const before = get().songs;
      const row = before.find((s) => s.id === songId);
      // Optimistic stage only: the move carries the version it was made on.
      set({ songs: before.map((s) => (s.id === songId ? { ...s, stage } : s)) });
      const { data, error } = await supabase.rpc("move_song_stage", { p_song: songId, p_stage: stage, p_expected_at: row?.stage_updated_at ?? null });
      if (error) {
        // Only this card, and only if this crew is still the one shown.
        if (get().activeCrewId === crewId) set({ songs: restoreSongs(get().songs, before, [songId]), error: errorMessage(error) });
        throw new Error(errorMessage(error));
      }
      const r = (Array.isArray(data) ? data[0] : data) as { applied: boolean; stage: SongStatus | null; stage_updated_at: string; stage_updated_by: string | null };
      set({ songs: get().songs.map((s) => (s.id === songId ? { ...s, stage: r.stage, stage_updated_at: r.stage_updated_at, stage_updated_by: r.stage_updated_by } : s)) });
      if (!r.applied) {
        // A crewmate moved it just before: theirs stands, and we say so.
        const who = get().members.find((m) => m.user_id === r.stage_updated_by)?.display_name ?? crewText("someone");
        const message = crewText("movedMeanwhile", undefined, { who, stage: statusInfo(r.stage ?? undefined).label });
        set({ error: message });
        throw new Error(message);
      }
      set({ error: null });
    },

    moveCard: async (songId, columnId, beforeId) => {
      if (!supabase) return;
      const { cfg, onServer } = crewPipeline(get().columns);
      const move = crewMove(get().songs, cfg, onServer, songId, columnId, beforeId);
      if (move.kind === "none") return;
      if (move.kind === "stage") return get().moveSong(songId, move.stage);
      const crewId = get().activeCrewId;
      const before = get().songs;
      const touched = [songId, ...move.renumber.map((r) => r.songId)];
      const stage = cfg.columns.find((c) => c.id === columnId)!.stage;
      // Optimistic: the move carries the version it was made on.
      set({ songs: applyCardMove(before, move, stage) });
      const undo = (e: unknown) => {
        set({ error: errorMessage(e) });
        // Only these cards, and only if this crew is still the one shown.
        if (get().activeCrewId === crewId) set({ songs: restoreSongs(get().songs, before, touched) });
        throw new Error(errorMessage(e));
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
      if (!r.applied) {
        const who = get().members.find((m) => m.user_id === r.stage_updated_by)?.display_name ?? crewText("someone");
        const message = crewText("movedMeanwhile", undefined, { who, stage: statusInfo(r.stage ?? undefined).label });
        set({ songs: restoreSongs(get().songs, before, move.renumber.map((x) => x.songId)), error: message });
        throw new Error(message);
      }
      // The column's other cards, in one request.
      try {
        const placed = await placeCards((fn, args) => supabase!.rpc(fn, args), columnId, move.renumber, (id) => get().songs.find((s) => s.id === id)?.stage_updated_at);
        if (get().activeCrewId === crewId) set({ songs: applyPlaced(get().songs, placed) });
      } catch (e) {
        // Maybe part of the column was placed: show the server's order again.
        set({ error: errorMessage(e) });
        void loadCrewData().catch(() => {});
        throw new Error(errorMessage(e));
      }
      set({ error: null });
    },

    loadInvites: async () => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId) return;
      const { data, error } = await supabase
        .from("crew_invites")
        .select("code, crew_id, expires_at, max_uses, uses")
        .eq("crew_id", crewId)
        .order("expires_at");
      if (error) throw new Error(errorMessage(error));
      if (get().activeCrewId !== crewId) return;
      const now = Date.now();
      set({ invites: (data as CrewInvite[]).filter((i) => Date.parse(i.expires_at) > now && i.uses < i.max_uses) });
    },

    createInvite: async () => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId) throw new Error(tr(W).notConnected);
      const { data, error } = await supabase.rpc("create_invite", { p_crew: crewId, p_max_uses: 10 });
      if (error) throw new Error(errorMessage(error));
      await get().loadInvites();
      return data as string;
    },

    revokeInvite: async (code) => {
      if (!supabase) return;
      const { error } = await supabase.from("crew_invites").delete().eq("code", code);
      if (error) throw new Error(errorMessage(error));
      set({ invites: get().invites.filter((i) => i.code !== code) });
    },

    removeMember: async (userId) => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId || userId === get().userId) return;
      // Their shared songs leave with them (after_member_left on the server).
      const { error } = await supabase.from("crew_members").delete().eq("crew_id", crewId).eq("user_id", userId);
      if (error) throw new Error(errorMessage(error));
      await loadCrewData();
    },

    renameCrew: async (name) => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId) return;
      // Only the owner's update matches a row (crews_update); select() tells "no row" from success.
      const { data, error } = await supabase.from("crews").update({ name: name.trim() }).eq("id", crewId).select("id");
      if (error) throw new Error(errorMessage(error));
      if (!data?.length) throw new Error(crewText("ownerOnly"));
      set({ crews: get().crews.map((c) => (c.id === crewId ? { ...c, name: name.trim() } : c)) });
    },

    transferOwnership: async (userId) => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId || userId === get().userId) return;
      const { error } = await supabase.rpc("transfer_crew_ownership", { p_crew: crewId, p_to: userId });
      if (error) throw new Error(errorMessage(error));
      set({ crews: get().crews.map((c) => (c.id === crewId ? { ...c, role: "member" as const } : c)) });
      await loadCrewData();
    },

    deleteCrew: async (confirmName) => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId) return;
      const { error } = await supabase.rpc("delete_crew", { p_crew: crewId, p_confirm_name: confirmName });
      if (error) throw new Error(errorMessage(error));
      remember(null);
      await get().loadCrews();
    },

    leaveCrew: async () => {
      const crewId = get().activeCrewId;
      if (!supabase || !crewId) return;
      const { error } = await supabase.from("crew_members").delete().eq("crew_id", crewId).eq("user_id", get().userId!);
      if (error) throw new Error(errorMessage(error));
      remember(null);
      await get().loadCrews();
    },
  };
});
