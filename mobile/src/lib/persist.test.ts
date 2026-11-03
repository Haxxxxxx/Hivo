import { describe, expect, it } from "vitest";
import { createIdea, type Idea } from "./ideas";
import type { OutItem } from "./outbox";
import { parseIdea } from "./ideas";
import { parseOutItem } from "./outbox";
import {
  CACHE_FILE,
  cacheFileText,
  clearCache,
  decodeEdits,
  decodeList,
  KEYS,
  loadAll,
  mergeById,
  mergeEdits,
  parseCache,
  parseList,
  readAtomic,
  saveCache,
  saveRow,
  writeAtomic,
  type FS,
  type KV,
  type LibraryCache,
} from "./persist";
import type { Item } from "./sync";

/** AsyncStorage as a map, with keys that throw on read or on write. */
function fakeKV(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  const badRead = new Set<string>();
  const badWrite = new Set<string>();
  const kv: KV = {
    async get(k) {
      if (badRead.has(k)) throw new Error("Row too big to fit into CursorWindow");
      return data.get(k) ?? null;
    },
    async set(k, v) {
      if (badWrite.has(k) || badWrite.has("*")) throw new Error("database or disk is full (SQLITE_FULL)");
      data.set(k, v);
    },
    async remove(k) {
      data.delete(k);
    },
  };
  return { kv, data, badRead, badWrite };
}

/** A folder as a map; `killAt` throws at the n-th write/move (the app killed there). */
function fakeFS(init: Record<string, string> = {}) {
  const files = new Map(Object.entries(init));
  let ops = 0;
  let killAt = Infinity;
  const step = () => {
    if (++ops >= killAt) throw new Error("killed");
  };
  const fs: FS = {
    async read(n) {
      return files.get(n) ?? null;
    },
    async write(n, t) {
      step();
      files.set(n, t);
    },
    async move(a, b) {
      const v = files.get(a);
      if (v === undefined) throw new Error("no source");
      // Like expo-file-system with overwrite: delete the target, then rename.
      files.delete(b);
      step();
      files.delete(a);
      files.set(b, v);
    },
    async remove(n) {
      files.delete(n);
    },
  };
  return { fs, files, kill: (n: number) => ((ops = 0), (killAt = n)) };
}

const idea = (id: string, text = "a line"): Idea => createIdea(id, 1000, { text });
const memo = (id: string, state: OutItem["state"] = "waiting"): OutItem => ({
  id,
  type: "memo",
  title: "",
  target: null,
  createdAt: 1,
  durationMs: 2000,
  files: [{ uri: `file:///doc/outbox/${id}/Voice memo.m4a`, name: "Voice memo.m4a", size: 10, done: false }],
  state,
  error: null,
  sentBytes: 0,
  status: null,
  filedTo: null,
  sentAt: null,
});
const item = (id: string, note = ""): Item => ({ kind: "song", id, title: id, subtitle: "", bpm: null, key: null, url: null, stage: null, note, noteHash: "811c9dc5" });
const cache = (items: Item[]): LibraryCache => ({ items, generatedAt: 5, lastSyncAt: 6, conflicts: {}, helloDone: true });

describe("loadAll", () => {
  it("reads every row on its own: one unreadable row is blocked, the others load", async () => {
    const { kv, badRead } = fakeKV({ [KEYS.ideas]: JSON.stringify([idea("a")]), [KEYS.outbox]: JSON.stringify([memo("m")]), [KEYS.bound]: "computer:x" });
    badRead.add(KEYS.ideas);
    const r = await loadAll(kv, fakeFS().fs, 9);
    expect(r.blocked).toEqual(["ideas"]);
    expect(r.ideas).toEqual([]);
    expect(r.outbox.map((o) => o.id)).toEqual(["m"]);
    expect(r.outboxClean).toBe(true);
    expect(r.bound).toBe("computer:x");
  });

  it("an unreadable outbox row is blocked and not clean (its files must not be swept)", async () => {
    const { kv, badRead } = fakeKV({ [KEYS.outbox]: JSON.stringify([memo("m")]) });
    badRead.add(KEYS.outbox);
    const r = await loadAll(kv, fakeFS().fs, 9);
    expect(r.blocked).toEqual(["outbox"]);
    expect(r.outboxClean).toBe(false);
  });

  it("drops bad records, copies the whole row aside, keeps the good ones", async () => {
    const raw = JSON.stringify([memo("good"), { id: "bad" }, null, memo("good")]);
    const { kv, data } = fakeKV({ [KEYS.outbox]: raw });
    const r = await loadAll(kv, fakeFS().fs, 42);
    expect(r.outbox.map((o) => o.id)).toEqual(["good"]);
    expect(r.dropped).toEqual(["outbox"]);
    expect(r.blocked).toEqual([]);
    expect(r.outboxClean).toBe(false);
    expect(data.get(`${KEYS.outbox}.corrupt.42`)).toBe(raw);
  });

  it("a row that isn't JSON is copied aside; when even that fails, it's blocked", async () => {
    const { kv, data, badWrite } = fakeKV({ [KEYS.ideas]: "{not json" });
    badWrite.add(`${KEYS.ideas}.corrupt.1`);
    const r = await loadAll(kv, fakeFS().fs, 1);
    expect(r.blocked).toEqual(["ideas"]);
    expect(data.get(KEYS.ideas)).toBe("{not json");
  });

  it("moves the old cache row to the file once, its edits first, then removes the row", async () => {
    const old = { items: [item("s1", "hook")], generatedAt: 3, lastSyncAt: 4, conflicts: { "song:s1": 2 }, helloDone: true, pending: { "song:s1": { kind: "song", id: "s1", text: "mine", baseHash: "811c9dc5", editedAt: 1 } }, gone: {} };
    const { kv, data } = fakeKV({ [KEYS.legacyCache]: JSON.stringify(old) });
    const { fs, files } = fakeFS();
    const r = await loadAll(kv, fs, 1);
    expect(r.cache?.items.map((i) => i.id)).toEqual(["s1"]);
    expect(r.cache?.lastSyncAt).toBe(4);
    expect(r.edits.pending["song:s1"].text).toBe("mine");
    expect(files.has(CACHE_FILE)).toBe(true);
    expect(data.has(KEYS.legacyCache)).toBe(false);
    expect(JSON.parse(data.get(KEYS.edits) as string).pending["song:s1"].text).toBe("mine");
    // Next launch: from the file and the edits row.
    const again = await loadAll(kv, fs, 2);
    expect(again.cache?.items.map((i) => i.id)).toEqual(["s1"]);
    expect(again.cache?.conflicts).toEqual({ "song:s1": 2 });
    expect(again.edits.pending["song:s1"].text).toBe("mine");
  });

  it("a migration killed half-way runs again at the next launch, nothing lost", async () => {
    const old = { items: [item("s1")], generatedAt: 3, lastSyncAt: 4, conflicts: {}, helloDone: true };
    const { kv, data } = fakeKV({ [KEYS.legacyCache]: JSON.stringify(old), [KEYS.edits]: JSON.stringify({ pending: {}, gone: {} }) });
    const { fs, kill } = fakeFS();
    kill(1); // the temp file's write
    const r = await loadAll(kv, fs, 1);
    expect(r.cache?.items.map((i) => i.id)).toEqual(["s1"]);
    expect(data.has(KEYS.legacyCache)).toBe(true);
    kill(Infinity);
    const again = await loadAll(kv, fs, 2);
    expect(again.cache?.items.map((i) => i.id)).toEqual(["s1"]);
    expect(data.has(KEYS.legacyCache)).toBe(false);
  });

  it("an old cache row too big to read is dropped when the edits have their own row (a sync brings the library back)", async () => {
    const { kv, data, badRead } = fakeKV({ [KEYS.legacyCache]: "x".repeat(10), [KEYS.edits]: JSON.stringify({ pending: {}, gone: {} }) });
    badRead.add(KEYS.legacyCache);
    const r = await loadAll(kv, fakeFS().fs, 1);
    expect(r.cache).toBeNull();
    expect(r.blocked).toEqual([]);
    expect(data.has(KEYS.legacyCache)).toBe(false);
  });

  it("keeps an unreadable old row when the edits may only be in it", async () => {
    const { kv, data, badRead } = fakeKV({ [KEYS.legacyCache]: "x" });
    badRead.add(KEYS.legacyCache);
    await loadAll(kv, fakeFS().fs, 1);
    expect(data.has(KEYS.legacyCache)).toBe(true);
  });

  it("validates the cache file's items (a bad one is left out, the app opens)", async () => {
    const text = JSON.stringify({ v: 1, items: [item("ok"), { kind: "planet", id: 3 }, "x"], conflicts: { a: 1, b: "no" }, helloDone: true });
    const r = await loadAll(fakeKV().kv, fakeFS({ [CACHE_FILE]: text }).fs, 1);
    expect(r.cache?.items.map((i) => i.id)).toEqual(["ok"]);
    expect(r.cache?.conflicts).toEqual({ a: 1 });
  });

  it("a cache file that doesn't parse is no cache (not a crash)", async () => {
    const r = await loadAll(fakeKV().kv, fakeFS({ [CACHE_FILE]: "{" }).fs, 1);
    expect(r.cache).toBeNull();
  });
});

describe("atomic cache file", () => {
  it("a kill before the move keeps the old file", async () => {
    const { fs, kill } = fakeFS({ [CACHE_FILE]: "old" });
    kill(1);
    await expect(writeAtomic(fs, CACHE_FILE, "new")).rejects.toThrow("killed");
    expect(await readAtomic(fs, CACHE_FILE)).toEqual({ ok: true, raw: "old" });
  });

  it("a kill between the move's delete and its rename leaves the complete temp file, which is read", async () => {
    const { fs, kill } = fakeFS({ [CACHE_FILE]: "old" });
    kill(2);
    await expect(writeAtomic(fs, CACHE_FILE, "new")).rejects.toThrow("killed");
    expect(await readAtomic(fs, CACHE_FILE)).toEqual({ ok: true, raw: "new" });
  });

  it("is written only when the library changed; the clocks go in their row", async () => {
    const { kv, data } = fakeKV();
    const { fs, files } = fakeFS();
    let writes = 0;
    const counting: FS = { ...fs, write: async (n, t) => (writes++, fs.write(n, t)) };
    const c = cache([item("a")]);
    const last = await saveCache(kv, counting, c, null);
    await saveCache(kv, counting, { ...c, lastSyncAt: 99, generatedAt: 98 }, last);
    expect(writes).toBe(1);
    expect(JSON.parse(data.get(KEYS.meta) as string)).toEqual({ generatedAt: 98, lastSyncAt: 99 });
    expect(parseCache(files.get(CACHE_FILE) as string, data.get(KEYS.meta) as string)?.lastSyncAt).toBe(99);
    await saveCache(kv, counting, cache([item("a", "new note")]), last);
    expect(writes).toBe(2);
  });

  it("clearCache removes the file, its temp, the clocks and the old row", async () => {
    const { kv, data } = fakeKV({ [KEYS.meta]: "{}", [KEYS.legacyCache]: "{}" });
    const { fs, files } = fakeFS({ [CACHE_FILE]: cacheFileText(cache([])), [`${CACHE_FILE}.tmp`]: "x" });
    await clearCache(kv, fs);
    expect(files.size).toBe(0);
    expect(data.size).toBe(0);
  });

  it("clearCache throws when the file stays (a new pairing must not start on it)", async () => {
    const { fs } = fakeFS({ [CACHE_FILE]: "x" });
    await expect(clearCache(fakeKV().kv, { ...fs, remove: async () => { throw new Error("busy"); } })).rejects.toThrow();
  });
});

describe("saveRow", () => {
  const listOpts = <T extends { id: string }>(parse: (v: unknown) => T | null, blocked: boolean) => ({ blocked, decode: decodeList(parse), merge: mergeById<T>, encode: (v: T[]) => JSON.stringify(v), now: 7 });

  it("never writes over a row that still can't be read", async () => {
    const { kv, data, badRead } = fakeKV({ [KEYS.ideas]: JSON.stringify([idea("old")]) });
    badRead.add(KEYS.ideas);
    const r = await saveRow(kv, KEYS.ideas, [] as Idea[], listOpts(parseIdea, true));
    expect(r.status).toBe("blocked");
    expect(JSON.parse(data.get(KEYS.ideas) as string)[0].id).toBe("old");
  });

  it("once the blocked row reads, the phone's records are merged into it", async () => {
    const { kv, data } = fakeKV({ [KEYS.outbox]: JSON.stringify([memo("kept-before")]) });
    const r = await saveRow(kv, KEYS.outbox, [memo("new")], listOpts(parseOutItem, true));
    expect(r.status === "ok" && r.value.map((o) => o.id)).toEqual(["new", "kept-before"]);
    expect(JSON.parse(data.get(KEYS.outbox) as string).map((o: OutItem) => o.id)).toEqual(["new", "kept-before"]);
  });

  it("a full storage is 'failed': nothing changes on disk, the caller keeps its data", async () => {
    const { kv, data, badWrite } = fakeKV({ [KEYS.edits]: JSON.stringify({ pending: {}, gone: {} }) });
    badWrite.add("*");
    const mem = { pending: { "song:a": { kind: "song" as const, id: "a", text: "t", baseHash: "811c9dc5", editedAt: 1 } }, gone: {} };
    const r = await saveRow(kv, KEYS.edits, mem, { blocked: false, decode: decodeEdits, merge: mergeEdits, encode: (v) => JSON.stringify(v), now: 1 });
    expect(r.status).toBe("failed");
    expect(JSON.parse(data.get(KEYS.edits) as string).pending).toEqual({});
    // Room again: the same edits go.
    badWrite.clear();
    const again = await saveRow(kv, KEYS.edits, mem, { blocked: false, decode: decodeEdits, merge: mergeEdits, encode: (v) => JSON.stringify(v), now: 2 });
    expect(again.status).toBe("ok");
    expect(JSON.parse(data.get(KEYS.edits) as string).pending["song:a"].text).toBe("t");
  });
});

describe("pure helpers", () => {
  it("parseList flags bad rows and drops duplicate ids", () => {
    expect(parseList(null, parseIdea)).toEqual({ items: [], bad: false });
    expect(parseList("{}", parseIdea).bad).toBe(true);
    expect(parseList(JSON.stringify([idea("a"), idea("a")]), parseIdea).items).toHaveLength(1);
  });

  it("mergeEdits keeps both sides, the phone's wins", () => {
    const p = (text: string) => ({ kind: "song" as const, id: "a", text, baseHash: "", editedAt: 1 });
    expect(mergeEdits({ pending: { x: p("stored"), y: p("y") }, gone: {} }, { pending: { x: p("mem") }, gone: {} }).pending).toEqual({ x: p("mem"), y: p("y") });
  });
});
