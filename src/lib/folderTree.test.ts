import { describe, expect, it } from "vitest";
import { buildFolderTree, folderPath, hasFolderNode, inFolder } from "./folderTree";
import type { ProjectInfo } from "../types";

function song(root: string, folder: string, name: string, over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    path: `${folder}/${name}.flp`,
    name,
    folder,
    root,
    sizeBytes: 1,
    modifiedAtMs: 1,
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

const R = "/Users/me/Prods";

describe("buildFolderTree", () => {
  it("branches on folders holding two or more songs, never on a song's own folder", () => {
    const songs = [
      song(R, `${R}/2026/Winter/Night Drive`, "Night Drive"),
      song(R, `${R}/2026/Winter/Envy`, "Envy", { samples: [{ path: "x", status: "missing" }] }),
      song(R, `${R}/2026/Summer/Sun`, "Sun"),
      song(R, `${R}/2025/Old`, "Old"),
      song(R, `${R}/2025/Older/Older`, "Older"),
      song(R, `${R}/Loose`, "Loose"),
    ];
    const tree = buildFolderTree(songs);
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect([root.name, root.count, root.issues, root.depth]).toEqual(["Prods", 6, 1, 0]);
    expect(root.children.map((c) => `${c.name}:${c.count}`)).toEqual(["2025:2", "2026:3"]);
    const y2026 = root.children[1];
    // Winter has two songs (a node, with the issue); Summer has one (no node).
    expect(y2026.children.map((c) => `${c.name}:${c.count}:${c.issues}:${c.depth}`)).toEqual(["Winter:2:1:2"]);
    // Night Drive's own folder isn't a node.
    expect(y2026.children[0].children).toEqual([]);
  });

  it("is empty when there is nothing to branch into", () => {
    expect(buildFolderTree([])).toEqual([]);
    expect(buildFolderTree([song(R, `${R}/Envy`, "Envy"), song(R, `${R}/Sun`, "Sun")])).toEqual([]);
    // Two roots always branch.
    expect(buildFolderTree([song(R, `${R}/Envy`, "Envy"), song("/Volumes/Crew", "/Volumes/Crew/Kay", "Kay")]).map((n) => n.name)).toEqual(["Prods", "Crew"]);
  });

  it("handles Windows paths and sorts folders naturally", () => {
    const W = "D:\\Prods";
    const songs = [song(W, `${W}\\v10\\A`, "A"), song(W, `${W}\\v10\\B`, "B"), song(W, `${W}\\v9\\C`, "C"), song(W, `${W}\\v9\\D`, "D")];
    const tree = buildFolderTree(songs);
    expect(tree[0].children.map((c) => c.name)).toEqual(["v9", "v10"]);
    expect(inFolder(songs[0], "D:\\Prods\\v10")).toBe(true);
    expect(inFolder(songs[0], "D:/Prods/v1")).toBe(false);
    expect(inFolder(songs[2], `${W}\\v9\\C`)).toBe(true);
  });
});

describe("folderPath", () => {
  it("walks from the root to the folder, stopping at the deepest node", () => {
    const songs = [song(R, `${R}/2026/Winter/Night Drive`, "Night Drive"), song(R, `${R}/2026/Winter/Envy`, "Envy"), song(R, `${R}/2025/Old`, "Old"), song(R, `${R}/2025/Older`, "Older")];
    const tree = buildFolderTree(songs);
    expect(folderPath(tree, `${R}/2026/Winter`).map((n) => n.name)).toEqual(["Prods", "2026", "Winter"]);
    // A song folder below a node: the breadcrumb ends at the node.
    expect(folderPath(tree, `${R}/2026/Winter/Envy`).map((n) => n.name)).toEqual(["Prods", "2026", "Winter"]);
    expect(folderPath(tree, "/elsewhere")).toEqual([]);
  });
});

describe("hasFolderNode", () => {
  it("tells a stale folder filter apart from a live one", () => {
    const songs = [song(R, `${R}/2026/Envy`, "Envy"), song(R, `${R}/2026/Sun`, "Sun"), song(R, `${R}/Loose`, "Loose")];
    const tree = buildFolderTree(songs);
    expect(hasFolderNode(tree, `${R}/2026`)).toBe(true);
    expect(hasFolderNode(tree, `${R}/2026/`)).toBe(true);
    // A song's own folder was never a node; a folder whose songs moved away is gone.
    expect(hasFolderNode(tree, `${R}/2026/Envy`)).toBe(false);
    const after = buildFolderTree([song(R, `${R}/2026/Envy`, "Envy"), song(R, `${R}/Loose`, "Loose")]);
    expect(hasFolderNode(after, `${R}/2026`)).toBe(false);
    // Nothing to branch into: no node at all.
    expect(hasFolderNode([], R)).toBe(false);
  });
});
