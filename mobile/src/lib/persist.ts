// What the phone keeps between runs, and how it never loses it.
//
// - Small rows in AsyncStorage, each read on its own: the outbox (memo and
//   export records) and the extras binding. Ideas and the phone's note edits
//   are files since 0.8.0 (`withFile`: up to 20,000 characters each, a few
//   dozen of them made a row over the 2 MB cursor window: review #9). One
//   row that can't be read is flagged (`blocked`) and never written over: its
//   content may still be there, and an empty list saved on top of it would
//   wipe unsent ideas and, at the next launch, the memo files (the outbox
//   sweep). A blocked row is read again before each save; once it reads, the
//   phone's records are merged into it.
// - The library cache (every note: megabytes) in a file, written atomically
//   (a temp file, then a move) and only when it changed. It used to be a row
//   next to the others: one multiGet of all of them over Android's 2 MB
//   cursor window threw, and everything read as empty.
// - Rows that parse but hold bad records: the bad records are dropped and the
//   whole row is copied aside first (`<key>.corrupt.<ms>`).
// Pure: the storage and the file system are injected (store.ts wires
// AsyncStorage and expo-file-system), so every failure is tested.
import { parseIdea, type Idea } from "./ideas";
import { parseOutItem, type OutItem } from "./outbox";
import { parseEdits, parseItem, type Edits, type Item, type SyncState } from "./sync";

export const KEYS = {
  ideas: "hivo.ideas.v1",
  outbox: "hivo.outbox.v1",
  /** The computer the ideas' and outbox's "sent" marks are for. */
  bound: "hivo.extras.device.v1",
  /** Note edits not on the computer yet, and notes of items it deleted. */
  edits: "hivo.edits.v1",
  /** The library cache before 0.7.1 (moved to CACHE_FILE once). */
  legacyCache: "hivo.sync.v1",
  /** The cache's two clocks (they change at every sync; the file doesn't have to). */
  meta: "hivo.sync.meta.v1",
} as const;

/** The library cache, in the app's documents. */
export const CACHE_FILE = "library-cache.json";

/** Ideas and note edits, in the app's documents (their rows before 0.8.0). */
export const ROW_FILES = { [KEYS.ideas]: "ideas.json", [KEYS.edits]: "edits.json" } as const;

export type Row = "ideas" | "outbox" | "bound" | "edits";

export type KV = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

/** Files by name in one folder. `read`: null when absent, throws when unreadable. `move` replaces the target. `remove`: nothing when absent. */
export type FS = {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
};

export type LibraryCache = Omit<SyncState, "pending" | "gone">;

type Read = { ok: true; raw: string | null } | { ok: false; error: unknown };

/** One row, on its own: a failure is "unreadable", never "empty". */
export async function readRow(kv: KV, key: string): Promise<Read> {
  try {
    return { ok: true, raw: await kv.get(key) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A stored list: the records that check out, and whether anything was off
 * (`bad`: not JSON, not a list, or some records dropped). */
export function parseList<T>(raw: string | null, parse: (v: unknown) => T | null): { items: T[]; bad: boolean } {
  if (!raw) return { items: [], bad: false };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { items: [], bad: true };
  }
  if (!Array.isArray(v)) return { items: [], bad: true };
  const items: T[] = [];
  const ids = new Set<string>();
  for (const x of v) {
    const p = parse(x);
    const id = (p as { id?: unknown } | null)?.id;
    if (!p || (typeof id === "string" && ids.has(id))) continue;
    if (typeof id === "string") ids.add(id);
    items.push(p);
  }
  return { items, bad: items.length !== v.length };
}

/** The phone's records win; stored ones it doesn't have are kept (never lost). */
export function mergeById<T extends { id: string }>(stored: T[], mem: T[]): T[] {
  const have = new Set(mem.map((m) => m.id));
  return [...mem, ...stored.filter((s) => !have.has(s.id))];
}

export function mergeEdits(stored: Edits, mem: Edits): Edits {
  return { pending: { ...stored.pending, ...mem.pending }, gone: { ...stored.gone, ...mem.gone } };
}

/** Copies a bad row aside before anything replaces it; false when even that failed. */
export async function copyAside(kv: KV, key: string, raw: string, now: number): Promise<boolean> {
  try {
    await kv.set(`${key}.corrupt.${now}`, raw);
    return true;
  } catch {
    return false;
  }
}

const tmpOf = (name: string) => `${name}.tmp`;

/** Writes the temp file, then moves it over the real one: a kill leaves
 * either the old file or the new one complete (see `readAtomic`). */
export async function writeAtomic(fs: FS, name: string, text: string): Promise<void> {
  await fs.write(tmpOf(name), text);
  await fs.move(tmpOf(name), name);
}

/** The file, or the temp one when a kill came between the move's delete and its rename. */
export async function readAtomic(fs: FS, name: string): Promise<Read> {
  try {
    const main = await fs.read(name);
    if (main !== null) return { ok: true, raw: main };
    return { ok: true, raw: await fs.read(tmpOf(name)) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * `kv` with one key kept in a file instead of its row. Read: the file, else
 * the old row while it's still there (a kill during the first write, between
 * the move's delete and its rename, finds the row, which still holds the
 * last save), else the temp file; an unreadable file or row throws, so the
 * caller's "blocked, never written over" holds for both. Write: the file
 * (atomic), then the old row goes, so the file is the only copy from the
 * first good save on (a remove that fails fails the save: tried again).
 * Every other key is the plain row.
 */
export function withFile(kv: KV, fs: FS, key: string, file: string): KV {
  return {
    async get(k) {
      if (k !== key) return kv.get(k);
      const main = await fs.read(file);
      if (main !== null) return main;
      return (await kv.get(key)) ?? (await fs.read(tmpOf(file)));
    },
    async set(k, v) {
      if (k !== key) return kv.set(k, v);
      await writeAtomic(fs, file, v);
      await kv.remove(key);
    },
    async remove(k) {
      if (k !== key) return kv.remove(k);
      await fs.remove(tmpOf(file));
      await fs.remove(file);
      await kv.remove(key);
    },
  };
}

/** The phone's storage: rows, with ideas and edits in their files. */
export const phoneKV = (kv: KV, fs: FS): KV =>
  Object.entries(ROW_FILES).reduce<KV>((acc, [key, file]) => withFile(acc, fs, key, file), kv);

const marks = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  return out;
};

/** A cache read back (file + clocks, or a pre-0.7.1 row): every item checked with `parseItem`. Null when unusable. */
export function parseCache(raw: string | null, metaRaw: string | null = null): LibraryCache | null {
  if (!raw) return null;
  let v: Record<string, unknown>;
  let meta: Record<string, unknown> = {};
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
    if (metaRaw) meta = (JSON.parse(metaRaw) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !Array.isArray(v.items)) return null;
  const items = (v.items as unknown[]).map(parseItem).filter((i): i is Item => i !== null);
  const clock = (k: string): number | null => {
    const n = meta[k] ?? v[k];
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  return {
    items,
    generatedAt: clock("generatedAt"),
    lastSyncAt: clock("lastSyncAt"),
    conflicts: marks(v.conflicts),
    ...(v.tooLong ? { tooLong: marks(v.tooLong) } : {}),
    helloDone: v.helloDone === true,
    ...(v.rebase === true ? { rebase: true } : {}),
  };
}

/** The cache file's text: what only changes with the library (the clocks go in the meta row). */
export function cacheFileText(c: LibraryCache): string {
  return JSON.stringify({ v: 1, items: c.items, conflicts: c.conflicts, tooLong: c.tooLong ?? {}, helloDone: c.helloDone, ...(c.rebase ? { rebase: true } : {}) });
}

export const cacheMetaText = (c: LibraryCache): string => JSON.stringify({ generatedAt: c.generatedAt, lastSyncAt: c.lastSyncAt });

export type Loaded = {
  ideas: Idea[];
  outbox: OutItem[];
  bound: string | null;
  edits: Edits;
  cache: LibraryCache | null;
  /** Rows that couldn't be read (or were bad and couldn't be copied aside): never written over. */
  blocked: Row[];
  /** The outbox row read and parsed whole: files no record points to may be swept. */
  outboxClean: boolean;
  /** Bad records dropped (copied aside), for the log. */
  dropped: Row[];
};

/** Reads everything, one row at a time. Never throws. */
export async function loadAll(kv: KV, fs: FS, now: number): Promise<Loaded> {
  const blocked: Row[] = [];
  const dropped: Row[] = [];
  const [ideasRow, outRow, boundRow, editsRow] = [await readRow(kv, KEYS.ideas), await readRow(kv, KEYS.outbox), await readRow(kv, KEYS.bound), await readRow(kv, KEYS.edits)];

  const list = async <T>(row: Row, key: string, r: Read, parse: (v: unknown) => T | null): Promise<{ items: T[]; clean: boolean }> => {
    if (!r.ok) {
      blocked.push(row);
      return { items: [], clean: false };
    }
    const p = parseList(r.raw, parse);
    if (p.bad && r.raw) {
      dropped.push(row);
      if (!(await copyAside(kv, key, r.raw, now))) blocked.push(row);
    }
    return { items: p.items, clean: !p.bad };
  };
  const ideas = await list("ideas", KEYS.ideas, ideasRow, parseIdea);
  const outbox = await list("outbox", KEYS.outbox, outRow, parseOutItem);
  if (!boundRow.ok) blocked.push("bound");
  const bound = boundRow.ok ? boundRow.raw || null : null;

  // The cache: the file, else the old row (moved to the file once).
  let cache: LibraryCache | null = null;
  const file = await readAtomic(fs, CACHE_FILE);
  const metaRow = await readRow(kv, KEYS.meta);
  if (file.ok && file.raw !== null) cache = parseCache(file.raw, metaRow.ok ? metaRow.raw : null);
  // The old row: read while there's no file yet, or no edits row (it may hold them).
  const legacy: Read | null = (file.ok && file.raw === null) || (editsRow.ok && editsRow.raw === null) ? await readRow(kv, KEYS.legacyCache) : null;

  // Edits: their own row; before 0.6.2 they lived inside the cache row.
  let edits: Edits = { pending: {}, gone: {} };
  let editsFromLegacy = false;
  if (!editsRow.ok) blocked.push("edits");
  else {
    const raw = editsRow.raw ?? (legacy?.ok ? legacy.raw : null);
    editsFromLegacy = editsRow.raw === null && raw !== null;
    if (raw) {
      try {
        edits = parseEdits(JSON.parse(raw));
      } catch {
        dropped.push("edits");
        if (!editsFromLegacy && !(await copyAside(kv, KEYS.edits, raw, now))) blocked.push("edits");
      }
    }
  }

  if (legacy?.ok && legacy.raw) {
    // Moved once, in an order a kill can't break: the edits it held get their
    // own row first, then the cache its file, and only then the row goes.
    const fromRow = cache ? null : parseCache(legacy.raw);
    try {
      if (editsFromLegacy) await kv.set(KEYS.edits, JSON.stringify(edits));
      if (fromRow) {
        await writeAtomic(fs, CACHE_FILE, cacheFileText(fromRow));
        await kv.set(KEYS.meta, cacheMetaText(fromRow));
      }
      await kv.remove(KEYS.legacyCache);
    } catch {
      // Tried again at the next launch; the row stays meanwhile.
    }
    cache = cache ?? fromRow;
  } else if (legacy && !legacy.ok && editsRow.ok && editsRow.raw !== null) {
    // Unreadable (too big for the cursor window) and nothing in it the phone
    // doesn't have elsewhere: the next sync brings the library back.
    await kv.remove(KEYS.legacyCache).catch(() => {});
  } else if (cache && file.ok && file.raw !== null && !(legacy?.ok && legacy.raw)) {
    // The new cache file is there and good: an old row left behind (not read
    // because the file exists, or unreadable) is only dead weight (review #15).
    await kv.remove(KEYS.legacyCache).catch(() => {});
  }

  return { ideas: ideas.items, outbox: outbox.items, bound, edits, cache, blocked: [...new Set(blocked)], outboxClean: outRow.ok && outbox.clean, dropped: [...new Set(dropped)] };
}

export type Saved<T> = { status: "ok"; value: T } | { status: "blocked" } | { status: "failed"; error: unknown };

/**
 * Saves one row. A row that's `blocked` is read again first: still
 * unreadable, nothing is written ("blocked"); readable now, the phone's
 * value is merged into what's there and saved ("ok" with the merged value,
 * to show). A write that fails (storage full) leaves the phone's value in
 * memory, saved at the next try ("failed").
 */
export async function saveRow<T>(
  kv: KV,
  key: string,
  value: T,
  opts: { blocked: boolean; decode: (raw: string | null) => T | null; merge: (stored: T, mem: T) => T; encode: (v: T) => string; now: number },
): Promise<Saved<T>> {
  let next = value;
  if (opts.blocked) {
    const r = await readRow(kv, key);
    if (!r.ok) return { status: "blocked" };
    const stored = opts.decode(r.raw);
    if (stored === null) {
      if (r.raw && !(await copyAside(kv, key, r.raw, opts.now))) return { status: "blocked" };
    } else next = opts.merge(stored, value);
  }
  try {
    await kv.set(key, opts.encode(next));
    return { status: "ok", value: next };
  } catch (error) {
    return { status: "failed", error };
  }
}

/** Decoders for `saveRow`: null when the row doesn't parse at all. */
export function decodeList<T>(parse: (v: unknown) => T | null): (raw: string | null) => T[] | null {
  return (raw) => {
    if (!raw) return [];
    const p = parseList(raw, parse);
    return p.bad && p.items.length === 0 ? null : p.items;
  };
}

export const decodeEdits = (raw: string | null): Edits | null => {
  if (!raw) return { pending: {}, gone: {} };
  try {
    return parseEdits(JSON.parse(raw));
  } catch {
    return null;
  }
};

/**
 * Saves the library cache: the file only when its text changed (`last`, the
 * text written last), the clocks in their small row. Returns the text now on
 * disk. Throws when the file can't be written (the caller keeps `last`).
 */
export async function saveCache(kv: KV, fs: FS, cache: LibraryCache, last: string | null): Promise<string> {
  const text = cacheFileText(cache);
  if (text !== last) await writeAtomic(fs, CACHE_FILE, text);
  await kv.set(KEYS.meta, cacheMetaText(cache)).catch(() => {});
  return text;
}

/** Forgets the cache (unpair, another computer, "Reset this phone's cache").
 * Throws when the file stays: a new pairing must not start on another
 * computer's library. */
export async function clearCache(kv: KV, fs: FS): Promise<void> {
  await fs.remove(tmpOf(CACHE_FILE));
  await fs.remove(CACHE_FILE);
  await kv.remove(KEYS.meta).catch(() => {});
  await kv.remove(KEYS.legacyCache).catch(() => {});
}
