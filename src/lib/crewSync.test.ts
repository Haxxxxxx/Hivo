import { describe, expect, it } from "vitest";
import type { CrewReleaseRow, CrewSongRow, ProjectInfo, Workspace } from "../types";
import {
  canMoveShare,
  crewCreditsText,
  crewMixdown,
  moveShare,
  nameOf,
  newlyOwned,
  pathsByShareId,
  rememberNames,
  songRowMatches,
  withMyRole,
  orphanedShares,
  shareElsewhere,
  sharedCredits,
  sharedHere,
  sharedPayloads,
  sharedTags,
  sharedTitle,
  staleShareIds,
  stageSync,
  syncNote,
  releasePayloads,
  releaseTracks,
  sortCrewReleases,
  staleReleaseIds,
  unsharedTracks,
} from "./crewSync";
import { applyLang } from "../i18n";

// Regression tests for the crew-sync review (data loss and rewound moves).

const ME = "user-me";
const CREW = "crew-a";
const scope = { crewId: CREW, userId: ME };
const ws = (songs: Workspace["songs"]): Workspace => ({ version: 2, songs, albums: [], people: [] });
const row = (id: string, over: Partial<CrewSongRow> = {}): CrewSongRow => ({
  id,
  crew_id: CREW,
  owner_id: ME,
  title: id,
  stage: "production",
  bpm: null,
  musical_key: null,
  tags: [],
  credits: [],
  release_date: null,
  has_mixdown: false,
  kit_accepted: false,
  last_saved_at: null,
  stage_updated_at: "2026-10-10T00:00:00Z",
  ...over,
});
const project = (path: string) =>
  ({ path, name: path.split("/").pop()!.replace(".flp", ""), tempoBpm: 140, renders: [], modifiedAtMs: 0 }) as unknown as ProjectInfo;

describe("staleShareIds (what gets deleted)", () => {
  it("deletes only songs this workspace explicitly unshared", () => {
    const local = ws({ "/a.flp": { shared: false, shareId: "s1", shareCrewId: CREW, shareUserId: ME } });
    expect(staleShareIds([row("s1")], local, scope)).toEqual(["s1"]);
  });

  it("never deletes rows this workspace doesn't know (second computer, fresh or unloaded workspace)", () => {
    expect(staleShareIds([row("s1"), row("s2")], ws({}), scope)).toEqual([]);
  });

  it("never deletes a crewmate's rows, or rows in another crew", () => {
    const local = ws({ "/a.flp": { shared: false, shareId: "s1" } });
    expect(staleShareIds([row("s1", { owner_id: "someone-else" })], local, scope)).toEqual([]);
    expect(staleShareIds([row("s1", { crew_id: "crew-b" })], local, scope)).toEqual([]);
  });

  it("leaves another account's unshare on this machine alone", () => {
    const local = ws({ "/a.flp": { shared: false, shareId: "s1", shareCrewId: CREW, shareUserId: "other-account" } });
    expect(staleShareIds([row("s1")], local, scope)).toEqual([]);
  });
});

describe("share scope", () => {
  it("a share belongs to one crew and one account (legacy unscoped shares count)", () => {
    expect(sharedHere({ shared: true, shareId: "s", shareCrewId: CREW, shareUserId: ME }, scope)).toBe(true);
    expect(sharedHere({ shared: true, shareId: "s" }, scope)).toBe(true);
    expect(sharedHere({ shared: true, shareId: "s", shareCrewId: "crew-b" }, scope)).toBe(false);
    expect(sharedHere({ shared: true, shareId: "s", shareUserId: "other" }, scope)).toBe(false);
  });

  it("switching crews never pushes another crew's shares", () => {
    const local = ws({ "/a.flp": { shared: true, shareId: "s1", shareCrewId: "crew-b", shareUserId: ME } });
    expect(sharedPayloads([project("/a.flp")], local, scope)).toEqual([]);
  });
});

describe("stage moves", () => {
  it("the regular payload never carries a stage timestamp", () => {
    const local = ws({ "/a.flp": { shared: true, shareId: "s1", status: "prep" } });
    const [p] = sharedPayloads([project("/a.flp")], local, scope);
    expect(p).not.toHaveProperty("stage_updated_at");
  });

  const V1 = "2026-10-10T00:00:00Z";
  const V2 = "2026-10-12T09:30:00.123456+00:00";
  const shared = (meta: Workspace["songs"][string]) => ws({ "/a.flp": { shared: true, shareId: "s1", ...meta } });

  it("a crewmate's move is taken when I have nothing waiting", () => {
    const local = shared({ status: "production", stageBaseAt: V1 });
    expect(stageSync([row("s1", { stage: "prep", stage_updated_at: V2 })], local, scope)).toEqual([{ kind: "adopt", path: "/a.flp", stage: "prep", at: V2, by: null }]);
  });

  it("my waiting move is sent with the version it was made on", () => {
    const local = shared({ status: "release", stageBaseAt: V1, stagePending: true });
    expect(stageSync([row("s1", { stage: "production", stage_updated_at: V1 })], local, scope)).toEqual([
      { kind: "push", path: "/a.flp", id: "s1", stage: "release", base: V1 },
    ]);
  });

  it("a wrong clock can't overwrite a crewmate's move: it's a conflict", () => {
    // Ben's PC is 15 minutes fast: his move is stamped later than Ana's, but
    // it was made on the version before hers.
    const local = shared({ status: "production", stageBaseAt: V1, stagePending: true, stageUpdatedAtMs: Date.parse(V2) + 15 * 60e3 });
    const ana = row("s1", { stage: "prep", stage_updated_at: V2, stage_updated_by: "user-ana" });
    expect(stageSync([ana], local, scope)).toEqual([
      { kind: "conflict", path: "/a.flp", conflict: { mine: "production", theirs: "prep", by: "user-ana", at: V2 } },
    ]);
  });

  it("a slow clock can't lose my move either: it's sent", () => {
    const local = shared({ status: "release", stageBaseAt: V1, stagePending: true, stageUpdatedAtMs: Date.parse(V1) - 3600e3 });
    expect(stageSync([row("s1", { stage: "production", stage_updated_at: V1 })], local, scope)[0].kind).toBe("push");
  });

  it("the same move on both sides just settles", () => {
    const local = shared({ status: "prep", stageBaseAt: V1, stagePending: true });
    expect(stageSync([row("s1", { stage: "prep", stage_updated_at: V2 })], local, scope)).toEqual([{ kind: "settle", path: "/a.flp", at: V2, by: null }]);
    const done = shared({ status: "prep", stageBaseAt: V2 });
    expect(stageSync([row("s1", { stage: "prep", stage_updated_at: "2026-10-12T09:30:00.123Z" })], done, scope)).toEqual([]);
  });

  it("a waiting conflict follows the crew's latest move, and is never pushed", () => {
    const conflict = { mine: "production" as const, theirs: "prep" as const, by: "user-ana", at: V2 };
    const local = shared({ status: "production", stageBaseAt: V1, stagePending: true, stageConflict: conflict });
    expect(stageSync([row("s1", { stage: "prep", stage_updated_at: V2 })], local, scope)).toEqual([]);
    const later = "2026-10-12T10:00:00Z";
    expect(stageSync([row("s1", { stage: "release", stage_updated_at: later, stage_updated_by: "user-cleo" })], local, scope)).toEqual([
      { kind: "conflict", path: "/a.flp", conflict: { mine: "production", theirs: "release", by: "user-cleo", at: later } },
    ]);
  });

  it("songs shared before versions: the old timestamp rule, once", () => {
    const newer = shared({ status: "release", stageUpdatedAtMs: Date.parse("2026-10-13T00:00:00Z") });
    expect(stageSync([row("s1", { stage: "prep", stage_updated_at: V1 })], newer, scope)[0]).toMatchObject({ kind: "push", base: V1 });
    const older = shared({ status: "production", stageUpdatedAtMs: Date.parse("2026-10-01T00:00:00Z") });
    expect(stageSync([row("s1", { stage: "prep", stage_updated_at: V2 })], older, scope)[0]).toMatchObject({ kind: "adopt", stage: "prep" });
  });

  it("only my songs in this crew", () => {
    const local = shared({ status: "release", stageBaseAt: V1, stagePending: true });
    expect(stageSync([row("s1", { owner_id: "someone-else" })], local, scope)).toEqual([]);
    expect(stageSync([row("s1", { crew_id: "crew-b" })], local, scope)).toEqual([]);
  });
});

describe("payload always passes the database checks", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  // Same estimates as pg_column_size, rounded up: text[] and jsonb.
  const tagsSize = (tags: string[]) => 24 + tags.reduce((n, t) => n + 4 + Math.ceil(bytes(t) / 4) * 4, 0);
  const creditsSize = (c: { name: string; role: string }[]) => 16 + c.reduce((n, x) => n + 64 + bytes(x.name) + bytes(x.role), 0);

  it("a whitespace-only or empty title falls back to a real one", () => {
    expect(sharedTitle("   ")).toBe("Untitled");
    expect(sharedTitle("")).toBe("Untitled");
    expect(sharedTitle("  My Song  ")).toBe("My Song");
  });

  it("a long title is cut to 200 characters without splitting an emoji", () => {
    const t = sharedTitle("🔥".repeat(300));
    expect(Array.from(t)).toHaveLength(200);
    expect(t).toBe("🔥".repeat(200));
  });

  it("multi-byte tags stay under the 2048-byte column cap", () => {
    const tags = sharedTags(Array.from({ length: 30 }, () => "音".repeat(40)));
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.length).toBeLessThan(30);
    expect(tagsSize(tags)).toBeLessThanOrEqual(2048);
  });

  it("drops blank tags and caps count and length", () => {
    const tags = sharedTags(["  ", "trap", "x".repeat(100), ...Array.from({ length: 40 }, (_, i) => `t${i}`)]);
    expect(tags[0]).toBe("trap");
    expect(tags[1]).toHaveLength(40);
    expect(tags).toHaveLength(30);
  });

  it("long roles are capped and credits stay under the 8192-byte column cap", () => {
    const credits = sharedCredits(Array.from({ length: 30 }, () => ({ name: "名".repeat(80), role: "役".repeat(500), split: 3 })));
    expect(credits.every((c) => Array.from(c.role).length <= 40 && Array.from(c.name).length <= 60)).toBe(true);
    expect(credits.length).toBeLessThanOrEqual(30);
    expect(creditsSize(credits)).toBeLessThanOrEqual(8192);
  });

  it("a split outside 0-100 is sent as null (the database refuses it)", () => {
    expect(sharedCredits([{ name: "A", role: "", split: 150 }, { name: "B", role: "", split: -5 }, { name: "C", role: "", split: 100 }]).map((c) => c.split)).toEqual([
      null,
      null,
      100,
    ]);
  });

  it("a non-finite split is sent as null", () => {
    expect(sharedCredits([{ name: "Producer", role: "beat", split: Number.NaN }])).toEqual([{ name: "Producer", role: "beat", split: null }]);
  });

  it("an impossible release date is left out", () => {
    const local = ws({ "/a.flp": { shared: true, shareId: "s1", launchKit: { edits: { releaseDate: "2026-02-30" } } } as Workspace["songs"][string] });
    expect(sharedPayloads([project("/a.flp")], local, scope)[0].release_date).toBeNull();
  });
});

describe("shareElsewhere (re-sharing in another crew)", () => {
  it("nothing to move for a song shared here, legacy-unscoped, or never shared", () => {
    expect(shareElsewhere({ shared: true, shareId: "s", shareCrewId: CREW, shareUserId: ME }, scope)).toBeNull();
    expect(shareElsewhere({ shared: true, shareId: "s" }, scope)).toBeNull();
    expect(shareElsewhere({}, scope)).toBeNull();
  });

  it("flags a song shared, or waiting to be unshared, in another crew", () => {
    expect(shareElsewhere({ shared: true, shareId: "s", shareCrewId: "crew-b", shareUserId: ME }, scope)).toEqual({ crewId: "crew-b", mine: true, shared: true });
    expect(shareElsewhere({ shared: false, shareId: "s", shareCrewId: "crew-b", shareUserId: ME }, scope)).toEqual({ crewId: "crew-b", mine: true, shared: false });
  });

  it("knows when the share belongs to another account on this machine", () => {
    expect(shareElsewhere({ shared: true, shareId: "s", shareCrewId: CREW, shareUserId: "other" }, scope)?.mine).toBe(false);
  });
});

describe("orphanedShares", () => {
  it("flags shared songs missing from the library", () => {
    const local = ws({ "/gone.flp": { shared: true, shareId: "s1" }, "/here.flp": { shared: true, shareId: "s2" } });
    expect(orphanedShares([project("/here.flp")], local, scope)).toEqual(["/gone.flp"]);
  });
});

describe("what a shared song sends (allow-list)", () => {
  const p = {
    path: "/Users/someone/Music/Night Run v3.flp",
    name: "Night Run v3",
    tempoBpm: 140,
    renders: ["/Users/someone/Music/Night Run.wav"],
    trackNames: ["Kick - SomePack_Vol3"],
    samples: ["/Users/someone/Samples/kick.wav"],
    modifiedAtMs: Date.UTC(2026, 9, 1),
  } as unknown as ProjectInfo;
  const meta = { shared: true, shareId: "s1", notes: "private lyric", tags: ["dark"], key: "Am", bandlabUrl: "https://www.bandlab.com/track/private-sketch" };

  it("sends exactly the listed fields, never notes, paths, samples or track names", () => {
    const [payload] = sharedPayloads([p], ws({ [p.path]: meta }), scope);
    expect(Object.keys(payload).sort()).toEqual(
      ["bpm", "credits", "crew_id", "has_mixdown", "id", "kit_accepted", "last_saved_at", "mixdown_fresh", "musical_key", "release_date", "stage", "tags", "title"].sort(),
    );
    const all = JSON.stringify(payload);
    for (const leak of ["private lyric", "/Users/", "SomePack", "kick.wav", "bandlab.com"]) expect(all).not.toContain(leak);
    expect(payload.title).toBe("Night Run");
    expect(payload.has_mixdown).toBe(true);
  });

  it("uses the title typed for the crew instead of the file name", () => {
    const [payload] = sharedPayloads([p], ws({ [p.path]: { ...meta, shareTitle: "  Midnight Run  " } }), scope);
    expect(payload.title).toBe("Midnight Run");
    expect(sharedTitle("Night Run v3", "   ")).toBe("Night Run");
  });
});

describe("why nothing syncs (crew panel note)", () => {
  const ok = { demoMode: false, workspaceWritable: true, hasFolders: true, sharedCount: 3 };
  it("is quiet when shared songs sync", () => {
    expect(syncNote(ok)).toBeNull();
  });
  it("names the first blocker", () => {
    expect(syncNote({ ...ok, demoMode: true, sharedCount: 0 })).toMatch(/sample data/);
    expect(syncNote({ ...ok, workspaceWritable: false })).toMatch(/can't save its data/);
    expect(syncNote({ ...ok, hasFolders: false, sharedCount: 0 })).toMatch(/add your projects folder/);
    expect(syncNote({ ...ok, sharedCount: 0 })).toMatch(/stay private until you share them/);
  });
  it("speaks French when the app does", () => {
    applyLang("fr");
    try {
      expect(syncNote({ ...ok, demoMode: true })).toMatch(/^Pas de synchro : .*données d'exemple/);
      expect(syncNote({ ...ok, sharedCount: 0 })).toMatch(/restent privés/);
      expect(syncNote(ok)).toBeNull();
    } finally {
      applyLang("en");
    }
    expect(syncNote({ ...ok, demoMode: true })).toMatch(/sample data/);
  });
});

describe("shared releases", () => {
  const sc = { crewId: "crew1", userId: "me" };
  const album = (over = {}) =>
    ({ id: "a1", title: " Night Tape ", kind: "ep", color: "#c98500", releaseDate: "2026-12-11", notes: "secret", trackPaths: ["/p/A.flp", "/p/B.flp", "/p/C.flp"], createdAtMs: 1, shared: true, shareId: "r1", ...over }) as Workspace["albums"][number];
  const ws = (albums: Workspace["albums"], extra: Partial<Workspace> = {}): Workspace => ({
    version: 2,
    albums,
    people: [],
    songs: {
      "/p/A.flp": { shared: true, shareId: "s-a" },
      "/p/B.flp": { shared: false, shareId: "s-b" },
      "/p/C.flp": { shared: true, shareId: "s-c", shareCrewId: "other" },
    },
    ...extra,
  });

  it("sends title, type, colour, date and only the tracks shared in this crew", () => {
    expect(releasePayloads(ws([album()]), sc)).toEqual([
      { id: "r1", crew_id: "crew1", title: "Night Tape", kind: "ep", color: "#c98500", release_date: "2026-12-11", song_ids: ["s-a"] },
    ]);
    expect(releasePayloads(ws([album({ shared: false })]), sc)).toEqual([]);
    expect(releasePayloads(ws([album({ shareCrewId: "other" })]), sc)).toEqual([]);
    expect(JSON.stringify(releasePayloads(ws([album()]), sc))).not.toMatch(/secret|\/p\//);
  });

  it("lists the tracks still to share", () => {
    expect(unsharedTracks(album(), ws([album()]), sc)).toEqual(["/p/B.flp", "/p/C.flp"]);
  });

  it("deletes a crew release only when unshared or deleted here, never because it's unknown here", () => {
    const rows = [
      { id: "r1", crew_id: "crew1", owner_id: "me" },
      { id: "r2", crew_id: "crew1", owner_id: "me" },
      { id: "r3", crew_id: "crew1", owner_id: "me" },
      { id: "r4", crew_id: "crew1", owner_id: "someone" },
    ] as CrewReleaseRow[];
    const w = ws([album({ shared: false })], { deletedReleaseShares: [{ id: "r2", crewId: "crew1", userId: "me" }, { id: "r4", crewId: "crew1", userId: "me" }] });
    expect(staleReleaseIds(rows, w, sc)).toEqual(["r1", "r2"]);
  });

  it("a release deleted before it was ever synced (no crew on the marker) still leaves the active crew", () => {
    const rows = [{ id: "r9", crew_id: "crew1", owner_id: "me" }, { id: "r9b", crew_id: "crew1", owner_id: "someone" }] as CrewReleaseRow[];
    const w = ws([], { deletedReleaseShares: [{ id: "r9" }, { id: "r9b" }] });
    expect(staleReleaseIds(rows, w, sc)).toEqual(["r9"]);
  });
});

describe("crew releases on screen", () => {
  const r = (id: string, release_date: string | null, song_ids: string[] = []) => ({ id, title: id, release_date, song_ids }) as CrewReleaseRow;
  it("upcoming soonest first, then undated, then past latest first", () => {
    const rows = [r("past1", "2026-01-01"), r("soon", "2026-10-20"), r("later", "2026-12-01"), r("nodate", null), r("past2", "2026-09-01")];
    expect(sortCrewReleases(rows, "2026-10-14").map((x) => x.id)).toEqual(["soon", "later", "nodate", "past2", "past1"]);
  });
  it("tracks in tracklist order, unshared ones left out", () => {
    const songs = [{ id: "b" }, { id: "a" }] as CrewSongRow[];
    expect(releaseTracks(r("x", null, ["a", "gone", "b"]), songs).map((s) => s.id)).toEqual(["a", "b"]);
  });
});


describe("crew review round 2", () => {
  const render = (ms: number) => ({ path: "/m.wav", modifiedAtMs: ms, sizeBytes: 1 });
  const proj = (renders: { modifiedAtMs: number }[], savedMs: number) =>
    ({ path: "/a.flp", name: "a", tempoBpm: null, renders, modifiedAtMs: savedMs, backups: [] }) as unknown as ProjectInfo;
  const local = ws({ "/a.flp": { shared: true, shareId: "s1", shareCrewId: CREW, shareUserId: ME } });

  it("sends whether the mixdown is fresh (none, fresh, stale)", () => {
    expect(sharedPayloads([proj([], 1000)], local, scope)[0].mixdown_fresh).toBeNull();
    expect(sharedPayloads([proj([render(2000)], 1000)], local, scope)[0].mixdown_fresh).toBe(true);
    expect(sharedPayloads([proj([render(500)], 1000)], local, scope)[0].mixdown_fresh).toBe(false);
  });

  it("reads a card's mixdown state, old rows included", () => {
    expect(crewMixdown({ has_mixdown: false, mixdown_fresh: true })).toBe("none");
    expect(crewMixdown({ has_mixdown: true, mixdown_fresh: true })).toBe("fresh");
    expect(crewMixdown({ has_mixdown: true, mixdown_fresh: false })).toBe("stale");
    expect(crewMixdown({ has_mixdown: true })).toBe("unknown");
    expect(crewMixdown({ has_mixdown: true, mixdown_fresh: null })).toBe("unknown");
  });

  it("a server without the freshness column doesn't make every row look changed", () => {
    const [p] = sharedPayloads([proj([render(2000)], 1000)], local, scope);
    const { stage: _s, ...rest } = p;
    const server = row("s1", { title: p.title, has_mixdown: true, last_saved_at: p.last_saved_at, tags: p.tags, credits: p.credits, bpm: null });
    expect(songRowMatches(rest, server)).toBe(true);
    expect(songRowMatches(rest, { ...server, mixdown_fresh: false })).toBe(false);
    expect(songRowMatches(rest, { ...server, mixdown_fresh: true })).toBe(true);
  });

  it("stage sync carries who moved the song", () => {
    const meta = ws({ "/a.flp": { shared: true, shareId: "s1", status: "production", stageBaseAt: "2026-10-10T00:00:00Z" } });
    const r = row("s1", { stage: "prep", stage_updated_at: "2026-10-12T00:00:00Z", stage_updated_by: "user-ana" });
    expect(stageSync([r], meta, scope)).toEqual([{ kind: "adopt", path: "/a.flp", stage: "prep", at: "2026-10-12T00:00:00Z", by: "user-ana" }]);
  });

  it("credits show names and roles, never splits", () => {
    expect(crewCreditsText([{ name: "Ana", role: "beat", split: 50 }, { name: " Ben ", role: "", split: 50 }, { name: " ", role: "x", split: null }])).toBe("Ana (beat) · Ben");
    expect(crewCreditsText(undefined)).toBe("");
  });

  it("remembers names so a former member keeps one", () => {
    const known = rememberNames({}, [{ user_id: "u1", display_name: "Ana" }])!;
    expect(known).toEqual({ u1: "Ana" });
    expect(rememberNames(known, [{ user_id: "u1", display_name: "Ana" }])).toBeNull();
    expect(rememberNames(known, [{ user_id: "u1", display_name: "Ana B" }])).toEqual({ u1: "Ana B" });
    expect(nameOf("u1", [], known)).toBe("Ana");
    expect(nameOf("u1", [{ user_id: "u1", display_name: "Now" }], known)).toBe("Now");
    expect(nameOf("u2", [], known)).toBeUndefined();
  });

  it("finds the crews I just became the owner of", () => {
    const before = [
      { id: "c1", name: "One", role: "member" as const, displayName: "Me" },
      { id: "c2", name: "Two", role: "owner" as const, displayName: "Me" },
    ];
    const after = withMyRole(before, "c1", "owner");
    expect(after[0].role).toBe("owner");
    expect(newlyOwned(before, after).map((c) => c.name)).toEqual(["One"]);
    expect(withMyRole(before, "c2", "owner")).toBe(before);
    expect(withMyRole(before, "c1", undefined)).toBe(before);
    expect(newlyOwned([], after)).toEqual([]);
  });

  it("moves a share to a new version: same id, the old song stops being shared without a delete", () => {
    const w = ws({
      "/old.flp": { shared: true, shareId: "s1", shareCrewId: CREW, shareUserId: ME, status: "prep", stageBaseAt: "2026-10-10T00:00:00Z", shareTitle: "Night" },
      "/new.flp": { status: "creation", notes: "kept" },
      "/other.flp": { shared: true, shareId: "s9", shareCrewId: "crew-b", shareUserId: ME },
    });
    const m = moveShare(w, "/old.flp", "/new.flp", scope)!;
    expect(m.to).toMatchObject({ shared: true, shareId: "s1", shareCrewId: CREW, shareUserId: ME, status: "prep", stageBaseAt: "2026-10-10T00:00:00Z", shareTitle: "Night", stagePending: false });
    expect(m.from.shareId).toBeUndefined();
    expect(m.from.shared).toBeUndefined();
    const after = ws({ "/old.flp": { ...w.songs["/old.flp"], ...m.from }, "/new.flp": { ...w.songs["/new.flp"], ...m.to } });
    expect(staleShareIds([row("s1")], after, scope)).toEqual([]);
    expect(pathsByShareId(after).get("s1")).toBe("/new.flp");
    // Not onto a song with a share of its own, not from a song not shared here, not onto itself.
    expect(moveShare(w, "/old.flp", "/other.flp", scope)).toBeNull();
    expect(moveShare(w, "/new.flp", "/old.flp", scope)).toBeNull();
    expect(moveShare(w, "/old.flp", "/old.flp", scope)).toBeNull();
    expect(canMoveShare(w, "/old.flp", "/brand-new.flp", scope)).toBe(true);
  });
});

describe("an unreadable project keeps its last good values (r3 #9)", () => {
  const shared = { "/a.flp": { shared: true, shareId: "s1", shareCrewId: CREW, shareUserId: ME } };
  it("pushes the server's bpm, not null, while the project can't be read", () => {
    const halfSaved = { ...project("/a.flp"), tempoBpm: null, readError: "its data size doesn't match the file" } as ProjectInfo;
    const remote = new Map([["s1", row("s1", { bpm: 140 })]]);
    expect(sharedPayloads([halfSaved], ws(shared), scope, remote)[0].bpm).toBe(140);
    // Read again: the file's own value.
    expect(sharedPayloads([{ ...project("/a.flp"), tempoBpm: 92 } as ProjectInfo], ws(shared), scope, remote)[0].bpm).toBe(92);
    // A cloud placeholder never read before counts as unread too.
    const inCloud = { ...project("/a.flp"), tempoBpm: null, inCloud: true } as ProjectInfo;
    expect(sharedPayloads([inCloud], ws(shared), scope, remote)[0].bpm).toBe(140);
    // Nothing on the server yet: nothing better than null.
    expect(sharedPayloads([halfSaved], ws(shared), scope)[0].bpm).toBeNull();
  });
});
