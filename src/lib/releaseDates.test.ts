import { describe, expect, it } from "vitest";
import type { Album, ProjectInfo, SongMeta } from "../types";
import { busyDates, datedRelease, resolveReleaseDate, siblingDate } from "./releaseDates";
import { buildKit, type KitInput } from "./launchKit";

const today = new Date(2026, 9, 13); // Tue 13 Oct 2026: first Friday 28+ days out is 13 Nov
const ep = (releaseDate: string | null = null): Album => ({
  id: "ep",
  title: "Night EP",
  kind: "ep",
  color: "",
  releaseDate,
  notes: "",
  trackPaths: ["/p/1.flp", "/p/2.flp", "/p/3.flp"],
  createdAtMs: 0,
});
const other: Album = { ...ep("2026-11-27"), id: "other", title: "Other", trackPaths: ["/p/x.flp"] };
const pinned = (date: string, pin?: "suggested" | "typed"): SongMeta => ({ launchKit: { edits: { releaseDate: date }, releaseDatePin: pin } });

describe("busy dates (B9)", () => {
  it("never counts the song's own release or its siblings' kits", () => {
    const songs: Record<string, SongMeta> = {
      "/p/1.flp": pinned("2026-11-13", "suggested"),
      "/p/9.flp": pinned("2026-11-20"),
    };
    const busy = busyDates({ path: "/p/2.flp", albums: [ep(), other], songs, crewSongs: [{ id: "c1", release_date: "2026-12-04" }] });
    expect(busy.sort()).toEqual(["2026-11-20", "2026-11-27", "2026-12-04"]);
  });

  it("leaves out the crew rows of the song and its siblings", () => {
    const songs: Record<string, SongMeta> = { "/p/1.flp": { shareId: "s1" }, "/p/2.flp": { shareId: "s2" } };
    const busy = busyDates({ path: "/p/2.flp", albums: [ep()], songs, crewSongs: [{ id: "s1", release_date: "2026-11-13" }, { id: "s2", release_date: "2026-11-20" }] });
    expect(busy).toEqual([]);
  });
});

describe("resolving a kit's release date", () => {
  it("a track of an undated EP takes its siblings' date, not the next free Friday", () => {
    const songs = { "/p/1.flp": pinned("2026-11-13", "suggested") };
    const busy = busyDates({ path: "/p/2.flp", albums: [ep()], songs });
    const date = resolveReleaseDate({ path: "/p/2.flp", meta: {}, albums: [ep()], songs, busy, today });
    expect(date).toMatchObject({ from: "siblings", value: "2026-11-13" });
  });

  it("siblings that disagree: the date most of them have, earliest on a tie", () => {
    const songs = { "/p/1.flp": pinned("2026-11-20"), "/p/3.flp": pinned("2026-11-13") };
    expect(siblingDate([ep()], songs, "/p/2.flp")).toBe("2026-11-13");
    songs["/p/1.flp"] = pinned("2026-11-13");
    expect(siblingDate([ep()], { ...songs, "/p/9.flp": pinned("2026-12-04") }, "/p/2.flp")).toBe("2026-11-13");
  });

  it("a dated release wins over a date pinned from a suggestion (B10)", () => {
    const date = resolveReleaseDate({ path: "/p/1.flp", meta: pinned("2026-11-13", "suggested"), albums: [ep("2026-12-04")], today });
    expect(date).toMatchObject({ from: "release", value: "2026-12-04" });
    expect(datedRelease("/p/1.flp", pinned("2026-11-13", "suggested"), [ep("2026-12-04")])).toBe("2026-12-04");
  });

  it("a typed date that differs from the release's is kept and flagged", () => {
    const date = resolveReleaseDate({ path: "/p/1.flp", meta: pinned("2026-11-13", "typed"), albums: [ep("2026-12-04")], today });
    expect(date).toMatchObject({ from: "pinned", value: "2026-11-13", origin: "typed", mismatch: "2026-12-04" });
    // Pins saved before the origin existed count as typed.
    expect(resolveReleaseDate({ path: "/p/1.flp", meta: pinned("2026-11-13"), albums: [ep("2026-12-04")], today })).toMatchObject({ from: "pinned" });
    expect(datedRelease("/p/1.flp", pinned("2026-11-13", "typed"), [ep("2026-12-04")])).toBe("2026-11-13");
  });

  it("a typed date equal to the release's is no mismatch", () => {
    expect(resolveReleaseDate({ path: "/p/1.flp", meta: pinned("2026-12-04", "typed"), albums: [ep("2026-12-04")], today })).toMatchObject({ from: "release" });
  });
});

describe("the kit shows the same date", () => {
  const project = (path: string) => ({ path, name: "Track", tempoBpm: 140, genre: null, artist: null, trackNames: [], renders: [] }) as unknown as ProjectInfo;
  const input = (path: string, meta: SongMeta, albums: Album[], songs: Record<string, SongMeta> = {}): KitInput => ({
    project: project(path),
    meta,
    people: [],
    albums,
    analysis: null,
    today,
    songs,
    busyDates: busyDates({ path, albums, songs }),
  });
  const dateField = (i: KitInput) => buildKit(i).find((f) => f.id === "releaseDate")!;

  it("five tracks of one EP, exported one after the other, all get one Friday", () => {
    const songs: Record<string, SongMeta> = {};
    const albums = [ep()];
    for (const path of ep().trackPaths) {
      const f = dateField(input(path, songs[path] ?? {}, albums, songs));
      songs[path] = pinned(f.value, "suggested"); // what export does
    }
    expect(new Set(Object.values(songs).map((m) => m.launchKit?.edits?.releaseDate))).toEqual(new Set(["2026-11-13"]));
  });

  it("a suggested pin follows a date set on the release later; a typed one is flagged", () => {
    const suggested = dateField(input("/p/1.flp", pinned("2026-11-13", "suggested"), [ep("2026-12-04")]));
    expect([suggested.value, suggested.source, suggested.check]).toEqual(["2026-12-04", "detected", undefined]);
    const typed = dateField(input("/p/1.flp", pinned("2026-11-13", "typed"), [ep("2026-12-04")]));
    expect([typed.value, typed.source, typed.check?.level]).toEqual(["2026-11-13", "edited", "warn"]);
    expect(typed.check?.message).toMatch(/Night EP.*2026-12-04/);
  });
});
