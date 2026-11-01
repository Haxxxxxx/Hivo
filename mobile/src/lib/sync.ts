// Offline-first note sync (PHONE-SYNC contract, /v1/snapshot and /v1/notes).
// Pure state transitions: the app persists the state and does the I/O.
import { fnv1a, utf8 } from "./bytes";
import { clip } from "./text";

export type Kind = "prod" | "beat" | "song";
export const KINDS: Kind[] = ["prod", "beat", "song"];

export type Item = {
  kind: Kind;
  id: string;
  title: string;
  subtitle: string;
  bpm: number | null;
  key: string | null;
  url: string | null;
  stage: string | null;
  note: string;
  noteHash: string;
};

export type Change = { kind: Kind; id: string; text: string; baseHash: string };
/** `title`: the item's name when the edit was made, so an edit kept across
 * a re-pairing can still be shown (and copied) before any snapshot. */
export type PendingEdit = Change & { editedAt: number; title?: string };
export type PushResult = { kind: Kind; id: string; status: "applied" | "conflict" | "missing"; note: string; noteHash: string };

export type SyncState = {
  items: Item[];
  generatedAt: number | null;
  lastSyncAt: number | null;
  /** Edits not yet accepted by the desktop, by itemKey. */
  pending: Record<string, PendingEdit>;
  /** Notes the desktop merged (conflict), by itemKey → when. Cleared when dismissed. */
  conflicts: Record<string, number>;
  /** Items the desktop no longer has ("missing" on push), kept with the
   * phone's text so nothing typed is lost. By itemKey. */
  gone: Record<string, Item>;
  helloDone: boolean;
  /** The pending edits were made against another pairing (unpaired, then
   * paired again): the next sync pulls a snapshot first and re-bases them. */
  rebase?: boolean;
};

/** What's kept across unpairing (the phone's own text), stored apart from
 * the big library cache. */
export type Edits = Pick<SyncState, "pending" | "gone">;

export const MAX_NOTE_CHARS = 20_000;
export const MAX_CHANGES = 500;
/** Bytes of note text per push: the desktop refuses bodies over 1 MB, and
 * the envelope (JSON + base64url) grows the text by about 4/3. */
export const MAX_PUSH_TEXT_BYTES = 600_000;
export const EMPTY_HASH = "811c9dc5";

export const emptyState = (): SyncState => ({ items: [], generatedAt: null, lastSyncAt: null, pending: {}, conflicts: {}, gone: {}, helloDone: false });

export const itemKey = (kind: Kind, id: string): string => `${kind}:${id}`;

const isKind = (v: unknown): v is Kind => v === "prod" || v === "beat" || v === "song";
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const strOrNull = (v: unknown, max = 500): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);

/** Validates one snapshot item from the desktop; null when unusable. */
export function parseItem(raw: unknown): Item | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isKind(r.kind) || typeof r.id !== "string" || !r.id) return null;
  const note = typeof r.note === "string" ? r.note : "";
  const url = strOrNull(r.url, 2000);
  return {
    kind: r.kind,
    id: r.id,
    title: str(r.title) || r.id.split(/[\\/]/).pop() || r.id,
    subtitle: str(r.subtitle),
    bpm: typeof r.bpm === "number" && Number.isFinite(r.bpm) ? r.bpm : null,
    key: strOrNull(r.key, 20),
    url: url && /^https:\/\//i.test(url) ? url : null,
    stage: strOrNull(r.stage, 40),
    note,
    noteHash: typeof r.noteHash === "string" && /^[0-9a-f]{8}$/.test(r.noteHash) ? r.noteHash : fnv1a(note),
  };
}

export function parseSnapshot(body: unknown): { items: Item[]; generatedAt: number } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.items)) return null;
  const items = b.items.map(parseItem).filter((i): i is Item => i !== null);
  return { items, generatedAt: typeof b.generatedAt === "number" ? b.generatedAt : Date.now() };
}

export function parsePushResults(body: unknown): PushResult[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { results?: unknown }).results)) return null;
  const out: PushResult[] = [];
  for (const raw of (body as { results: unknown[] }).results) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (!isKind(r.kind) || typeof r.id !== "string") continue;
    if (r.status !== "applied" && r.status !== "conflict" && r.status !== "missing") continue;
    const note = typeof r.note === "string" ? r.note : "";
    out.push({ kind: r.kind, id: r.id, status: r.status, note, noteHash: typeof r.noteHash === "string" ? r.noteHash : fnv1a(note) });
  }
  return out;
}

// The items by key, built once per snapshot array (a library of thousands is
// searched and rendered row by row: no linear scan per row).
const indexes = new WeakMap<Item[], Map<string, Item>>();
function indexOf(items: Item[]): Map<string, Item> {
  let m = indexes.get(items);
  if (!m) {
    m = new Map(items.map((i) => [itemKey(i.kind, i.id), i]));
    indexes.set(items, m);
  }
  return m;
}

export function findItem(state: SyncState, kind: Kind, id: string): Item | undefined {
  return indexOf(state.items).get(itemKey(kind, id));
}

/** The note to show: the local edit when there is one, else the desktop's. */
export function noteFor(state: SyncState, kind: Kind, id: string): string {
  const k = itemKey(kind, id);
  return state.pending[k]?.text ?? state.gone[k]?.note ?? findItem(state, kind, id)?.note ?? "";
}

export const isGone = (state: SyncState, kind: Kind, id: string): boolean => itemKey(kind, id) in state.gone;

/** What the Library lists: the desktop's items, then the ones it deleted. */
export function allItems(state: SyncState): Item[] {
  return Object.keys(state.gone).length === 0 ? state.items : [...state.items, ...Object.values(state.gone)];
}

/** Removes a gone item (and its text) from the phone. */
export function forgetGone(state: SyncState, kind: Kind, id: string): SyncState {
  const gone = { ...state.gone };
  delete gone[itemKey(kind, id)];
  return { ...state, gone };
}

/** Records a local edit. The base hash is the desktop note the edit started
 * from, so it stays the same across several edits until a push lands. */
export function editNote(state: SyncState, kind: Kind, id: string, text: string, now: number): SyncState {
  const k = itemKey(kind, id);
  const clipped = clip(text, MAX_NOTE_CHARS);
  const goneItem = state.gone[k];
  if (goneItem) {
    // Nothing to push to: the text only lives on the phone.
    return { ...state, gone: { ...state.gone, [k]: { ...goneItem, note: clipped, noteHash: fnv1a(clipped) } } };
  }
  const item = findItem(state, kind, id);
  const prev = state.pending[k];
  const baseHash = prev?.baseHash ?? item?.noteHash ?? EMPTY_HASH;
  const pending = { ...state.pending };
  if (item && clipped === item.note && baseHash === item.noteHash) delete pending[k];
  else {
    const title = item?.title ?? prev?.title;
    pending[k] = { kind, id, text: clipped, baseHash, editedAt: now, ...(title ? { title } : {}) };
  }
  return { ...state, pending };
}

/** The next batch to push, oldest edit first: at most MAX_CHANGES and
 * MAX_PUSH_TEXT_BYTES of text (always at least one change). */
export function pendingChanges(state: SyncState): Change[] {
  const out: Change[] = [];
  let bytes = 0;
  for (const { kind, id, text, baseHash } of Object.values(state.pending).sort((a, b) => a.editedAt - b.editedAt)) {
    const size = utf8(text).length + utf8(id).length + 64;
    if (out.length >= MAX_CHANGES || (out.length > 0 && bytes + size > MAX_PUSH_TEXT_BYTES)) break;
    out.push({ kind, id, text, baseHash });
    bytes += size;
  }
  return out;
}

/** Applies the desktop's answer to a push. `sent` is what was pushed: an
 * edit made while the push was in flight stays pending. */
export function applyPushResults(state: SyncState, sent: Change[], results: PushResult[], now: number): SyncState {
  const pending = { ...state.pending };
  const conflicts = { ...state.conflicts };
  const gone = { ...state.gone };
  let items = state.items;
  for (const r of results) {
    const k = itemKey(r.kind, r.id);
    const was = sent.find((c) => c.kind === r.kind && c.id === r.id);
    if (!was) continue;
    const cur = pending[k];
    const unchanged = cur !== undefined && cur.text === was.text && cur.baseHash === was.baseHash;
    if (r.status === "missing") {
      // Deleted on the desktop since: keep the phone's text, marked as gone.
      const text = cur?.text ?? was.text;
      const base = findItem(state, r.kind, r.id) ?? bareItem(r.kind, r.id, cur?.title);
      gone[k] = { ...base, note: text, noteHash: fnv1a(text) };
      delete pending[k];
      delete conflicts[k];
      items = items.filter((i) => !(i.kind === r.kind && i.id === r.id));
      continue;
    }
    items = items.map((i) => (i.kind === r.kind && i.id === r.id ? { ...i, note: r.note, noteHash: r.noteHash } : i));
    if (r.status === "conflict") conflicts[k] = now;
    if (unchanged) delete pending[k];
    else if (cur && r.status === "applied") {
      // Typed more during the push: the desktop now holds what was sent, so
      // the newer text builds on that.
      pending[k] = { ...cur, baseHash: r.noteHash };
    }
    // After a conflict a newer edit keeps its old base: the next push
    // conflicts again and the desktop keeps both texts. Nothing is lost.
  }
  return { ...state, items, pending, conflicts, gone };
}

/** Replaces the cached items with a fresh snapshot. Pending edits stay on
 * top. A gone item that came back (relinked folder) becomes a normal edit
 * again, so its text goes to the desktop on the next push. */
export function applySnapshot(state: SyncState, snap: { items: Item[]; generatedAt: number }, now: number): SyncState {
  let next: SyncState = { ...state, items: snap.items, generatedAt: snap.generatedAt, lastSyncAt: now };
  for (const [k, g] of Object.entries(state.gone)) {
    const back = snap.items.find((i) => itemKey(i.kind, i.id) === k);
    if (!back) continue;
    next = forgetGone(next, g.kind, g.id);
    if (g.note !== back.note) next = editNote(next, g.kind, g.id, g.note, now);
  }
  return next;
}

/** An item known only by its key (and maybe the title it had). */
function bareItem(kind: Kind, id: string, title?: string): Item {
  return { kind, id, title: title || id.split(/[\\/]/).pop() || id, subtitle: "", bpm: null, key: null, url: null, stage: null, note: "", noteHash: EMPTY_HASH };
}

/**
 * The first snapshot after a new pairing, for edits made against the old
 * one. An edit whose item is there stays pending with its old base: when the
 * computer's note changed meanwhile, the push conflicts and the computer
 * keeps both texts (nothing overwritten). An edit that now says the same as
 * the computer is dropped. An edit whose item isn't there (another computer)
 * becomes "gone": the text stays on the phone, shown and copyable.
 */
export function rebaseOnSnapshot(state: SyncState, snap: { items: Item[] }): SyncState {
  const byKey = indexOf(snap.items);
  const pending = { ...state.pending };
  const gone = { ...state.gone };
  for (const [k, p] of Object.entries(state.pending)) {
    const there = byKey.get(k);
    if (there) {
      if (there.note === p.text) delete pending[k];
      continue;
    }
    gone[k] = { ...bareItem(p.kind, p.id, p.title), note: p.text, noteHash: fnv1a(p.text) };
    delete pending[k];
  }
  return { ...state, pending, gone, rebase: false };
}

/** The phone's own text (pending edits and gone items), split from the library cache. */
export const editsOf = (s: SyncState): Edits => ({ pending: s.pending, gone: s.gone });

/** The library cache without the phone's own text (kept under its own key). */
export function cacheOf(s: SyncState): Omit<SyncState, "pending" | "gone"> {
  const { pending: _p, gone: _g, ...rest } = s;
  return rest;
}

/** Validates stored edits; anything malformed is left out, never thrown. */
export function parseEdits(raw: unknown): Edits {
  const out: Edits = { pending: {}, gone: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (r.pending && typeof r.pending === "object") {
    for (const [k, v] of Object.entries(r.pending as Record<string, unknown>)) {
      const p = v as Partial<PendingEdit> | null;
      if (p && isKind(p.kind) && typeof p.id === "string" && typeof p.text === "string" && typeof p.baseHash === "string" && typeof p.editedAt === "number" && k === itemKey(p.kind, p.id)) {
        out.pending[k] = { kind: p.kind, id: p.id, text: p.text, baseHash: p.baseHash, editedAt: p.editedAt, ...(typeof p.title === "string" ? { title: p.title } : {}) };
      }
    }
  }
  if (r.gone && typeof r.gone === "object") {
    for (const [k, v] of Object.entries(r.gone as Record<string, unknown>)) {
      const g = parseItem(v);
      if (g && k === itemKey(g.kind, g.id)) out.gone[k] = g;
    }
  }
  return out;
}

/** A fresh state for a new (or no) pairing that keeps the phone's own text. */
export function keepEdits(edits: Edits): SyncState {
  return { ...emptyState(), pending: edits.pending, gone: edits.gone, rebase: Object.keys(edits.pending).length > 0 };
}

/** Every note the computer doesn't have yet, as plain text (to copy before unpairing). */
export function unsyncedText(state: SyncState): string {
  const blocks: string[] = [];
  for (const p of Object.values(state.pending).sort((a, b) => a.editedAt - b.editedAt)) {
    const title = findItem(state, p.kind, p.id)?.title ?? p.title ?? bareItem(p.kind, p.id).title;
    blocks.push(`${title}\n${"-".repeat(Math.min(40, Math.max(3, title.length)))}\n${p.text}`);
  }
  for (const g of Object.values(state.gone)) {
    if (g.note.trim()) blocks.push(`${g.title}\n${"-".repeat(Math.min(40, Math.max(3, g.title.length)))}\n${g.note}`);
  }
  return blocks.join("\n\n");
}

export function dismissConflict(state: SyncState, kind: Kind, id: string): SyncState {
  const conflicts = { ...state.conflicts };
  delete conflicts[itemKey(kind, id)];
  return { ...state, conflicts };
}

export type Call = (path: string, payload: unknown) => Promise<unknown>;

/** One sync: hello (first time), push queued notes, pull the snapshot.
 * Reads the latest state through `get` after each await so edits made while
 * a request is in flight are never overwritten. */
export async function runSync(
  call: Call,
  get: () => SyncState,
  set: (s: SyncState) => void,
  hello: { phoneName: string; appVersion: string },
  now: () => number,
): Promise<{ desktopName?: string; conflicts: number; missing: number }> {
  let desktopName: string | undefined;
  if (!get().helloDone) {
    const h = (await call("/v1/hello", hello)) as { desktopName?: unknown } | null;
    if (h && typeof h.desktopName === "string" && h.desktopName.trim()) desktopName = h.desktopName.trim().slice(0, 80);
    set({ ...get(), helloDone: true });
  }
  // Edits kept from an earlier pairing: see what this computer has first.
  if (get().rebase) {
    const first = parseSnapshot(await call("/v1/snapshot", {}));
    if (!first) throw new Error("bad snapshot response");
    set(rebaseOnSnapshot(applySnapshot(get(), first, now()), first));
  }
  let conflicts = 0;
  let missing = 0;
  // Push in batches until the queue is empty (or stops shrinking).
  for (let round = 0; round < 50; round++) {
    const changes = pendingChanges(get());
    if (changes.length === 0) break;
    const results = parsePushResults(await call("/v1/notes", { changes }));
    if (!results) throw new Error("bad notes response");
    conflicts += results.filter((r) => r.status === "conflict").length;
    missing += results.filter((r) => r.status === "missing").length;
    const before = Object.keys(get().pending).length;
    set(applyPushResults(get(), changes, results, now()));
    if (Object.keys(get().pending).length >= before) break;
  }
  const snap = parseSnapshot(await call("/v1/snapshot", {}));
  if (!snap) throw new Error("bad snapshot response");
  set(applySnapshot(get(), snap, now()));
  return { desktopName, conflicts, missing };
}

/** Search + tab filter for the Library. */
export function filterItems(items: Item[], kind: Kind, query: string, state?: SyncState): Item[] {
  const q = query.trim().toLowerCase();
  return items
    .filter((i) => i.kind === kind)
    .filter((i) => {
      if (!q) return true;
      const k = itemKey(i.kind, i.id);
      const note = state ? (state.pending[k]?.text ?? state.gone[k]?.note ?? i.note) : i.note;
      return `${i.title}\n${i.subtitle}\n${i.key ?? ""}\n${note}`.toLowerCase().includes(q);
    });
}
