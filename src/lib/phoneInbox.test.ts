import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import {
  appendIdea,
  bandlabLink,
  canFileElsewhere,
  filedPath,
  removeLoses,
  isOpaqueName,
  duration,
  filterInbox,
  ideaBlock,
  knownTarget,
  memosFor,
  memosForSong,
  relinkedFilings,
  newCount,
  parseTargetKey,
  sketchName,
  songFolder,
  targetKey,
} from "./phoneInbox";
import { MAX_NOTE_CHARS } from "./notes";

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: "dev.x",
  itemId: "x",
  deviceId: "dev",
  phoneName: "Pixel",
  itemType: "idea",
  title: "",
  text: "",
  target: null,
  createdAt: 1,
  updatedAt: 1,
  receivedAt: 1,
  durationMs: null,
  status: "new",
  filedTo: null,
  filedAt: null,
  filedAs: null,
  copiedTo: null,
  files: [],
  ...over,
});

describe("filterInbox", () => {
  const list = [
    item({ id: "a", status: "new", receivedAt: 1 }),
    item({ id: "b", status: "filed", receivedAt: 3 }),
    item({ id: "c", status: "dismissed", receivedAt: 2 }),
    item({ id: "d", status: "new", receivedAt: 4 }),
  ];
  it("shows new, filed or everything, newest first", () => {
    expect(filterInbox(list, "new").map((i) => i.id)).toEqual(["d", "a"]);
    expect(filterInbox(list, "filed").map((i) => i.id)).toEqual(["b"]);
    expect(filterInbox(list, "all").map((i) => i.id)).toEqual(["d", "b", "c", "a"]);
    expect(newCount(list)).toBe(2);
  });
});

describe("appendIdea", () => {
  const idea = { title: "Cold room", text: "hook: lights off", phoneName: "Pixel" };
  it("adds the idea under a marker, after a blank line", () => {
    expect(ideaBlock(idea)).toBe("--- idea from Pixel ---\nCold room\nhook: lights off");
    expect(appendIdea("", idea)).toEqual({ ok: true, text: ideaBlock(idea) });
    expect(appendIdea("[Verse 1]\nline\n\n", idea)).toEqual({ ok: true, text: `[Verse 1]\nline\n\n${ideaBlock(idea)}` });
  });
  it("refuses an empty idea and a note that would be too long", () => {
    expect(appendIdea("x", { title: " ", text: "", phoneName: "P" })).toEqual({ ok: false, reason: "empty" });
    expect(appendIdea("a".repeat(MAX_NOTE_CHARS - 5), idea)).toEqual({ ok: false, reason: "full" });
  });
});

describe("targets", () => {
  it("round-trips kind:id, ids may hold colons and slashes", () => {
    expect(targetKey({ kind: "beat", id: "C:\\Beats\\dark.wav" })).toBe("beat:C:\\Beats\\dark.wav");
    expect(parseTargetKey("beat:C:\\Beats\\dark.wav")).toEqual({ kind: "beat", id: "C:\\Beats\\dark.wav" });
    expect(parseTargetKey("song:/Music/Envy/Envy.flp")).toEqual({ kind: "song", id: "/Music/Envy/Envy.flp" });
    expect(parseTargetKey("/Music/Envy/Voice memos/a.m4a")).toBeNull();
    expect(parseTargetKey(null)).toBeNull();
  });
  it("keeps the phone's target only when the desktop still knows it", () => {
    const options = [{ kind: "song" as const, id: "/s.flp", title: "Envy", detail: "" }];
    expect(knownTarget(item({ target: { kind: "song", id: "/s.flp", title: "old name" } }), options)?.title).toBe("Envy");
    expect(knownTarget(item({ target: { kind: "song", id: "/gone.flp", title: "Gone" } }), options)).toBeNull();
    expect(knownTarget(item({}), options)).toBeNull();
  });
});

describe("sketches", () => {
  const files = [{ name: "Night Run (mix).mp3", size: 1, path: "/i/a", missing: false }];
  it("names a sketch from its title, else its first file", () => {
    expect(sketchName(item({ itemType: "sketch", title: "Cold: room", files }))).toBe("Cold room");
    expect(sketchName(item({ itemType: "sketch", files }))).toBe("Night Run");
    expect(sketchName(item({ itemType: "sketch" }))).toBe("Sketch");
  });
  it("never names a sketch after a link or a provider id (BandLab shares from older phones)", () => {
    const opaque = [{ name: "msf_1000032969.m4a", size: 3, path: "/i/x", missing: false }];
    expect(sketchName(item({ itemType: "sketch", title: "msf 1000032969", files: opaque }))).toBe("Sketch");
    expect(sketchName(item({ itemType: "sketch", title: "https://www.bandlab.com/post/abc", files: opaque }))).toBe("BandLab sketch");
    expect(sketchName(item({ itemType: "sketch", title: "Night Drive on BandLab", files: opaque }))).toBe("Night Drive");
    expect(sketchName(item({ itemType: "sketch", title: "", text: "https://www.bandlab.com/post/abc", files: opaque }))).toBe("BandLab sketch");
    const mixed = [...opaque, { name: "Low_Tide (Mixdown).m4a", size: 3, path: "/i/y", missing: false }];
    expect(sketchName(item({ itemType: "sketch", files: mixed }))).toBe("Low Tide");
  });
  it("spots id-like file names", () => {
    expect(isOpaqueName("msf_1000032969.m4a")).toBe(true);
    expect(isOpaqueName("1000032969.m4a")).toBe(true);
    expect(isOpaqueName("Night Drive.m4a")).toBe(false);
  });
  it("finds a BandLab link shared with it", () => {
    expect(bandlabLink(item({ text: "listen https://www.bandlab.com/track/abc?x=1 ok" }))).toBe("https://www.bandlab.com/track/abc?x=1");
    expect(bandlabLink(item({ text: "http://bandlab.com/x" }))).toBeNull();
  });
});

describe("memos", () => {
  const memo = (filedTo: string) => item({ id: filedTo, itemType: "memo", status: "filed", filedTo });
  it("lists the memos copied into a song's Voice memos folder", () => {
    const list = [memo("/Music/Envy/Voice memos/Flow.m4a"), memo("/Music/Other/Voice memos/a.m4a"), memo("beat:/Beats/a.wav")];
    expect(memosForSong(list, "/Music/Envy/Envy.flp").map((i) => i.id)).toEqual(["/Music/Envy/Voice memos/Flow.m4a"]);
    // A sketch is keyed by its BandLab folder: same song folder.
    expect(songFolder("/Music/Envy/BandLab")).toBe("/Music/Envy");
    expect(memosForSong(list, "/Music/Envy/BandLab").length).toBe(1);
    expect(memosForSong([memo("C:\\Music\\Envy\\Voice memos\\a.m4a")], "C:\\Music\\Envy\\Envy.flp").length).toBe(1);
    expect(memosFor(list, "beat", "/Beats/a.wav").map((i) => i.id)).toEqual(["beat:/Beats/a.wav"]);
  });
  it("matches memos by song key, so songs sharing a folder each list their own", () => {
    const list = [memo("song:/Music/Projects/Envy.flp"), memo("song:/Music/Projects/Other.flp")];
    expect(memosForSong(list, "/Music/Projects/Envy.flp").map((i) => i.id)).toEqual(["song:/Music/Projects/Envy.flp"]);
    expect(memosForSong(list, "/Music/Projects/Third.flp")).toEqual([]);
    // A rename moves what was filed to the song.
    expect(relinkedFilings([...list, memo("beat:/b.wav")], [{ from: "/Music/Projects/Envy.flp", to: "/Music/Projects/Envy v2.flp" }])).toEqual([
      { id: "song:/Music/Projects/Envy.flp", filedTo: "song:/Music/Projects/Envy v2.flp" },
    ]);
  });
  it("formats durations", () => {
    expect(duration(125_400)).toBe("2:05");
    expect(duration(null)).toBe("");
  });
});

describe("filed items: where they are and what Remove loses", () => {
  it("shows a sketch's folder or a memo's copy, never an idea or a bare link", () => {
    expect(filedPath(item({ itemType: "sketch", status: "filed", filedTo: "/p/Night/BandLab", filedAs: "song" }))).toBe("/p/Night/BandLab");
    expect(filedPath(item({ itemType: "memo", status: "filed", filedTo: "/p/Envy/Voice memos/a.m4a", filedAs: "folder" }))).toBe("/p/Envy/Voice memos/a.m4a");
    expect(filedPath(item({ itemType: "memo", status: "filed", filedTo: "beat:/b/x.wav", copiedTo: "/b/_memos/a.m4a", filedAs: "link" }))).toBe("/b/_memos/a.m4a");
    expect(filedPath(item({ itemType: "memo", status: "filed", filedTo: "beat:/b/x.wav" }))).toBeNull();
    expect(filedPath(item({ itemType: "idea", status: "filed", filedTo: "song:/p/a.flp" }))).toBeNull();
    expect(filedPath(item({ itemType: "memo", status: "new" }))).toBeNull();
  });

  it("warns when the inbox holds the only copy", () => {
    expect(removeLoses(item({ itemType: "memo", status: "new" }))).toBe("only");
    expect(removeLoses(item({ itemType: "memo", status: "dismissed" }))).toBe("only");
    // Linked before links were copied: the inbox file is the only one.
    expect(removeLoses(item({ itemType: "memo", status: "filed", filedTo: "prod:8fd69810" }))).toBe("only");
    expect(removeLoses(item({ itemType: "memo", status: "filed", filedTo: "prod:8fd69810", copiedTo: "/b/_memos/a.m4a" }))).toBe("kept");
    expect(removeLoses(item({ itemType: "memo", status: "filed", filedTo: "/p/Envy/Voice memos/a.m4a" }))).toBe("kept");
    expect(removeLoses(item({ itemType: "idea", status: "filed", filedTo: "song:/p/a.flp" }))).toBe("kept");
  });

  it("files elsewhere only what can go somewhere else", () => {
    expect(canFileElsewhere(item({ itemType: "idea", status: "filed" }))).toBe(true);
    expect(canFileElsewhere(item({ itemType: "memo", status: "filed" }))).toBe(true);
    expect(canFileElsewhere(item({ itemType: "sketch", status: "filed" }))).toBe(false);
    expect(canFileElsewhere(item({ itemType: "idea", status: "new" }))).toBe(false);
  });
});
