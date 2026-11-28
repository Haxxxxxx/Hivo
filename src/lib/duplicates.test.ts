import { describe, expect, it } from "vitest";
import { commonAbove, distinctiveSamples, duplicateGroups, isStockSample, sampleKey } from "./duplicates";
import type { ProjectInfo } from "../types";

const song = (name: string, samples: string[], over: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    path: `/p/${name}/${name}.flp`,
    sizeBytes: 1000 + name.length,
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


// The screen's first version got both of these wrong on a real library,
// in opposite directions. They are the reason it was rewritten.
describe("what FL's own content does to this", () => {
  const STOCK = [
    String.raw`%FLStudioFactoryData%\Data\Patches\Packs\Legacy\Drums\Dance\Basic 808 Kick.wav`,
    "%FLStudioFactoryData%/Data/Patches/Packs/Legacy/Drums/Dance/Basic 808 Snare.wav",
    "/Applications/FL Studio.app/Contents/Resources/FL/Data/Patches/Packs/Legacy/Drums/Dance/Basic 808 Clap.wav",
    "%FLStudioFactoryData%/Data/Patches/Packs/Legacy/Drums/Dance/Basic 808 Hihat.wav",
  ];

  it("knows FL's stock content from the user's own", () => {
    for (const p of STOCK) expect(isStockSample(p)).toBe(true);
    expect(isStockSample("D:/Music/Envy/vox take 3.wav")).toBe(false);
    // A user folder that merely says "packs" is not FL's factory tree.
    expect(isStockSample("D:/Sample Packs/kick.wav")).toBe(false);
  });

  it("does not call five unrelated projects versions of each other", () => {
    // Observed: five projects grouped as duplicates because each had the
    // default 808 kit dragged in. Four shared "samples", no relationship.
    const library = ["ProdMac", "Project_3", "test bandlab", "Project_2", "Yes"].map((n) => song(n, STOCK));
    expect(duplicateGroups(library)).toEqual([]);
  });

  it("still groups real material shared with the stock kit alongside it", () => {
    // Stock being ignored must not make a genuine pair invisible.
    const vox = ["/s/vox take 3.wav", "/s/vox adlib.wav", "/s/hook dry.wav"];
    const groups = duplicateGroups([song("A", [...STOCK, ...vox]), song("B", [...STOCK, ...vox]), song("C", STOCK)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.name).sort()).toEqual(["A", "B"]);
    expect(groups[0].sharedSamples).toHaveLength(3);
  });
});

describe("copies with nothing in them", () => {
  it("finds the same project saved in three folders", () => {
    // Observed the other way round: Ocean, Ocean copy and Ocean copy 2 are
    // literal folder copies with ZERO samples, so no amount of sample
    // overlap could ever have found them.
    const copy = (folder: string): ProjectInfo =>
      ({
        path: `/p/${folder}/Ocean.flp`,
        name: "Ocean",
        sizeBytes: 48_219,
        modifiedAtMs: 1_000,
        tempoBpm: null,
        samples: [],
        plugins: [],
        renders: [],
        backups: [],
      }) as unknown as ProjectInfo;

    const groups = duplicateGroups([copy("Ocean"), copy("Ocean copy"), copy("Ocean copy 2"), song("Other", [])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].sameFile).toBe(true);
    expect(groups[0].sharedSamples).toEqual([]);
  });

  it("does not group empty projects that merely share a name", () => {
    // A zero-byte project matches every other zero-byte project.
    const empty = (folder: string): ProjectInfo =>
      ({ path: `/p/${folder}/New.flp`, name: "New", sizeBytes: 0, modifiedAtMs: 1, samples: [], plugins: [], renders: [], backups: [] }) as unknown as ProjectInfo;
    expect(duplicateGroups([empty("a"), empty("b")])).toEqual([]);
  });

  it("finds a copy made inside Hivo, which renames the file", () => {
    // Hivo's own Duplicate writes Ocean/Ocean v2.flp — SAME folder, NEW
    // name. Keying a copy on its file name missed every copy made in the
    // app, which is the likeliest way one gets made.
    const base = { ...song("Ocean", []), path: "/p/Ocean/Ocean.flp", sizeBytes: 48_219 } as ProjectInfo;
    const copy = { ...base, path: "/p/Ocean/Ocean v2.flp", name: "Ocean v2" } as ProjectInfo;
    const groups = duplicateGroups([base, copy]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sameFile).toBe(true);
  });

  it("does not call two different projects a copy because they weigh the same", () => {
    // Same byte count is not enough on its own: what is inside has to
    // match too, or an unrelated pair of small projects would group.
    const a = { ...song("A", ["/s/kick.wav"]), sizeBytes: 4096 } as ProjectInfo;
    const b = { ...song("B", ["/s/vox.wav"]), sizeBytes: 4096 } as ProjectInfo;
    expect(duplicateGroups([a, b])).toEqual([]);
  });
});

describe("commonAbove", () => {
  it("scales with the library instead of being a fixed five", () => {
    // Five songs is nearly half of a twelve-song folder and noise in a
    // thousand-song one, which is how stock content slipped through.
    expect(commonAbove(12)).toBe(3);
    expect(commonAbove(1000)).toBe(250);
    // Never below three: a song saved three times is the whole point, and
    // in a small folder those three copies are most of the library.
    expect(commonAbove(0)).toBe(3);
    expect(commonAbove(4)).toBe(3);
  });
});
