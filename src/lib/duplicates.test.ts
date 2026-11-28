import { describe, expect, it } from "vitest";
import { distinctiveSamples, duplicateGroups, sampleKey } from "./duplicates";
import type { ProjectInfo } from "../types";

const song = (name: string, samples: string[], over: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    path: `/p/${name}.flp`,
    name,
    modifiedAtMs: 1_000,
    tempoBpm: 140,
    samples: samples.map((path) => ({ path, status: "found" })),
    plugins: [],
    renders: [],
    backups: [],
    ...over,
  }) as unknown as ProjectInfo;

const VOX = ["/s/vox take 3.wav", "/s/vox adlib.wav", "/s/hook dry.wav"];

describe("sampleKey", () => {
  it("identifies a sample by name, not by where it sits", () => {
    // The same stem copied into another song folder is the same recording;
    // matching on path would miss exactly the case this looks for.
    expect(sampleKey("/a/b/Vox Take 3.wav")).toBe(sampleKey(String.raw`D:\other\VOX TAKE 3.wav`));
  });
});

describe("distinctiveSamples", () => {
  it("ignores what everyone uses", () => {
    // A kick in every song says nothing about two songs being versions.
    const songs = Array.from({ length: 8 }, (_, i) => song(`s${i}`, ["/s/kick.wav", `/s/unique${i}.wav`]));
    songs.push(song("a", ["/s/kick.wav", "/s/shared.wav"]), song("b", ["/s/kick.wav", "/s/shared.wav"]));
    const keys = distinctiveSamples(songs, 5);
    expect(keys.has(sampleKey("/s/shared.wav"))).toBe(true);
    expect(keys.has(sampleKey("/s/kick.wav"))).toBe(false);
  });

  it("ignores a sample only one song uses", () => {
    const keys = distinctiveSamples([song("a", ["/s/only.wav"])], 5);
    expect(keys.size).toBe(0);
  });
});

describe("duplicateGroups", () => {
  it("groups versions that share their distinctive material", () => {
    const groups = duplicateGroups([song("Envy", VOX), song("Envy_v2", VOX), song("Other", ["/s/x.wav"])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.name).sort()).toEqual(["Envy", "Envy_v2"]);
    expect(groups[0].sharedSamples).toHaveLength(3);
  });

  it("puts a song saved three times in ONE group, not three pairs", () => {
    const groups = duplicateGroups([song("A", VOX), song("B", VOX), song("C", VOX)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it("leaves unrelated songs alone", () => {
    const groups = duplicateGroups([song("A", VOX), song("B", ["/s/p.wav", "/s/q.wav", "/s/r.wav"])]);
    expect(groups).toEqual([]);
  });

  it("does not group on one shared sample", () => {
    const groups = duplicateGroups([song("A", ["/s/one.wav", "/s/a2.wav"]), song("B", ["/s/one.wav", "/s/b2.wav"])]);
    expect(groups).toEqual([]);
  });

  it("lists the newest version first", () => {
    const groups = duplicateGroups([
      song("old", VOX, { modifiedAtMs: 1_000 }),
      song("new", VOX, { modifiedAtMs: 9_000 }),
    ]);
    expect(groups[0].members[0].name).toBe("new");
  });

  it("reports what differs, without judging it", () => {
    const groups = duplicateGroups([
      song("A", VOX, { tempoBpm: 140, plugins: [{ name: "Serum", vendor: null, installed: true }] }),
      song("B", VOX, { tempoBpm: 150, plugins: [] }),
    ]);
    const g = groups[0];
    expect(g.sameTempo).toBe(false);
    expect(g.samePlugins).toBe(false);
    expect(g.members.find((m) => m.name === "A")!.pluginsNotInAll).toEqual(["Serum"]);
    // Evidence only: nothing here says which one to keep.
    expect(Object.keys(g)).not.toContain("safeToDelete");
  });

  it("says plugins match when they do", () => {
    const p = [{ name: "Serum", vendor: null, installed: true }];
    const groups = duplicateGroups([song("A", VOX, { plugins: p }), song("B", VOX, { plugins: p })]);
    expect(groups[0].samePlugins).toBe(true);
    expect(groups[0].sameTempo).toBe(true);
  });
});
