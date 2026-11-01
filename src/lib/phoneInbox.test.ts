import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import {
  appendIdea,
  bandlabLink,
  isOpaqueName,
  duration,
  filterInbox,
  ideaBlock,
  knownTarget,
  memosFor,
  memosForSong,
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
  it("formats durations", () => {
    expect(duration(125_400)).toBe("2:05");
    expect(duration(null)).toBe("");
  });
});
