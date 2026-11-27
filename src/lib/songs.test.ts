import { describe, expect, it } from "vitest";
import { hasProblems, lastSaveMs, renderFreshness, tagsInUse, tagsOnAny, withTag } from "./songs";
import type { ProjectInfo, SongMeta } from "../types";

const DAY = 86_400_000;

function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    path: "/music/Envy/Envy.flp",
    name: "Envy",
    folder: "/music/Envy",
    sizeBytes: 1,
    modifiedAtMs: 10 * DAY,
    root: "/music",
    genre: null,
    artist: null,
    tempoBpm: null,
    timeSigNum: null,
    timeSigDenom: null,
    flVersion: null,
    isTemplate: false,
    backups: [],
    renders: [],
    recordingsCount: 0,
    recordingsBytes: 0,
    stems: null,
    plugins: [],
    samples: [],
    trackNames: [],
    ...over,
  };
}

const file = (path: string, modifiedAtMs: number) => ({ path, sizeBytes: 1, modifiedAtMs });

describe("lastSaveMs", () => {
  it("counts FL's backup-folder autosaves as saves", () => {
    const p = project({ backups: [file("/music/Envy/Backup/Envy (autosaved at 9h).flp", 30 * DAY)] });
    expect(lastSaveMs(p)).toBe(30 * DAY);
    expect(lastSaveMs(project())).toBe(10 * DAY);
  });
});

describe("renderFreshness", () => {
  it("is stale when the song was saved (or autosaved) after the newest mixdown", () => {
    expect(renderFreshness(project())).toBe("none");
    expect(renderFreshness(project({ renders: [file("/music/Envy/Envy.wav", 12 * DAY)] }))).toBe("fresh");
    expect(renderFreshness(project({ renders: [file("/music/Envy/Envy.wav", 9 * DAY)] }))).toBe("stale");
    // The .flp itself is older than the render, but an autosave isn't.
    const autosaved = project({
      renders: [file("/music/Envy/Envy.wav", 12 * DAY)],
      backups: [file("/music/Envy/Backup/Envy (autosaved at 9h).flp", 15 * DAY)],
    });
    expect(renderFreshness(autosaved)).toBe("stale");
  });
});

describe("hasProblems", () => {
  it("flags missing plugins, missing samples and unreadable projects", () => {
    expect(hasProblems(project())).toBe(false);
    expect(hasProblems(project({ plugins: [{ name: "Serum", vendor: null, installed: false }] }))).toBe(true);
    expect(hasProblems(project({ plugins: [{ name: "Fruity Reeverb", vendor: null, installed: null }] }))).toBe(false);
    expect(hasProblems(project({ samples: [{ path: "D:\\kick.wav", status: "relocated" }] }))).toBe(false);
    expect(hasProblems(project({ samples: [{ path: "D:\\kick.wav", status: "missing" }] }))).toBe(true);
    expect(hasProblems(project({ readError: "not an FL Studio project" }))).toBe(true);
  });
});

describe("tag helpers", () => {
  const songs = {
    a: { tags: ["rap", "drill"] },
    b: { tags: ["rap"] },
    c: {},
  } as unknown as Record<string, SongMeta>;

  it("ranks tags by how often they are used", () => {
    expect(tagsInUse(songs)).toEqual(["rap", "drill"]);
  });

  it("offers every tag on at least one selected song, alphabetically", () => {
    expect(tagsOnAny(songs, ["a", "c"])).toEqual(["drill", "rap"]);
    expect(tagsOnAny(songs, ["c"])).toEqual([]);
  });

  it("returns null when there is nothing to change", () => {
    // A no-op must not rewrite the song's metadata.
    expect(withTag(["rap"], "rap", true)).toBeNull();
    expect(withTag(["rap"], "drill", false)).toBeNull();
    expect(withTag(undefined, "rap", false)).toBeNull();
  });

  it("adds and removes", () => {
    expect(withTag(["rap"], "drill", true)).toEqual(["rap", "drill"]);
    expect(withTag(["rap", "drill"], "rap", false)).toEqual(["drill"]);
    expect(withTag(undefined, "rap", true)).toEqual(["rap"]);
  });
});
