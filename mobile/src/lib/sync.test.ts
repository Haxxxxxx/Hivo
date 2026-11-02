import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fnv1a, toB64url } from "./bytes";
import { createClient, SyncError, timeoutFor, type Transport } from "./client";
import { openRequestFull, ReplayGuard, sealResponse, type Reply } from "./envelope";
import type { Pairing } from "./pairing";
import {
  allItems,
  applyPushResults,
  applySnapshot,
  cacheOf,
  editsOf,
  forgetGone,
  keepEdits,
  parseEdits,
  rebaseOnSnapshot,
  unsyncedText,
  isGone,
  MAX_PUSH_TEXT_BYTES,
  editNote,
  emptyState,
  filterItems,
  itemKey,
  MAX_CHANGES,
  noteFor,
  parseItem,
  parsePushResults,
  parseSnapshot,
  pendingChanges,
  runSync,
  type Change,
  type Item,
  type Kind,
  type SyncState,
} from "./sync";

const item = (kind: Kind, id: string, note = "", extra: Partial<Item> = {}): Item => ({
  kind, id, title: id, subtitle: "", bpm: null, key: null, url: null, stage: null, note, noteHash: fnv1a(note), ...extra,
});

const withItems = (...items: Item[]): SyncState => ({ ...emptyState(), items });

describe("parseItem / parseSnapshot", () => {
  it("keeps valid items and drops junk", () => {
    const snap = parseSnapshot({
      items: [
        { kind: "prod", id: "abc", title: "Dark loop", subtitle: "Producer · 2026", bpm: 140, key: "Am", url: "https://www.youtube.com/watch?v=x", stage: null, note: "hi", noteHash: fnv1a("hi") },
        { kind: "song", id: "C:\\music\\Track.flp", title: "", note: "" },
        { kind: "video", id: "x" },
        null,
        { kind: "beat", id: "" },
      ],
      generatedAt: 5,
    });
    expect(snap?.items.map((i) => i.id)).toEqual(["abc", "C:\\music\\Track.flp"]);
    expect(snap?.items[1].title).toBe("Track.flp");
    expect(snap?.items[1].noteHash).toBe("811c9dc5");
    expect(snap?.generatedAt).toBe(5);
    expect(parseSnapshot({})).toBeNull();
  });
  it("only keeps https links", () => {
    expect(parseItem({ kind: "prod", id: "a", url: "javascript:alert(1)" })?.url).toBeNull();
    expect(parseItem({ kind: "prod", id: "a", url: "http://x" })?.url).toBeNull();
  });
});

describe("editNote / pendingChanges", () => {
  it("queues an edit with the desktop's hash as base, and keeps that base", () => {
    let s = withItems(item("beat", "b1", "old"));
    s = editNote(s, "beat", "b1", "new", 1);
    s = editNote(s, "beat", "b1", "newer", 2);
    expect(pendingChanges(s)).toEqual([{ kind: "beat", id: "b1", text: "newer", baseHash: fnv1a("old") }]);
    expect(noteFor(s, "beat", "b1")).toBe("newer");
  });
  it("drops the edit when the text goes back to the desktop's", () => {
    let s = withItems(item("song", "s1", "same"));
    s = editNote(s, "song", "s1", "changed", 1);
    s = editNote(s, "song", "s1", "same", 2);
    expect(pendingChanges(s)).toEqual([]);
  });
  it("orders by edit time and caps the batch", () => {
    let s = emptyState();
    for (let i = MAX_CHANGES + 5; i > 0; i--) s = editNote(s, "beat", `b${i}`, "x", i);
    const c = pendingChanges(s);
    expect(c).toHaveLength(MAX_CHANGES);
    expect(c[0].id).toBe("b1");
  });
});

describe("applyPushResults", () => {
  const sent: Change[] = [
    { kind: "beat", id: "a", text: "A", baseHash: fnv1a("") },
    { kind: "beat", id: "b", text: "B", baseHash: fnv1a("") },
    { kind: "beat", id: "c", text: "C", baseHash: fnv1a("") },
  ];
  const base = () => {
    let s = withItems(item("beat", "a"), item("beat", "b"), item("beat", "c"));
    for (const c of sent) s = editNote(s, c.kind, c.id, c.text, 1);
    return s;
  };

  it("applied, conflict and missing", () => {
    const merged = "desk\n\n--- from Phone ---\nB";
    const s = applyPushResults(base(), sent, [
      { kind: "beat", id: "a", status: "applied", note: "A", noteHash: fnv1a("A") },
      { kind: "beat", id: "b", status: "conflict", note: merged, noteHash: fnv1a(merged) },
      { kind: "beat", id: "c", status: "missing", note: "", noteHash: fnv1a("") },
    ], 9);
    expect(s.pending).toEqual({});
    expect(noteFor(s, "beat", "a")).toBe("A");
    expect(noteFor(s, "beat", "b")).toBe(merged);
    expect(s.conflicts).toEqual({ [itemKey("beat", "b")]: 9 });
    expect(s.items.map((i) => i.id)).toEqual(["a", "b"]);
    // "missing" keeps the phone's text, marked as gone.
    expect(isGone(s, "beat", "c")).toBe(true);
    expect(noteFor(s, "beat", "c")).toBe("C");
    expect(allItems(s).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("gone items: edits stay local, a later snapshot keeps them, forget removes them", () => {
    let s = applyPushResults(base(), sent, [{ kind: "beat", id: "c", status: "missing", note: "", noteHash: fnv1a("") }], 9);
    s = editNote(s, "beat", "c", "C2", 10);
    expect(pendingChanges(s).map((c) => c.id)).not.toContain("c");
    s = applySnapshot(s, { items: [item("beat", "a")], generatedAt: 1 }, 11);
    expect(noteFor(s, "beat", "c")).toBe("C2");
    expect(forgetGone(s, "beat", "c").gone).toEqual({});
  });

  it("a gone item that comes back is queued again", () => {
    let s = applyPushResults(base(), sent, [{ kind: "beat", id: "c", status: "missing", note: "", noteHash: fnv1a("") }], 9);
    s = applySnapshot(s, { items: [item("beat", "c", "desk")], generatedAt: 1 }, 11);
    expect(isGone(s, "beat", "c")).toBe(false);
    expect(pendingChanges(s)).toContainEqual({ kind: "beat", id: "c", text: "C", baseHash: fnv1a("desk") });
  });

  it("keeps an edit typed during the push, rebased on what the desktop applied", () => {
    let s = base();
    s = editNote(s, "beat", "a", "A2", 5);
    s = applyPushResults(s, sent, [{ kind: "beat", id: "a", status: "applied", note: "A", noteHash: fnv1a("A") }], 9);
    expect(s.pending[itemKey("beat", "a")]).toMatchObject({ text: "A2", baseHash: fnv1a("A") });
  });

  it("'too long': keeps the phone's text, doesn't resend it unchanged, sends again once edited", () => {
    const k = itemKey("beat", "a");
    let s = applyPushResults(base(), sent, [{ kind: "beat", id: "a", status: "too long", note: "DESK", noteHash: fnv1a("DESK") }], 9);
    expect(s.pending[k]?.text).toBe("A");
    expect(s.tooLong?.[k]).toBe(9);
    expect(s.items.find((i) => i.id === "a")?.note).toBe("DESK");
    expect(pendingChanges(s).map((c) => c.id)).not.toContain("a");
    s = editNote(s, "beat", "a", "A shorter", 10);
    expect(s.tooLong?.[k]).toBeUndefined();
    expect(pendingChanges(s).map((c) => c.id)).toContain("a");
  });

  it("re-keys pending edits, gone items and marks on `renamed`", () => {
    // A pending edit on a song that moved.
    let s: SyncState = { ...base(), conflicts: { [itemKey("beat", "a")]: 3 } };
    s = editNote(s, "beat", "a", "A2", 5);
    const moved = applySnapshot(s, { items: [item("beat", "a2", "A"), item("beat", "b"), item("beat", "c")], generatedAt: 1, renamed: [{ kind: "beat", from: "a", to: "a2" }] }, 9);
    expect(moved.pending[itemKey("beat", "a")]).toBeUndefined();
    expect(moved.pending[itemKey("beat", "a2")]).toMatchObject({ id: "a2", text: "A2", baseHash: s.pending[itemKey("beat", "a")].baseHash });
    expect(moved.conflicts).toEqual({ [itemKey("beat", "a2")]: 3 });
    // A gone item (pushed before the snapshot said it moved): an edit again, on its old base.
    let g = applyPushResults(base(), sent, [{ kind: "beat", id: "c", status: "missing", note: "", noteHash: fnv1a("") }], 9);
    const baseOfC = sent.find((c) => c.id === "c")!.baseHash;
    g = applySnapshot(g, { items: [item("beat", "c2", "desk")], generatedAt: 1, renamed: [{ kind: "beat", from: "c", to: "c2" }] }, 11);
    expect(g.gone).toEqual({});
    expect(pendingChanges(g)).toContainEqual({ kind: "beat", id: "c2", text: "C", baseHash: baseOfC });
    // Not in this snapshot: still gone, under its new id. Kept across a restart with its base.
    let h = applyPushResults(base(), sent, [{ kind: "beat", id: "c", status: "missing", note: "", noteHash: fnv1a("") }], 9);
    h = applySnapshot(h, { items: [], generatedAt: 1, renamed: [{ kind: "beat", from: "c", to: "c3" }] }, 11);
    expect(Object.keys(h.gone)).toEqual([itemKey("beat", "c3")]);
    expect(parseEdits(JSON.parse(JSON.stringify(editsOf(h)))).gone[itemKey("beat", "c3")].baseHash).toBe(baseOfC);
    // Older desktops send no `renamed`; malformed entries are dropped.
    expect(parseSnapshot({ items: [], renamed: [{ kind: "song", from: "a", to: "a" }, { kind: "x", from: "a", to: "b" }, { kind: "song", from: "a", to: "b" }] })?.renamed).toEqual([{ kind: "song", from: "a", to: "b" }]);
    expect(parseSnapshot({ items: [] })?.renamed).toEqual([]);
  });

  it("reads 'too long' from the computer's answer (older phones skipped it)", () => {
    const parsed = parsePushResults({ results: [{ kind: "beat", id: "a", status: "too long", note: "x", noteHash: fnv1a("x") }] });
    expect(parsed?.[0]?.status).toBe("too long");
  });
});

// A fake desktop that follows the contract, end to end through the envelope.
// It answers like a 1.2 desktop (bound to the request when the phone says 1.2), or like a 1.1 one with `v11`.
function fakeDesktop(pairing: Pairing, initial: Item[], opts: { demo?: boolean; error?: string; hivoVersion?: string; v11?: boolean } = {}) {
  const renamed: { kind: Kind; from: string; to: string }[] = [];
  const key = Buffer.from(pairing.key, "base64url");
  const guard = new ReplayGuard();
  const notes = new Map(initial.map((i) => [itemKey(i.kind, i.id), i]));
  const rnd = (n: number) => new Uint8Array(randomBytes(n));
  const log: string[] = [];
  const transport: Transport = async (url, init) => {
    const path = new URL(url).pathname;
    log.push(`${new URL(url).hostname} ${path}`);
    if (new URL(url).hostname !== "192.168.1.20") throw new TypeError("Network request failed");
    let body: unknown;
    let bind: string | undefined;
    try {
      const req = openRequestFull(key, init.headers["X-Hivo-Device"], path, JSON.parse(init.body), Date.now(), guard);
      body = req.body;
      if (!opts.v11 && req.v === "1.2") bind = req.nonce;
    } catch {
      return { status: 401, text: async () => "" };
    }
    let reply: Reply;
    if (opts.demo) reply = { ok: false, error: "demo" };
    else if (opts.error) reply = { ok: false, error: opts.error };
    else if (path === "/v1/hello") reply = { ok: true, body: { desktopName: "Studio", hivoVersion: opts.hivoVersion ?? "0.5.6" } };
    else if (path === "/v1/snapshot") reply = { ok: true, body: { items: [...notes.values()], generatedAt: 1, renamed } };
    else {
      const results = (body as { changes: Change[] }).changes.map((c) => {
        const cur = notes.get(itemKey(c.kind, c.id));
        if (!cur) return { kind: c.kind, id: c.id, status: "missing", note: "", noteHash: fnv1a("") };
        // Final contract: applied when the hash matches, when the desktop
        // already holds exactly `text`, or when its note is empty.
        const conflict = cur.noteHash !== c.baseHash && cur.note !== c.text && cur.note !== "";
        const note = conflict ? `${cur.note}\n\n--- from Phone ---\n${c.text}` : c.text;
        notes.set(itemKey(c.kind, c.id), { ...cur, note, noteHash: fnv1a(note) });
        return { kind: c.kind, id: c.id, status: conflict ? "conflict" : "applied", note, noteHash: fnv1a(note) };
      });
      reply = { ok: true, body: { results } };
    }
    const env = sealResponse(key, init.headers["X-Hivo-Device"], path, reply, rnd, bind);
    return { status: 200, text: async () => JSON.stringify(env) };
  };
  return { transport, notes, log, renamed };
}

const pairing: Pairing = {
  deviceId: toB64url(new Uint8Array(randomBytes(16))),
  key: toB64url(new Uint8Array(randomBytes(32))),
  hosts: ["10.0.0.9", "192.168.1.20"],
  port: 51234,
  desktopName: "Studio",
};
const rnd = (n: number) => new Uint8Array(randomBytes(n));
const hello = { phoneName: "Test phone", appVersion: "0.1.0" };

describe("runSync with a fake desktop", () => {
  it("hello, push, pull; falls through to the host that answers", async () => {
    const desk = fakeDesktop(pairing, [item("song", "s1", "desk"), item("beat", "b1", "")]);
    const call = createClient({ pairing, transport: desk.transport, random: rnd, now: Date.now });
    let s = withItems(item("song", "s1", "desk"), item("beat", "b1", ""));
    s = editNote(s, "beat", "b1", "[Hook]\nline", 1);
    const r = await runSync(call, () => s, (n) => (s = n), hello, Date.now);
    expect(r.desktopName).toBe("Studio");
    expect(s.helloDone).toBe(true);
    expect(s.pending).toEqual({});
    expect(noteFor(s, "beat", "b1")).toBe("[Hook]\nline");
    expect(desk.notes.get(itemKey("beat", "b1"))?.note).toBe("[Hook]\nline");
    expect(s.lastSyncAt).not.toBeNull();
    // The answering host moved first: the next call goes straight to it.
    desk.log.length = 0;
    await runSync(call, () => s, (n) => (s = n), hello, Date.now);
    expect(desk.log).toEqual(["192.168.1.20 /v1/snapshot"]);
  });

  it("a note edited on both sides comes back merged with a conflict flag", async () => {
    const desk = fakeDesktop(pairing, [item("song", "s1", "v1")]);
    const call = createClient({ pairing, transport: desk.transport, random: rnd, now: Date.now });
    let s = { ...withItems(item("song", "s1", "v1")), helloDone: true };
    s = editNote(s, "song", "s1", "phone", 1);
    desk.notes.set(itemKey("song", "s1"), item("song", "s1", "desktop"));
    const r = await runSync(call, () => s, (n) => (s = n), hello, Date.now);
    expect(r.conflicts).toBe(1);
    expect(noteFor(s, "song", "s1")).toBe("desktop\n\n--- from Phone ---\nphone");
    expect(s.conflicts[itemKey("song", "s1")]).toBeTypeOf("number");
  });

  it("a song renamed on the desktop (Continue in FL Studio): the pending edit follows it and goes the same sync", async () => {
    const desk = fakeDesktop(pairing, [item("song", "/p/X/BandLab", "desk")]);
    const call = createClient({ pairing, transport: desk.transport, random: rnd, now: Date.now });
    let s = { ...withItems(item("song", "/p/X/BandLab", "desk")), helloDone: true };
    s = editNote(s, "song", "/p/X/BandLab", "desk\nnew bar", 1);
    // Meanwhile the desktop continued the sketch in FL Studio: a new key.
    desk.notes.delete(itemKey("song", "/p/X/BandLab"));
    desk.notes.set(itemKey("song", "/p/X/X.flp"), item("song", "/p/X/X.flp", "desk"));
    desk.renamed.push({ kind: "song", from: "/p/X/BandLab", to: "/p/X/X.flp" });
    const r = await runSync(call, () => s, (n) => (s = n), hello, Date.now);
    expect(desk.notes.get(itemKey("song", "/p/X/X.flp"))?.note).toBe("desk\nnew bar");
    expect(s.pending).toEqual({});
    expect(s.gone).toEqual({});
    expect(r.missing).toBe(0);
  });

  it("says hello again when asked (once per app run) and returns the computer's version", async () => {
    const desk = fakeDesktop(pairing, [], { hivoVersion: "0.5.2" });
    const call = createClient({ pairing, transport: desk.transport, random: rnd, now: Date.now });
    let s = { ...withItems(), helloDone: true };
    const quiet = await runSync(call, () => s, (n) => (s = n), hello, Date.now);
    expect(quiet.desktopVersion).toBeUndefined();
    const r = await runSync(call, () => s, (n) => (s = n), hello, Date.now, { hello: true });
    expect(r.desktopVersion).toBe("0.5.2");
  });

  it("the desktop's read-only workspace has its own code (not 'busy' forever)", async () => {
    const ro = createClient({ pairing, transport: fakeDesktop(pairing, [], { error: "read only" }).transport, random: rnd, now: Date.now });
    await expect(ro("/v1/snapshot", {})).rejects.toMatchObject({ code: "read-only" });
  });

  it("maps failures to clear codes", async () => {
    const forgotten = createClient({ pairing: { ...pairing, hosts: ["192.168.1.20"] }, transport: fakeDesktop({ ...pairing, key: toB64url(rnd(32)) }, []).transport, random: rnd, now: Date.now });
    await expect(forgotten("/v1/snapshot", {})).rejects.toMatchObject({ code: "forgotten" });

    const demo = createClient({ pairing, transport: fakeDesktop(pairing, [], { demo: true }).transport, random: rnd, now: Date.now });
    await expect(demo("/v1/snapshot", {})).rejects.toMatchObject({ code: "demo" });

    const refused: Transport = async () => { throw new TypeError("Network request failed"); };
    await expect(createClient({ pairing, transport: refused, random: rnd, now: Date.now })("/v1/hello", {})).rejects.toMatchObject({ code: "off" });

    let t = 0;
    const slow: Transport = async () => { t += 10_000; throw new TypeError("Network request failed"); };
    await expect(createClient({ pairing, transport: slow, random: rnd, now: () => t })("/v1/hello", {})).rejects.toMatchObject({ code: "offline" });

    const status = (code: number): Transport => async () => ({ status: code, text: async () => "" });
    const codeFor = (code: number) => createClient({ pairing, transport: status(code), random: rnd, now: Date.now })("/v1/notes", {}).catch((e: SyncError) => e.code);
    expect(await codeFor(429)).toBe("busy");
    expect(await codeFor(503)).toBe("busy");
    expect(await codeFor(413)).toBe("too-big");
    expect(await codeFor(404)).toBe("outdated");
    expect(await codeFor(500)).toBe("server");

    const key = Buffer.from(pairing.key, "base64url");
    const errReply = (error: string): Transport => async (url) => ({
      status: 200,
      text: async () => JSON.stringify(sealResponse(key, pairing.deviceId, new URL(url).pathname, { ok: false, error }, rnd)),
    });
    const codeForError = (error: string) => createClient({ pairing, transport: errReply(error), random: rnd, now: Date.now })("/v1/notes", {}).catch((e: SyncError) => e.code);
    expect(await codeForError("busy")).toBe("busy");
    expect(await codeForError("bad request")).toBe("outdated");
    expect(await codeForError("too many changes (500 max)")).toBe("too-big");
    expect(await codeForError("note too long (20000 characters max)")).toBe("too-big");
    // The desktop opened the request but its time is off by more than 2 minutes.
    expect(await codeForError("clock")).toBe("clock");
    // "bad request" keeps its words, so the uploader can fail just that item.
    const bad = await createClient({ pairing, transport: errReply("bad request"), random: rnd, now: Date.now })("/v1/upload/start", {}).catch((e: SyncError) => e);
    expect(bad).toMatchObject({ message: "bad request" });

    const html: Transport = async () => ({ status: 200, text: async () => "<html>" });
    const err = (await createClient({ pairing, transport: html, random: rnd, now: Date.now })("/v1/hello", {}).catch((e: unknown) => e)) as SyncError;
    expect(err).toBeInstanceOf(SyncError);
    expect(err.code).toBe("server");
  });
});

describe("batching", () => {
  it("splits big queues by byte budget and pushes them all in one sync", async () => {
    const big = "x".repeat(19_000);
    const items = Array.from({ length: 80 }, (_, i) => item("beat", `b${i}`));
    let s = { ...withItems(...items), helloDone: true };
    for (let i = 0; i < 80; i++) s = editNote(s, "beat", `b${i}`, big, i);
    const first = pendingChanges(s);
    expect(first.length).toBeLessThan(80);
    expect(first.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(MAX_PUSH_TEXT_BYTES);
    const desk = fakeDesktop(pairing, items);
    const call = createClient({ pairing, transport: desk.transport, random: rnd, now: Date.now });
    await runSync(call, () => s, (n) => (s = n), hello, Date.now);
    expect(s.pending).toEqual({});
    expect(desk.log.filter((l) => l.endsWith("/v1/notes")).length).toBeGreaterThan(1);
  });

  it("a retried push of the same text is applied, not merged", async () => {
    const desk = fakeDesktop(pairing, [item("song", "s1", "same")]);
    const call = createClient({ pairing, transport: desk.transport, random: rnd, now: Date.now });
    let s = { ...withItems(item("song", "s1", "old")), helloDone: true };
    s = editNote(s, "song", "s1", "same", 1);
    const r = await runSync(call, () => s, (n) => (s = n), hello, Date.now);
    expect(r.conflicts).toBe(0);
    expect(noteFor(s, "song", "s1")).toBe("same");
  });
});

describe("timeouts", () => {
  it("waits longer than the desktop's 10 s for a snapshot or a notes push, and longer still for a chunk", () => {
    expect(timeoutFor("/v1/snapshot", 5000)).toBe(12_000);
    expect(timeoutFor("/v1/notes", 5000)).toBe(12_000);
    expect(timeoutFor("/v1/upload/chunk", 5000)).toBe(30_000);
    expect(timeoutFor("/v1/hello", 5000)).toBe(5000);
  });
});

describe("pending edits across re-pairing", () => {
  it("keep the phone's text through unpair, re-base on the new pairing's first snapshot, then push", async () => {
    // Paired to computer A: two edits, one on an item only A has.
    let s = withItems(item("song", "s1", "v1", { title: "Night Run" }), item("beat", "onlyA", "", { title: "Old beat" }));
    s = editNote(s, "song", "s1", "v1 + phone line", 1);
    s = editNote(s, "beat", "onlyA", "bars for A", 2);
    s = editNote(s, "beat", "same", "x", 3); // no item: pending with no title
    // Unpair: the edits are stored on their own and survive (JSON round trip).
    const stored = JSON.parse(JSON.stringify(editsOf(s)));
    expect(JSON.stringify(cacheOf(s))).not.toContain("phone line");
    let fresh = keepEdits(parseEdits(stored));
    expect(fresh.items).toEqual([]);
    expect(fresh.rebase).toBe(true);
    expect(Object.keys(fresh.pending)).toHaveLength(3);
    expect(unsyncedText(fresh)).toContain("Night Run\n---------\nv1 + phone line");

    // Paired again (the computer's address changed): it has s1 (changed meanwhile) and "same" with that text.
    const desk = fakeDesktop(pairing, [item("song", "s1", "v1 edited on desk"), item("beat", "same", "x")]);
    const call = createClient({ pairing, transport: desk.transport, random: rnd, now: Date.now });
    fresh = { ...fresh, helloDone: true };
    await runSync(call, () => fresh, (n) => (fresh = n), hello, Date.now);
    expect(fresh.rebase).toBe(false);
    expect(fresh.pending).toEqual({});
    // Nothing overwritten: the computer kept both texts.
    expect(desk.notes.get(itemKey("song", "s1"))?.note).toBe("v1 edited on desk\n\n--- from Phone ---\nv1 + phone line");
    // Not on this computer: kept on the phone as "gone", with its title.
    expect(fresh.gone[itemKey("beat", "onlyA")]).toMatchObject({ title: "Old beat", note: "bars for A" });
    // Already the same text there: dropped, never pushed.
    expect(desk.log.filter((l) => l.endsWith("/v1/notes"))).toHaveLength(1);
  });

  it("rebaseOnSnapshot drops what matches and keeps the old base for the rest", () => {
    let s = withItems(item("song", "s1", "a"));
    s = editNote(s, "song", "s1", "b", 1);
    const base = s.pending[itemKey("song", "s1")].baseHash;
    const r = rebaseOnSnapshot(keepEdits(editsOf(s)), { items: [item("song", "s1", "c")] });
    expect(r.pending[itemKey("song", "s1")].baseHash).toBe(base);
    expect(rebaseOnSnapshot(keepEdits(editsOf(s)), { items: [item("song", "s1", "b")] }).pending).toEqual({});
  });

  it("parseEdits leaves malformed rows out", () => {
    const e = parseEdits({ pending: { "song:x": { kind: "song", id: "x", text: "t", baseHash: "811c9dc5", editedAt: 1 }, bad: { kind: "nope" }, "song:y": { kind: "song", id: "z", text: "t", baseHash: "1", editedAt: 1 } }, gone: { junk: 1 } });
    expect(Object.keys(e.pending)).toEqual(["song:x"]);
    expect(e.gone).toEqual({});
    expect(parseEdits("garbage")).toEqual({ pending: {}, gone: {} });
  });
});

describe("filterItems", () => {
  it("filters by tab and searches title, subtitle, key and note", () => {
    const items = [item("beat", "1", "", { title: "Night", key: "Am" }), item("beat", "2", "has hook"), item("song", "3")];
    expect(filterItems(items, "beat", "").map((i) => i.id)).toEqual(["1", "2"]);
    expect(filterItems(items, "beat", "am").map((i) => i.id)).toEqual(["1"]);
    expect(filterItems(items, "beat", "HOOK").map((i) => i.id)).toEqual(["2"]);
  });
});
