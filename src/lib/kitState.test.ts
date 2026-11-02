import { describe, expect, it } from "vitest";
import type { Album, FileEntry, KitFieldId, ProjectInfo, SongMeta } from "../types";
import {
  acceptFingerprint,
  exportedFolderName,
  exportFingerprint,
  exportStatus,
  hashString,
  isKitAccepted,
  kitFolderName,
  lastLyricsLanguage,
  pickMaster,
  previousKitFolder,
} from "./kitState";
import { kitChecks, kitGuide } from "./launchKit";

const file = (path: string, modifiedAtMs: number): FileEntry => ({ path, modifiedAtMs, sizeBytes: 1 });
const wav = file("/p/Night Run.wav", 100);
const mp3 = file("/p/Night Run.mp3", 200);
const flac = file("/p/Night Run alt.flac", 50);

describe("master picking (B11)", () => {
  it("prefers the newest lossless render over a newer MP3", () => {
    expect(pickMaster([mp3, wav, flac])?.path).toBe(wav.path);
  });
  it("falls back to the newest when nothing is lossless", () => {
    expect(pickMaster([file("/p/a.mp3", 1), file("/p/b.mp3", 9)])?.path).toBe("/p/b.mp3");
    expect(pickMaster([])).toBeUndefined();
  });
  it("keeps the picked render while it exists", () => {
    expect(pickMaster([mp3, wav, flac], flac.path)?.path).toBe(flac.path);
    expect(pickMaster([mp3, wav], "/p/gone.wav")?.path).toBe(wav.path);
  });
});

const project = (renders: FileEntry[]) => ({ path: "/p/Night Run.flp", name: "Night Run", modifiedAtMs: 10, backups: [], renders }) as unknown as ProjectInfo;
const album: Album = { id: "ep", title: "EP", kind: "ep", color: "", releaseDate: "2026-12-04", notes: "", trackPaths: ["/p/Night Run.flp"], createdAtMs: 0 };

describe("Accepted (W9)", () => {
  const meta = (p: ProjectInfo, albums: Album[], extra: SongMeta = {}): SongMeta => ({
    ...extra,
    launchKit: { acceptedAtMs: 1, acceptedFingerprint: acceptFingerprint(p, extra, albums) },
  });

  it("holds while nothing changed", () => {
    const p = project([wav]);
    expect(isKitAccepted(p, meta(p, [album]), [album])).toBe(true);
  });
  it("is undone by a new master, a credit change or a release date change", () => {
    const p = project([wav]);
    const m = meta(p, [album], { credits: [{ personId: "a", role: "Artist" }] });
    expect(isKitAccepted(project([wav, file("/p/Night Run v2.wav", 300)]), m, [album])).toBe(false);
    expect(isKitAccepted(p, { ...m, credits: [{ personId: "b", role: "Artist" }] }, [album])).toBe(false);
    expect(isKitAccepted(p, m, [{ ...album, releaseDate: "2026-12-11" }])).toBe(false);
  });
  it("covers only what the kit exports: renaming the release or reordering it keeps Accepted", () => {
    const p = project([wav]);
    const two: Album = { ...album, trackPaths: ["/p/Other.flp", "/p/Night Run.flp"] };
    const m = meta(p, [two]);
    expect(isKitAccepted(p, m, [{ ...two, title: "EP renamed" }])).toBe(true);
    expect(isKitAccepted(p, m, [{ ...two, kind: "album" }])).toBe(true);
    expect(isKitAccepted(p, m, [{ ...two, trackPaths: ["/p/Night Run.flp", "/p/Other.flp"] }])).toBe(true);
    expect(isKitAccepted(p, m, [{ ...two, id: "ep2" }])).toBe(true);
    expect(acceptFingerprint(p, {}, [two])).toBe(acceptFingerprint(p, {}, [{ ...two, title: "Other name", kind: "album" }]));
    expect(acceptFingerprint(p, {}, [two])).not.toBe(acceptFingerprint(p, {}, [{ ...two, releaseDate: "2027-01-01" }]));
  });
  it("kits accepted with the first fingerprint stay accepted while it matches", () => {
    const p = project([wav]);
    // The first fingerprint: master, credits, then the release's id, title, kind, date and index.
    const legacy = hashString(JSON.stringify([`${wav.path}|${wav.modifiedAtMs}`, [], ["ep", "EP", "ep", "2026-12-04", 0]]));
    const m: SongMeta = { launchKit: { acceptedAtMs: 1, acceptedFingerprint: legacy } };
    expect(isKitAccepted(p, m, [album])).toBe(true);
    expect(isKitAccepted(p, m, [{ ...album, releaseDate: "2026-12-11" }])).toBe(false);
  });
  it("kits accepted before the fingerprint existed stay accepted", () => {
    expect(isKitAccepted(project([wav]), { launchKit: { acceptedAtMs: 1 } }, [])).toBe(true);
    expect(isKitAccepted(project([wav]), {}, [])).toBe(false);
  });
});

describe("changed since export (W9)", () => {
  const values = (title: string) => [{ id: "title" as KitFieldId, value: title }];
  const snip = [{ label: "Hook 15s", startSec: 30, lengthSec: 15 }];
  const fp = exportFingerprint(values("Night Run"), wav, snip);
  const meta: SongMeta = { launchKit: { exported: { atMs: 1, fingerprint: fp, folder: "Night Run" } } };

  it("is current until a value, the master or a snippet changes", () => {
    expect(exportStatus({}, fp)).toBe("never");
    expect(exportStatus(meta, exportFingerprint(values("Night Run"), wav, snip))).toBe("current");
    expect(exportStatus(meta, exportFingerprint(values("Night Drive"), wav, snip))).toBe("changed");
    expect(exportStatus(meta, exportFingerprint(values("Night Run"), { ...wav, modifiedAtMs: 999 }, snip))).toBe("changed");
    expect(exportStatus(meta, exportFingerprint(values("Night Run"), wav, [{ ...snip[0], startSec: 31 }]))).toBe("changed");
  });
});

describe("kit checks around the master (B11, W10)", () => {
  it("judges freshness on the picked master, not the newest render", () => {
    const p = { ...project([wav, mp3]), modifiedAtMs: 150 } as ProjectInfo;
    expect(kitChecks(p, null, { master: wav }).map((c) => c.message).join(" ")).toMatch(/saved after the master/);
    expect(kitChecks(p, null, { master: mp3 })).toEqual([]);
  });
  it("says when the analysis failed instead of skipping the checks quietly", () => {
    const checks = kitChecks(project([wav]), null, { master: wav, analysisFailed: true });
    expect(checks.map((c) => c.message)).toEqual(["Couldn't read the master: format checks were skipped and no snippets will be cut"]);
  });
  it("asks for the final cover until it's marked ready", () => {
    expect(kitChecks(project([wav]), null, { master: wav, finalCoverDone: false })[0].message).toMatch(/3000 × 3000/);
    expect(kitChecks(project([wav]), null, { master: wav, finalCoverDone: true })).toEqual([]);
  });
  it("the README doesn't promise snippets that weren't cut", () => {
    const guide = kitGuide("en", { title: "x", master: "x.wav", snippets: [] });
    expect(guide.items.map((i) => i.file)).not.toContain("snippets/");
    expect(guide.steps.join(" ")).not.toMatch(/snippets/);
  });
});

describe("lyrics language hint (B12)", () => {
  it("is the language the other kits mostly have, never this song's", () => {
    const songs: Record<string, SongMeta> = {
      a: { launchKit: { edits: { language: "French" } } },
      b: { launchKit: { edits: { language: "French" } } },
      c: { launchKit: { edits: { language: "English" } } },
    };
    expect(lastLyricsLanguage(songs, "c")).toBe("French");
    expect(lastLyricsLanguage({}, "c")).toBeNull();
  });
});

describe("kit folders (round 2)", () => {
  it("records the folder Rust wrote to, which may be disambiguated", () => {
    expect(exportedFolderName("/out/Launch Kits/Night Run (2)", "Night Run")).toBe("Night Run (2)");
    expect(exportedFolderName("C:\\out\\Launch Kits\\Night Run", "Night Run")).toBe("Night Run");
  });
  it("names the recorded folder: the last export, else the saved cover's", () => {
    expect(previousKitFolder(undefined)).toBeNull();
    expect(previousKitFolder({ launchKit: { exported: { atMs: 1, fingerprint: "x", folder: "Night Run (2)" } } })).toBe("Night Run (2)");
    expect(previousKitFolder({ launchKit: { cover: { seed: 1, prompt: "p", variant: 0, savedPath: "/out/Launch Kits/Night Run/cover-concept.jpg" } } })).toBe("Night Run");
  });
  it("finds the kit where it was exported, else under the title", () => {
    expect(kitFolderName({ launchKit: { exported: { atMs: 1, fingerprint: "x", folder: "Old (2)" } } }, "New")).toBe("Old (2)");
    expect(kitFolderName(undefined, "New")).toBe("New");
  });
});
