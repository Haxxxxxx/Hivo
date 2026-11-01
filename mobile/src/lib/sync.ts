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
export type PendingEdit = Change & { editedAt: number };
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
};

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

export function findItem(state: SyncState, kind: Kind, id: string): Item | undefined {
  return state.items.find((i) => i.kind === kind && i.id === id);
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
  else pending[k] = { kind, id, text: clipped, baseHash, editedAt: now };
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
      const base = findItem(state, r.kind, r.id) ?? { kind: r.kind, id: r.id, title: r.id, subtitle: "", bpm: null, key: null, url: null, stage: null, note: "", noteHash: EMPTY_HASH };
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
      const note = state ? noteFor(state, i.kind, i.id) : i.note;
      return `${i.title}\n${i.subtitle}\n${i.key ?? ""}\n${note}`.toLowerCase().includes(q);
    });
}
