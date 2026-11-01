import { afterEach, describe, expect, it } from "vitest";
import type { BeatFile, ProjectInfo, SavedLead, Workspace } from "../types";
import { applyLang } from "../i18n";
import { fnv1a32, leadHash } from "./digger";
import { MAX_NOTE_CHARS } from "./notes";
import { applyNoteChanges, buildSnapshot, mergeConflict, noteHash, noteLookup, parseChanges, storedNote, type SyncSources } from "./phoneSync";

afterEach(() => applyLang("en"));

const lead = (hash: string, extra: Partial<SavedLead> = {}): SavedLead => ({
  url: "https://youtu.be/example0001",
  title: "Dark piano type beat",
  producer: "Some Producer",
  year: "2024",
  source: "youtube",
  bpm: 140,
  key: "Am",
  traits: [],
  summary: null,
  hash,
  path: `/beats/_leads/${hash}.txt`,
  modifiedAtMs: 1,
  savedOn: "2026-10-20",
  ...extra,
});

const beat = (path: string): BeatFile => ({ path, name: "night drive", folder: "/Users/someone/Beats/Fall pack", sizeBytes: 1, modifiedAtMs: 1 });

const project = (path: string, extra: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({ path, name: path.split("/").pop()!.replace(".flp", ""), isTemplate: false, tempoBpm: 92.5, ...extra }) as ProjectInfo;

function sources(ws: Partial<Workspace> = {}): SyncSources {
  return {
    leads: [lead("aaaa1111")],
    beats: [beat("/Users/someone/Beats/Fall pack/night drive.wav")],
    projects: [
      project("/p/Song one.flp"),
      project("/p/Template.flp", { isTemplate: true }),
      project("/p/Old.flp"),
    ],
    workspace: {
      version: 2,
      songs: { "/p/Song one.flp": { status: "production", notes: "[Hook]\nla la", key: "F#m" }, "/p/Old.flp": { archived: true } },
      albums: [],
      people: [],
      leadNotes: { aaaa1111: "verse idea" },
      beatNotes: {},
      ...ws,
    },
  };
}

describe("note hash", () => {
  it("matches the contract's vectors and isn't trimmed", () => {
    expect(fnv1a32("")).toBe("811c9dc5");
    expect(fnv1a32("a")).toBe("e40c292c");
    expect(noteHash("")).toBe("811c9dc5");
    expect(noteHash("a\n")).not.toBe(noteHash("a"));
    // leadHash still trims, with its own pinned vector.
    expect(leadHash("  https://youtu.be/dQw4w9WgXcQ ")).toBe("8fd69810");
  });

  it("stored notes are capped and blank is empty", () => {
    expect(storedNote("   \n")).toBe("");
    expect(storedNote("x".repeat(MAX_NOTE_CHARS + 5))).toHaveLength(MAX_NOTE_CHARS);
    expect(storedNote(" keep spaces ")).toBe(" keep spaces ");
  });
});

describe("snapshot", () => {
  it("lists saved prods, beats and visible songs with their notes", () => {
    applyLang("en");
    const snap = buildSnapshot(sources(), 42);
    expect(snap.generatedAt).toBe(42);
    expect(snap.items.map((i) => [i.kind, i.id])).toEqual([
      ["prod", "aaaa1111"],
      ["beat", "/Users/someone/Beats/Fall pack/night drive.wav"],
      ["song", "/p/Song one.flp"],
    ]);
    const [prod, b, song] = snap.items;
    expect(prod).toMatchObject({ title: "Dark piano type beat", subtitle: "Some Producer · 2024", bpm: 140, key: "Am", url: "https://youtu.be/example0001", stage: null, note: "verse idea", noteHash: fnv1a32("verse idea") });
    expect(b).toMatchObject({ title: "night drive", subtitle: "Fall pack", url: null, note: "", noteHash: "811c9dc5" });
    expect(song).toMatchObject({ title: "Song one", subtitle: "Production", bpm: 92.5, key: "F#m", stage: "production", note: "[Hook]\nla la" });
  });

  it("a prod without producer or year has an empty subtitle; a Windows beat folder is named", () => {
    const src = sources();
    src.leads = [lead("b", { producer: "", year: "" })];
    src.beats = [{ ...beat("C:\\Beats\\Pack\\x.wav"), folder: "C:\\Beats\\Pack" }];
    const snap = buildSnapshot(src, 0);
    expect(snap.items[0].subtitle).toBe("");
    expect(snap.items[1].subtitle).toBe("Pack");
  });
});

describe("parse changes", () => {
  it("accepts the contract's shape and refuses the rest", () => {
    expect(parseChanges({ changes: [{ kind: "song", id: "/p/a.flp", text: "x", baseHash: "811c9dc5" }] })).toHaveLength(1);
    expect(parseChanges({ changes: [{ kind: "file", id: "x", text: "", baseHash: "" }] })).toBeNull();
    expect(parseChanges({ changes: [{ kind: "song", id: "", text: "", baseHash: "" }] })).toBeNull();
    expect(parseChanges({})).toBeNull();
    expect(parseChanges(null)).toBeNull();
    expect(parseChanges({ changes: Array.from({ length: 501 }, () => ({ kind: "beat", id: "a", text: "", baseHash: "" })) })).toBeNull();
  });
});

describe("apply changes", () => {
  const src = sources();
  const lookup = noteLookup(src);

  it("applies when the base hash matches", () => {
    const { results, writes } = applyNoteChanges([{ kind: "prod", id: "aaaa1111", text: "new verse", baseHash: fnv1a32("verse idea") }], lookup, "Pixel");
    expect(results).toEqual([{ kind: "prod", id: "aaaa1111", status: "applied", note: "new verse", noteHash: fnv1a32("new verse") }]);
    expect(writes).toEqual([{ kind: "prod", id: "aaaa1111", text: "new verse" }]);
  });

  it("keeps both on a conflict, with the contract's marker", () => {
    const { results, writes } = applyNoteChanges([{ kind: "song", id: "/p/Song one.flp", text: "phone hook", baseHash: "deadbeef" }], lookup, "Pixel 9");
    const merged = "[Hook]\nla la\n\n--- from Pixel 9 ---\nphone hook";
    expect(mergeConflict("[Hook]\nla la", "Pixel 9", "phone hook")).toBe(merged);
    expect(results[0]).toEqual({ kind: "song", id: "/p/Song one.flp", status: "conflict", note: merged, noteHash: fnv1a32(merged) });
    expect(writes).toEqual([{ kind: "song", id: "/p/Song one.flp", text: merged }]);
  });

  it("a conflict merges on lines: the original body is never doubled", () => {
    const desktop = "[Verse 1]\nline one\nline two\n\n[Hook]\nhook a";
    // The phone edited the same note: kept its lines, added a verse.
    const phone = "[Verse 1]\nline one\nline two\n\n[Verse 2]\nnew bar\nnew bar 2\n\n\n[Hook]\nhook a";
    const merged = mergeConflict(desktop, "Pixel", phone);
    expect(merged).toBe(`${desktop}\n\n--- from Pixel ---\n[Verse 2]\nnew bar\nnew bar 2`);
    expect(merged.split("line one")).toHaveLength(2);
    // Nothing new on the phone's side: the desktop's note as it is.
    expect(mergeConflict(desktop, "Pixel", "line two\n  hook a  ")).toBe(desktop);
    expect(mergeConflict("", "Pixel", "a\n\n\nb")).toBe("a\n\nb");
  });

  it("a merge past the cap is refused, never cut: nothing written, both texts kept", () => {
    const desktopNote = "d".repeat(MAX_NOTE_CHARS - 10);
    const current = () => desktopNote;
    const phoneText = "a brand new verse line that does not fit";
    const { results, writes } = applyNoteChanges([{ kind: "song", id: "/p/x.flp", text: phoneText, baseHash: "deadbeef" }], current, "Pixel");
    expect(results[0]).toEqual({ kind: "song", id: "/p/x.flp", status: "too long", note: desktopNote, noteHash: fnv1a32(desktopNote) });
    expect(writes).toEqual([]);
    // A clean change longer than the cap (UTF-16 units) is refused too, not cut.
    const long = applyNoteChanges([{ kind: "song", id: "/p/x.flp", text: "😀".repeat(MAX_NOTE_CHARS / 2 + 1), baseHash: fnv1a32(desktopNote) }], current, "Pixel");
    expect(long.results[0].status).toBe("too long");
    expect(long.writes).toEqual([]);
    // Just under: merged in full.
    const fits = applyNoteChanges([{ kind: "song", id: "/p/x.flp", text: "ok", baseHash: "deadbeef" }], () => "d".repeat(100), "P");
    expect(fits.results[0].note).toBe(`${"d".repeat(100)}\n\n--- from P ---\nok`);
  });

  it("a retry of an already applied change, or an empty desktop note, is applied without a merge", () => {
    const retry = applyNoteChanges([{ kind: "prod", id: "aaaa1111", text: "verse idea", baseHash: "00000000" }], lookup, "P");
    expect(retry.results[0].status).toBe("applied");
    expect(retry.writes).toEqual([]);
    const empty = applyNoteChanges([{ kind: "beat", id: src.beats[0].path, text: "bars", baseHash: "00000000" }], lookup, "P");
    expect(empty.results[0]).toMatchObject({ status: "applied", note: "bars" });
  });

  it("unknown, archived and template ids are missing; nothing is written for them", () => {
    const { results, writes } = applyNoteChanges(
      [
        { kind: "song", id: "/p/Old.flp", text: "x", baseHash: "811c9dc5" },
        { kind: "song", id: "/p/Template.flp", text: "x", baseHash: "811c9dc5" },
        { kind: "beat", id: "/elsewhere.wav", text: "x", baseHash: "811c9dc5" },
        { kind: "prod", id: "ffffffff", text: "x", baseHash: "811c9dc5" },
      ],
      lookup,
      "P",
    );
    expect(results.map((r) => r.status)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(results[0]).toMatchObject({ note: "", noteHash: "811c9dc5" });
    expect(writes).toEqual([]);
  });

  it("clearing a note and a second change to the same item in one push", () => {
    const { results, writes } = applyNoteChanges(
      [
        { kind: "prod", id: "aaaa1111", text: "   ", baseHash: fnv1a32("verse idea") },
        { kind: "prod", id: "aaaa1111", text: "again", baseHash: "811c9dc5" },
      ],
      lookup,
      "P",
    );
    expect(results.map((r) => [r.status, r.note])).toEqual([
      ["applied", ""],
      ["applied", "again"],
    ]);
    expect(writes.map((w) => w.text)).toEqual(["", "again"]);
  });
});
