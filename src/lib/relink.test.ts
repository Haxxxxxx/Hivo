import { describe, expect, it } from "vitest";
import type { ProjectInfo, Workspace } from "../types";
import { applyRelinks, emptyScanMemory, findRelinks, isNetworkPath, relinksAfterScan, rootRelinks } from "./relink";

const W = ["/music/Projects"];
const proj = (path: string, isTemplate = false) => ({ path, isTemplate }) as ProjectInfo;
const ws = (songs: Workspace["songs"], albums: Workspace["albums"] = []): Workspace => ({ version: 2, songs, albums, people: [] });

describe("findRelinks", () => {
  it("keeps a moved song's record (same file name, new folder)", () => {
    const r = findRelinks([proj("/music/Projects/2026/Night Run/Night Run.flp")], ws({ "/music/Projects/Night Run/Night Run.flp": { status: "prep" } }), W);
    expect(r).toEqual([{ from: "/music/Projects/Night Run/Night Run.flp", to: "/music/Projects/2026/Night Run/Night Run.flp", reason: "moved" }]);
  });

  it("keeps a renamed song's record (only newcomer in the folder)", () => {
    const r = findRelinks([proj("/music/Projects/Night Run/Night Run FINAL.flp")], ws({ "/music/Projects/Night Run/Night Run.flp": { tags: ["dark"] } }), W);
    expect(r).toEqual([{ from: "/music/Projects/Night Run/Night Run.flp", to: "/music/Projects/Night Run/Night Run FINAL.flp", reason: "renamed" }]);
  });

  it("never relinks a song that's still there", () => {
    const p = "/music/Projects/A/A.flp";
    expect(findRelinks([proj(p), proj("/music/Projects/A/A 2.flp")], ws({ [p]: { status: "creation" } }), W)).toEqual([]);
  });

  it("leaves two newcomers in one folder alone", () => {
    const r = findRelinks([proj("/music/Projects/A/A v2.flp"), proj("/music/Projects/A/A v3.flp")], ws({ "/music/Projects/A/A.flp": { status: "creation" } }), W);
    expect(r).toEqual([]);
  });

  it("leaves a file name that turns up twice alone", () => {
    const r = findRelinks([proj("/music/Projects/x/Hook.flp"), proj("/music/Projects/y/Hook.flp")], ws({ "/music/Projects/old/Hook.flp": { status: "creation" } }), W);
    expect(r).toEqual([]);
  });

  it("doesn't treat an unlinked folder or unplugged drive as a move", () => {
    expect(findRelinks([proj("/music/Projects/Night Run.flp")], ws({ "/Volumes/USB/Night Run.flp": { status: "prep" } }), W)).toEqual([]);
  });

  it("never moves a record onto a file that has its own", () => {
    const r = findRelinks(
      [proj("/music/Projects/B/Song.flp")],
      ws({ "/music/Projects/A/Song.flp": { status: "prep" }, "/music/Projects/B/Song.flp": { status: "creation" } }),
      W,
    );
    expect(r).toEqual([]);
  });

  it("matches Windows paths and case differences", () => {
    const r = findRelinks([proj("C:\\Music\\Projects\\New\\Night Run.flp")], ws({ "C:\\Music\\Projects\\Night Run.flp": { status: "prep" } }), ["C:\\Music\\Projects"]);
    expect(r).toHaveLength(1);
  });

  it("never takes a song under an unreachable linked folder for an orphan", () => {
    // D: is unplugged: its Envy must not be handed to the Envy on C:.
    const linked = ["D:\\Music", "C:\\Beats"];
    const record = ws({ "D:\\Music\\Envy\\Envy.flp": { status: "release", notes: "hook" } });
    const elsewhere = [proj("C:\\Beats\\Envy\\Envy.flp")];
    expect(findRelinks(elsewhere, record, linked, ["D:\\Music"])).toEqual([]);
    // Reachable again and really gone: then it's a move.
    expect(findRelinks(elsewhere, record, linked, [])).toHaveLength(1);
  });

  it("never targets templates", () => {
    expect(findRelinks([proj("/music/Projects/A/T.flp", true)], ws({ "/music/Projects/A/A.flp": { status: "creation" } }), W)).toEqual([]);
  });

  it("tells BandLab sketches apart by their song folder", () => {
    // Every sketch's key ends in /BandLab: a gone sketch isn't another one.
    const gone = { "/music/Projects/Old idea/BandLab": { status: "creation" as const } };
    expect(findRelinks([proj("/music/Projects/New idea/BandLab")], ws(gone), W)).toEqual([]);
    // The same song folder moved elsewhere is still followed.
    const moved = findRelinks([proj("/music/Projects/2026/Old idea/BandLab")], ws(gone), W);
    expect(moved).toEqual([{ from: "/music/Projects/Old idea/BandLab", to: "/music/Projects/2026/Old idea/BandLab", reason: "moved" }]);
  });
});

describe("relinksAfterScan (r3 #1: a file missing from one scan isn't moved)", () => {
  const envy = "/music/Projects/Envy/Envy.flp";
  const old = "/music/Projects/Envy/Envy old.flp";
  const record = ws({ [envy]: { status: "release", notes: "hook", shared: true, shareId: "s1" } });

  it("never hands Envy's record to Envy old when Envy drops out of a scan", () => {
    let memory = emptyScanMemory();
    // Both there.
    let r = relinksAfterScan([proj(envy), proj(old)], record, W, [], memory);
    expect(r.relinks).toEqual([]);
    memory = r.memory;
    // FL is saving Envy.flp during the focus rescan: it's missing once.
    r = relinksAfterScan([proj(old)], record, W, [], memory);
    expect(r.relinks).toEqual([]);
    memory = r.memory;
    // Still missing on the next scan: Envy old was there all along, so it's not a rename.
    r = relinksAfterScan([proj(old)], record, W, [], memory);
    expect(r.relinks).toEqual([]);
    // The one-shot rule alone would have moved it (what happened before).
    expect(findRelinks([proj(old)], record, W)).toEqual([{ from: envy, to: old, reason: "renamed" }]);
  });

  it("forgets a file that comes back", () => {
    let r = relinksAfterScan([proj(envy), proj(old)], record, W, [], emptyScanMemory());
    r = relinksAfterScan([proj(old)], record, W, [], r.memory);
    r = relinksAfterScan([proj(envy), proj(old)], record, W, [], r.memory);
    expect(r.memory.missing.size).toBe(0);
    r = relinksAfterScan([proj(old)], record, W, [], r.memory);
    expect(r.relinks).toEqual([]);
  });

  it("moves a real rename after the second scan", () => {
    const final = "/music/Projects/Envy/Envy FINAL.flp";
    let r = relinksAfterScan([proj(envy), proj(old)], record, W, [], emptyScanMemory());
    // Renamed in Finder: Envy.flp gone, Envy FINAL.flp new.
    r = relinksAfterScan([proj(final), proj(old)], record, W, [], r.memory);
    expect(r.relinks).toEqual([]);
    r = relinksAfterScan([proj(final), proj(old)], record, W, [], r.memory);
    expect(r.relinks).toEqual([{ from: envy, to: final, reason: "renamed" }]);
    expect(r.memory.missing.has(envy)).toBe(false);
  });

  it("moves a real move to another folder after the second scan", () => {
    const moved = "/music/Projects/2026/Envy/Envy.flp";
    let r = relinksAfterScan([proj(envy)], record, W, [], emptyScanMemory());
    r = relinksAfterScan([proj(moved)], record, W, [], r.memory);
    expect(r.relinks).toEqual([]);
    r = relinksAfterScan([proj(moved)], record, W, [], r.memory);
    expect(r.relinks).toEqual([{ from: envy, to: moved, reason: "moved" }]);
  });

  it("uses the one-shot rule, after two scans, for a file missing since before the first scan", () => {
    const final = "/music/Projects/Envy/Envy FINAL.flp";
    let r = relinksAfterScan([proj(final)], record, W, [], emptyScanMemory());
    expect(r.relinks).toEqual([]);
    r = relinksAfterScan([proj(final)], record, W, [], r.memory);
    expect(r.relinks).toEqual([{ from: envy, to: final, reason: "renamed" }]);
  });

  it("never counts an unreachable folder's songs as missing", () => {
    let r = relinksAfterScan([proj(envy)], record, W, [], emptyScanMemory());
    r = relinksAfterScan([], record, W, ["/music/Projects"], r.memory);
    r = relinksAfterScan([], record, W, ["/music/Projects"], r.memory);
    expect(r.relinks).toEqual([]);
    expect(r.memory.missing.size).toBe(0);
  });

  it("matches decomposed and composed names (r3 #5)", () => {
    const nfc = "/music/Projects/\u00c9t\u00e9/\u00c9t\u00e9.flp";
    const nfd = "/music/Projects/2026/E\u0301te\u0301/E\u0301te\u0301.flp";
    const r = findRelinks([proj(nfd)], ws({ [nfc]: { status: "prep" } }), W);
    expect(r).toEqual([{ from: nfc, to: nfd, reason: "moved" }]);
  });

  it("knows network paths", () => {
    expect(isNetworkPath("\\\\nas\\share\\Music")).toBe(true);
    expect(isNetworkPath("//nas/share")).toBe(true);
    expect(isNetworkPath("\\\\?\\UNC\\nas\\share")).toBe(true);
    expect(isNetworkPath("Z:\\Music")).toBe(false);
    expect(isNetworkPath("/Volumes/NAS/Music")).toBe(false);
  });
});

describe("applyRelinks", () => {
  it("moves the record (crew share included) and the album slot, keeping the order", () => {
    const album = { id: "al", title: "", kind: "ep" as const, color: "", releaseDate: null, notes: "", trackPaths: ["/a/Other.flp", "/a/Old.flp"], createdAtMs: 0 };
    const out = applyRelinks(ws({ "/a/Old.flp": { status: "prep", shared: true, shareId: "s1" }, "/a/Other.flp": {} }, [album]), [
      { from: "/a/Old.flp", to: "/b/Old.flp", reason: "moved" },
    ]);
    expect(out.songs["/b/Old.flp"]).toEqual({ status: "prep", shared: true, shareId: "s1" });
    expect(out.songs["/a/Old.flp"]).toBeUndefined();
    expect(out.albums[0].trackPaths).toEqual(["/a/Other.flp", "/b/Old.flp"]);
  });

  it("moves a sketch's record to its new .flp (Continue in FL Studio)", () => {
    const album = { id: "al", title: "", kind: "single" as const, color: "", releaseDate: null, notes: "", trackPaths: ["/p/Idea/BandLab"], createdAtMs: 0 };
    const out = applyRelinks(ws({ "/p/Idea/BandLab": { status: "creation", notes: "verse 1", bandlabUrl: "https://www.bandlab.com/x" } }, [album]), [
      { from: "/p/Idea/BandLab", to: "/p/Idea/Idea.flp", reason: "renamed" },
    ]);
    expect(out.songs["/p/Idea/Idea.flp"]).toEqual({ status: "creation", notes: "verse 1", bandlabUrl: "https://www.bandlab.com/x" });
    expect(out.songs["/p/Idea/BandLab"]).toBeUndefined();
    expect(out.albums[0].trackPaths).toEqual(["/p/Idea/Idea.flp"]);
  });

  it("carries the Launch Kit's picked master along with the song's folder (r2 #5)", () => {
    const out = applyRelinks(
      ws({
        "/old/Night Run/Night Run.flp": { launchKit: { master: "/old/Night Run/Night Run.wav", acceptedAtMs: 1, acceptedFingerprint: "abc" } },
        "/old/B/B.flp": { launchKit: { master: "/exports/B.wav" } },
      }),
      [
        { from: "/old/Night Run/Night Run.flp", to: "/new/Night Run/Night Run.flp", reason: "moved" },
        { from: "/old/B/B.flp", to: "/new/B/B.flp", reason: "moved" },
      ],
    );
    expect(out.songs["/new/Night Run/Night Run.flp"].launchKit).toEqual({ master: "/new/Night Run/Night Run.wav", acceptedAtMs: 1, acceptedFingerprint: "abc" });
    expect(out.songs["/new/B/B.flp"].launchKit?.master).toBe("/exports/B.wav");
  });

  it("works with Windows separators and a re-pointed drive", () => {
    const w = ws({ "D:\\Music\\Envy\\Envy.flp": { launchKit: { master: "D:\\Music\\Envy\\Mixdowns\\Envy.wav" } } });
    const out = applyRelinks(w, rootRelinks(w, "D:\\Music", "E:\\Music"));
    expect(out.songs["E:\\Music\\Envy\\Envy.flp"].launchKit?.master).toBe("E:\\Music\\Envy\\Mixdowns\\Envy.wav");
  });

  it("a rename in place keeps the master as it is", () => {
    const out = applyRelinks(ws({ "/p/A/A.flp": { launchKit: { master: "/p/A/A.wav" } } }), [{ from: "/p/A/A.flp", to: "/p/A/A v2.flp", reason: "renamed" }]);
    expect(out.songs["/p/A/A v2.flp"].launchKit?.master).toBe("/p/A/A.wav");
  });

  it("keeps the board's hand-sorted order (r2 #5)", () => {
    const w: Workspace = {
      ...ws({ "/p/A/A.flp": { status: "prep" }, "/p/B/B.flp": { status: "prep" } }),
      pipeline: { columns: [{ id: "c1", name: "Prep", stage: "prep" }], order: { c1: ["/p/B/B.flp", "/p/A/A.flp"], c2: ["/p/C/C.flp"] } },
    };
    const out = applyRelinks(w, [{ from: "/p/A/A.flp", to: "/q/A/A.flp", reason: "moved" }]);
    expect(out.pipeline?.order).toEqual({ c1: ["/p/B/B.flp", "/q/A/A.flp"], c2: ["/p/C/C.flp"] });
    expect(out.pipeline?.columns).toBe(w.pipeline?.columns);
    expect(applyRelinks(ws({ "/p/A/A.flp": {} }), [{ from: "/p/A/A.flp", to: "/q/A/A.flp", reason: "moved" }]).pipeline).toBeUndefined();
  });
});

describe("rootRelinks", () => {
  it("moves every record under a re-pointed folder, keeping the rest of each path", () => {
    const w = ws({ "D:\\Music\\Envy\\Envy.flp": { status: "prep" }, "D:\\Musicals\\X.flp": { status: "creation" }, "C:\\Other\\Y.flp": {} });
    expect(rootRelinks(w, "D:\\Music", "E:\\Music\\")).toEqual([
      { from: "D:\\Music\\Envy\\Envy.flp", to: "E:\\Music\\Envy\\Envy.flp", reason: "moved" },
    ]);
  });

  it("never overwrites a record already at the new path", () => {
    const w = ws({ "/Volumes/A/Music/S.flp": { status: "prep" }, "/Volumes/B/Music/S.flp": { status: "creation" } });
    expect(rootRelinks(w, "/Volumes/A/Music", "/Volumes/B/Music")).toEqual([]);
  });
});
