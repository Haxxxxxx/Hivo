import { describe, expect, it } from "vitest";
import type { CrewReleaseRow, CrewSongRow, ProjectInfo, Workspace } from "../types";
import {
  chunks,
  goneCrewIds,
  isQuotaError,
  myServerShares,
  releasePayloads,
  releaseRowMatches,
  sharedPayloads,
  shareRoom,
  SONGS_PER_CREW,
  songRowMatches,
  syncFingerprint,
} from "./crewSync";
import { applyPlaced, fetchAllPages, isMissingOnServer, placeCards } from "./crewFetch";

// Push planning after the 2026-11 review (B13-B16, §3 Crew).

const ME = "user-me";
const CREW = "crew-a";
const scope = { crewId: CREW, userId: ME };
const ws = (songs: Workspace["songs"], over: Partial<Workspace> = {}): Workspace => ({ version: 2, songs, albums: [], people: [], ...over });
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
const project = (path: string, over: Partial<ProjectInfo> = {}) =>
  ({ path, name: path.split("/").pop()!.replace(".flp", ""), tempoBpm: 140, renders: [], modifiedAtMs: 0, ...over }) as unknown as ProjectInfo;
const shared = (id: string, over = {}) => ({ shared: true, shareId: id, shareCrewId: CREW, shareUserId: ME, ...over });

describe("quota helpers", () => {
  it("tells a limit refusal from other errors", () => {
    expect(isQuotaError({ code: "P0001", message: "share limit reached (1000 songs per person per crew)" })).toBe(true);
    expect(isQuotaError({ code: "P0001", message: "release limit reached (500 per crew)" })).toBe(true);
    expect(isQuotaError({ code: "P0001", message: "too many open invites: revoke some first" })).toBe(false);
    expect(isQuotaError({ code: "23514", message: "share limit" })).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it("cuts rows into chunks", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).toEqual([]);
  });

  it("counts room left: my rows there plus my shares not sent yet", () => {
    const rows = [row("a"), row("b"), row("x", { owner_id: "someone" })];
    const local = ws({ "/a.flp": shared("a"), "/c.flp": shared("c"), "/d.flp": { shared: false, shareId: "d" } });
    expect(shareRoom(rows, local, scope)).toBe(SONGS_PER_CREW - 3);
    const full = Array.from({ length: SONGS_PER_CREW + 5 }, (_, i) => row(`r${i}`));
    expect(shareRoom(full, ws({}), scope)).toBe(0);
  });
});

describe("unchanged rows aren't sent again", () => {
  it("matches a payload against the server's row (numbers, times, credits)", () => {
    const local = ws({ "/a.flp": shared("a", { tags: ["dark"], key: "Am" }) });
    const [p] = sharedPayloads([project("/a.flp", { modifiedAtMs: Date.parse("2026-10-01T12:00:00Z") } as Partial<ProjectInfo>)], local, scope);
    const { stage: _s, ...details } = p;
    const server = row("a", { title: p.title, bpm: 140, musical_key: "Am", tags: ["dark"], last_saved_at: p.last_saved_at ? p.last_saved_at.replace("Z", "+00:00") : null });
    expect(songRowMatches(details, server)).toBe(true);
    expect(songRowMatches(details, { ...server, tags: ["dark", "slow"] })).toBe(false);
    expect(songRowMatches(details, { ...server, title: "Other" })).toBe(false);
    // The stage never counts (it moves through move_song_stage).
    expect(songRowMatches(details, { ...server, stage: "promotion" })).toBe(true);
  });

  it("matches releases, song ids in order", () => {
    const local = ws({ "/a.flp": shared("a"), "/b.flp": shared("b") }, {
      albums: [{ id: "al", title: "Tape", kind: "ep", color: "#112233", trackPaths: ["/a.flp", "/b.flp"], shared: true, shareId: "R1", shareCrewId: CREW, shareUserId: ME } as Workspace["albums"][number]],
    });
    const [p] = releasePayloads(local, scope);
    const server: CrewReleaseRow = { id: "R1", crew_id: CREW, owner_id: ME, title: "Tape", kind: "ep", color: "#112233", release_date: null, song_ids: ["a", "b"] };
    expect(releaseRowMatches(p, server)).toBe(true);
    expect(releaseRowMatches(p, { ...server, song_ids: ["b", "a"] })).toBe(false);
  });

  it("the fingerprint ignores what the crew never sees", () => {
    const a = ws({ "/a.flp": shared("a", { status: "creation" }) });
    const fp = syncFingerprint([project("/a.flp")], a, scope);
    // A note is local only.
    expect(syncFingerprint([project("/a.flp")], ws({ "/a.flp": shared("a", { status: "creation", notes: "new verse" }) }), scope)).toBe(fp);
    // A stage move, an unshare or a pending move are pushed.
    expect(syncFingerprint([project("/a.flp")], ws({ "/a.flp": shared("a", { status: "prep" }) }), scope)).not.toBe(fp);
    expect(syncFingerprint([project("/a.flp")], ws({ "/a.flp": shared("a", { status: "creation", shared: false }) }), scope)).not.toBe(fp);
    expect(syncFingerprint([project("/a.flp")], ws({ "/a.flp": shared("a", { status: "creation", stagePending: true }) }), scope)).not.toBe(fp);
  });
});

describe("goneCrewIds (removed from a crew)", () => {
  it("finds crews my stamped shares point to that I'm not in", () => {
    const local = ws(
      {
        "/a.flp": shared("a"),
        "/b.flp": { shared: true, shareId: "b", shareCrewId: "crew-b", shareUserId: ME },
        "/c.flp": { shared: true, shareId: "c", shareCrewId: "crew-c", shareUserId: "other-account" },
        "/d.flp": { shared: true, shareId: "d" },
      },
      { deletedReleaseShares: [{ id: "r", crewId: "crew-e", userId: ME }] },
    );
    expect(goneCrewIds(local, ME, [CREW]).sort()).toEqual(["crew-b", "crew-e"]);
    expect(goneCrewIds(local, ME, [CREW, "crew-b", "crew-e"])).toEqual([]);
  });
});

describe("myServerShares (rows nobody here knows)", () => {
  it("lists my rows, unknown first, and flags only unknown rows sharing a title", () => {
    // "a2" has the title of a song shared from here: my other computer may
    // share a different song with that title, so it isn't a duplicate.
    const rows = [row("a", { title: "Night Run" }), row("a2", { title: "night run " }), row("z", { title: "Lost" }), row("x", { owner_id: "someone", title: "Theirs" })];
    const out = myServerShares(rows, ws({ "/a.flp": shared("a") }), scope);
    expect(out.map((r) => [r.id, r.local, r.duplicate])).toEqual([
      ["z", false, false],
      ["a2", false, false],
      ["a", true, false],
    ]);
  });

  it("flags two unknown rows of mine with the same title, never a crewmate's", () => {
    const rows = [row("o1", { title: "Lost" }), row("o2", { title: "lost" }), row("t", { owner_id: "someone", title: "Lost" })];
    const out = myServerShares(rows, ws({}), scope);
    expect(out.map((r) => [r.id, r.duplicate]).sort()).toEqual([
      ["o1", true],
      ["o2", true],
    ]);
  });
});

describe("crewFetch", () => {
  it("reads every page until a short one, once per row", async () => {
    const all = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}` }));
    const asked: [number, number][] = [];
    const { data, error } = await fetchAllPages((from, to) => {
      asked.push([from, to]);
      return Promise.resolve({ data: all.slice(from, to + 1), error: null });
    }, 10);
    expect(error).toBeNull();
    expect(data).toHaveLength(25);
    expect(asked).toEqual([[0, 9], [10, 19], [20, 29]]);
  });

  it("stops at an error", async () => {
    const { error } = await fetchAllPages(() => Promise.resolve({ data: null, error: { code: "42501" } }), 10);
    expect(error).toEqual({ code: "42501" });
  });

  it("only a missing table or function counts as 'none'", () => {
    expect(isMissingOnServer({ code: "PGRST205" })).toBe(true);
    expect(isMissingOnServer({ code: "42P01" })).toBe(true);
    expect(isMissingOnServer({ code: "PGRST202" })).toBe(true);
    expect(isMissingOnServer({ code: "42501" })).toBe(false);
    expect(isMissingOnServer({ message: "Failed to fetch" })).toBe(false);
  });

  it("places a column in one call, or card by card on an older server", async () => {
    const calls: string[] = [];
    const cards = [{ songId: "a", order: 1 }, { songId: "b", order: 2 }];
    const placed = await placeCards(async (fn, args) => {
      calls.push(fn);
      return { data: (args.p_cards as { id: string; order: number }[]).map((c) => ({ id: c.id, column_id: "col", board_order: c.order })), error: null };
    }, "col", cards, () => "v");
    expect(calls).toEqual(["place_crew_cards"]);
    expect(applyPlaced([{ id: "a" }, { id: "c" }], placed)).toEqual([{ id: "a", column_id: "col", board_order: 1 }, { id: "c" }]);

    const old: string[] = [];
    const placedOld = await placeCards(async (fn, args) => {
      old.push(fn);
      if (fn === "place_crew_cards") return { data: null, error: { code: "PGRST202" } };
      return { data: [{ column_id: "col", board_order: args.p_order }], error: null };
    }, "col", cards, (id) => (id === "b" ? undefined : "v"));
    expect(old).toEqual(["place_crew_cards", "move_crew_card"]);
    expect(placedOld).toEqual([{ id: "a", column_id: "col", board_order: 1 }]);

    await expect(placeCards(async () => ({ data: null, error: { code: "42501" } }), "col", cards, () => "v")).rejects.toEqual({ code: "42501" });
    expect(await placeCards(async () => ({ data: null, error: null }), "col", [], () => "v")).toEqual([]);
  });
});
