import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrewSongRow, ProjectInfo, Workspace } from "../types";

// The crew store's push against a fake crew server (review 2026-11, B13-B15):
// the order of a push, the share limit per row, and paging.

const ME = "user-me";
const CREW = "crew-a";

interface Call {
  op: string;
  table: string;
  ids: string[];
}

const server = {
  songs: [] as CrewSongRow[],
  /** The server's share limit (enforce_quotas), per person. */
  limit: Infinity,
  calls: [] as Call[],
  removed: false,
  /** My role in the crew on the server. */
  myRole: "member" as "member" | "owner",
};

function rowFrom(r: Record<string, unknown>): CrewSongRow {
  return { owner_id: ME, stage_updated_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", ...r } as CrewSongRow;
}

/** Enough of supabase-js's query builder for the store's calls. */
function query(table: string) {
  const st: { op: string; rows: Record<string, unknown>[]; ids: string[]; range: [number, number] | null; ignore: boolean } = { op: "select", rows: [], ids: [], range: null, ignore: false };
  const run = () => {
    if (st.op === "select") {
      if (table === "crew_members") return { data: server.removed ? [] : [{ crew_id: CREW, user_id: ME, role: server.myRole, display_name: "Me" }], error: null };
      if (table === "songs") {
        const rows = [...server.songs].sort((a, b) => a.id.localeCompare(b.id));
        server.calls.push({ op: "select", table, ids: [] });
        return { data: st.range ? rows.slice(st.range[0], st.range[1] + 1) : rows, error: null };
      }
      return { data: [], error: null };
    }
    server.calls.push({ op: st.op, table, ids: st.op === "delete" ? st.ids : st.rows.map((r) => r.id as string) });
    if (st.op === "delete") {
      server.songs = server.songs.filter((s) => !st.ids.includes(s.id));
      return { data: null, error: null };
    }
    // upsert: all or nothing, like one statement.
    const fresh = st.rows.filter((r) => !server.songs.some((s) => s.id === r.id));
    if (server.songs.length + fresh.length > server.limit) {
      return { data: null, error: { code: "P0001", message: "share limit reached (2000 songs per person)" } };
    }
    for (const r of st.rows) {
      const i = server.songs.findIndex((s) => s.id === r.id);
      if (i < 0) server.songs.push(rowFrom(r));
      else if (!st.ignore) server.songs[i] = { ...server.songs[i], ...r } as CrewSongRow;
    }
    return { data: null, error: null };
  };
  const b = {
    select: () => b,
    eq: () => b,
    order: () => b,
    range: (from: number, to: number) => ((st.range = [from, to]), b),
    in: (_k: string, ids: string[]) => ((st.ids = ids), b),
    delete: () => ((st.op = "delete"), b),
    upsert: (rows: Record<string, unknown>[], opts?: { ignoreDuplicates?: boolean }) => ((st.op = "upsert"), (st.rows = rows), (st.ignore = !!opts?.ignoreDuplicates), b),
    then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, fail),
  };
  return b;
}

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => query(table),
    rpc: async () => ({ data: null, error: null }),
    removeChannel: async () => {},
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
  },
  crewErrorMessage: (e: unknown) => (e as { message?: string })?.message ?? String(e),
}));
vi.mock("../lib/tauri", () => ({ saveWorkspace: async () => {} }));

const { useCrewStore } = await import("./useCrewStore");
const { useAppStore } = await import("./useAppStore");

const project = (name: string): ProjectInfo => ({ path: `/p/${name}.flp`, name, renders: [], tempoBpm: null }) as unknown as ProjectInfo;

function setLocal(songs: Workspace["songs"], names: string[]) {
  useAppStore.setState({
    demoMode: false,
    settingsLoaded: true,
    workspaceWritable: true,
    projects: names.map(project),
    workspace: { version: 2, songs, albums: [], people: [] },
  });
}

const shared = (id: string) => ({ shared: true, shareId: id, shareCrewId: CREW, shareUserId: ME, status: "creation" as const });

beforeEach(async () => {
  server.songs = [];
  server.limit = Infinity;
  server.calls = [];
  server.removed = false;
  server.myRole = "member";
  useCrewStore.setState({ userId: ME, crews: [{ id: CREW, name: "Crew A", role: "member", displayName: "Me" }], activeCrewId: null, removedFrom: [], nowOwnerOf: [] });
  await useCrewStore.getState().selectCrew(null);
});

describe("crew push", () => {
  it("unshares first, then adds new songs up to the limit, without failing the push", async () => {
    // "old" is on the server and unshared here; "b" and "c" are new; the server takes 1 song.
    server.songs = [rowFrom({ id: "old", crew_id: CREW, title: "Old", stage: "creation", tags: [], credits: [] })];
    server.limit = 1;
    setLocal({ "/p/Old.flp": { shared: false, shareId: "old", shareCrewId: CREW, shareUserId: ME }, "/p/B.flp": shared("b"), "/p/C.flp": shared("c") }, ["Old", "B", "C"]);
    await useCrewStore.getState().selectCrew(CREW);

    const writes = server.calls.filter((c) => c.op !== "select");
    expect(writes[0]).toEqual({ op: "delete", table: "songs", ids: ["old"] });
    expect(server.songs.map((s) => s.id)).toEqual(["b"]);
    const sync = useCrewStore.getState().sync;
    expect(sync.kind).toBe("synced");
    if (sync.kind === "synced") expect(sync.overLimit).toBe(1);
    // The unshared song is now just local.
    expect(useAppStore.getState().workspace.songs["/p/Old.flp"].shareId).toBeUndefined();
  });

  it("doesn't send unchanged rows again (after a restart)", async () => {
    setLocal({ "/p/B.flp": shared("b") }, ["B"]);
    await useCrewStore.getState().selectCrew(CREW);
    expect(server.calls.filter((c) => c.op === "upsert")).toHaveLength(1);
    // A fresh session (nothing in memory) finds the same row on the server.
    server.calls = [];
    await useCrewStore.getState().selectCrew(null);
    await useCrewStore.getState().selectCrew(CREW);
    expect(server.calls.filter((c) => c.op === "upsert")).toHaveLength(0);
  });

  it("reads every page of a big crew", async () => {
    server.songs = Array.from({ length: 2500 }, (_, i) => rowFrom({ id: `s${String(i).padStart(5, "0")}`, crew_id: CREW, owner_id: "someone", title: `T${i}`, stage: null, tags: [], credits: [] }));
    setLocal({}, []);
    await useCrewStore.getState().selectCrew(CREW);
    expect(useCrewStore.getState().songs).toHaveLength(2500);
    expect(server.calls.filter((c) => c.op === "select")).toHaveLength(3);
  });

  it("forgets my shares with a crew I was removed from, and says so once", async () => {
    setLocal({ "/p/B.flp": shared("b") }, ["B"]);
    server.removed = true;
    useCrewStore.setState({ crews: [] });
    await useCrewStore.getState().selectCrew(CREW);
    const meta = useAppStore.getState().workspace.songs["/p/B.flp"];
    expect(meta.shared).toBe(false);
    expect(meta.shareId).toBeUndefined();
    expect(useCrewStore.getState().removedFrom).toHaveLength(1);
    expect(server.calls.filter((c) => c.op === "upsert")).toHaveLength(0);
  });
});

describe("crew review round 2", () => {
  it("picks up my new role without a restart and says so once", async () => {
    setLocal({}, []);
    server.myRole = "owner";
    await useCrewStore.getState().selectCrew(CREW);
    expect(useCrewStore.getState().crews[0].role).toBe("owner");
    expect(useCrewStore.getState().nowOwnerOf).toEqual(["Crew A"]);
    // The next load changes nothing, so nothing is said again.
    useCrewStore.getState().dismissOwnerNotice();
    await useCrewStore.getState().syncNow();
    expect(useCrewStore.getState().nowOwnerOf).toEqual([]);
  });

  it("moves a share to a new version: the same row is updated, never deleted", async () => {
    server.songs = [rowFrom({ id: "s1", crew_id: CREW, title: "Old", stage: "prep", tags: [], credits: [], stage_updated_at: "2026-10-01T00:00:00.000Z" })];
    setLocal({ "/p/Old.flp": { ...shared("s1"), status: "prep", stageBaseAt: "2026-10-01T00:00:00.000Z" }, "/p/New.flp": { status: "creation" } }, ["Old", "New"]);
    await useCrewStore.getState().selectCrew(CREW);
    server.calls = [];
    useCrewStore.getState().moveShareTo("/p/Old.flp", "/p/New.flp");
    const songs = useAppStore.getState().workspace.songs;
    expect(songs["/p/New.flp"]).toMatchObject({ shared: true, shareId: "s1", status: "prep", stagePending: false });
    expect(songs["/p/Old.flp"].shareId).toBeUndefined();
    await useCrewStore.getState().syncNow();
    expect(server.calls.filter((c) => c.op === "delete")).toHaveLength(0);
    expect(server.songs.map((s) => [s.id, s.title])).toEqual([["s1", "New"]]);
  });

  it("remembers crewmates' names for later", async () => {
    setLocal({}, []);
    await useCrewStore.getState().selectCrew(CREW);
    expect(useCrewStore.getState().knownNames[ME]).toBe("Me");
  });
});
