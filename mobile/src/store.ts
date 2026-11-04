// App state: the pairing (secure store), the cached library (a file), the
// phone's own note edits (kept across pairings), ideas and the outbox
// (AsyncStorage rows), and the sync status. A tiny external store, read with
// useSyncExternalStore. How storage never loses a row: lib/persist.ts.
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import * as Device from "expo-device";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { localIPv4s, probeTcp } from "../modules/hivo-share";
import { CancelledError, createClient, SyncError, type SyncErrorCode, type Transport } from "./lib/client";
import { carryOver, confirmedPairing, extrasBinding, waitForConfirmation } from "./lib/confirm";
import { lookAgain, PROBE_TIMEOUT_MS, SAVED_TIMEOUT_MS, withFound, type LookProgress, type LookResult } from "./lib/discover";
import { completePairing, computerIdOf } from "./lib/handshake";
import type { PairOffer, Pairing } from "./lib/pairing";
import { createPendingSaves } from "./lib/pendingSave";
import { clearCache, decodeEdits, decodeList, KEYS, loadAll, mergeById, mergeEdits, phoneKV, saveCache, saveRow, type KV, type LibraryCache, type Row } from "./lib/persist";
import { onForeground } from "./lib/syncGate";
import { clip, safeFileName } from "./lib/text";
import { desktopIsOlder } from "./lib/update";
import {
  cacheOf,
  dismissConflict,
  editNote,
  editsOf,
  emptyState,
  forgetGone,
  keepEdits,
  runSync,
  unsyncedText,
  type Edits,
  type Kind,
  type SyncState,
} from "./lib/sync";
import {
  applyIdeaResults,
  applyIdeaStatuses,
  createIdea,
  deleteIdea,
  dropEmptyIdeas,
  editIdea,
  ideaPayload,
  ideasToPush,
  newId,
  parseIdea,
  parseIdeaResults,
  pruneIdeas,
  resetSent,
  type Idea,
  type IdeaTarget,
} from "./lib/ideas";
import {
  applyOutStatuses,
  KEEP_SENT_MS,
  keepDraft,
  parseInboxStatuses,
  parseOutItem,
  pruneOut,
  resetOut,
  retry,
  sendQueue,
  type HoldReason,
  type OutFile,
  type OutItem,
  type OutState,
  type OutType,
} from "./lib/outbox";
import { dataFS, fileExists, readChunk, removeItemFiles, sweepOutbox, sweepRecordings } from "./files";

const PAIRING_KEY = "hivo.pairing.v1";
const SENDING_AWAKE_TAG = "hivo-sending";

/** Why ideas / memos / exports didn't go (notes may have synced fine). */
export type ExtrasError = "outdated" | "demo" | HoldReason;

export type AppState = {
  loaded: boolean;
  pairing: Pairing | null;
  /** The secure store couldn't be read (not "not paired"): show it with
   * `retryPairingRead`, never the pairing screen. The pairing is still saved. */
  pairingUnreadable: boolean;
  sync: SyncState;
  syncing: boolean;
  error: SyncErrorCode | null;
  errorDetail: string | null;
  ideas: Idea[];
  outbox: OutItem[];
  extrasError: ExtrasError | null;
  /** The outbox item being sent right now. */
  sending: string | null;
  /** The computer's Hivo is older (major.minor) than this app: "Update Hivo on the computer". */
  desktopOutdated: boolean;
  /** Paired, waiting for the user to confirm on the computer that it shows this code. */
  confirming: { code: string; desktopName: string; startedAt: number } | null;
  /** Looking for the computer again (Settings, only when tapped): its saved
   * addresses, then this Wi-Fi. `lookProgress`: how far it got. */
  rediscovering: boolean;
  lookProgress: LookProgress | null;
  /** Storage trouble: rows that can't be read (kept, never written over) and
   * whether the last save failed (storage full: everything stays in memory
   * and is saved at the next try). */
  storage: { blocked: Row[]; saveFailed: boolean };
};

let state: AppState = {
  loaded: false,
  pairing: null,
  pairingUnreadable: false,
  sync: emptyState(),
  syncing: false,
  error: null,
  errorDetail: null,
  ideas: [],
  outbox: [],
  extrasError: null,
  sending: null,
  desktopOutdated: false,
  confirming: null,
  rediscovering: false,
  lookProgress: null,
  storage: { blocked: [], saveFailed: false },
};

/** What the open editors still hold (debounced): saved before the app goes to the background. */
export const pendingSaves = createPendingSaves((e) => console.warn("Hivo: an editor's save failed", e));
let boundDevice: string | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const getState = (): AppState => state;

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

const kv: KV = phoneKV(
  {
    get: (k) => AsyncStorage.getItem(k),
    set: (k, v) => AsyncStorage.setItem(k, v),
    remove: (k) => AsyncStorage.removeItem(k),
  },
  dataFS,
);

// ---- Storage ----

const blocked = new Set<Row>();
function noteStorage(row: Row | null, result: { status: string }): void {
  if (row) {
    if (result.status === "ok") blocked.delete(row);
    else if (result.status === "blocked") blocked.add(row);
  }
  const blockedNow = [...blocked];
  const saveFailed = result.status === "failed";
  if (saveFailed || blockedNow.join() !== state.storage.blocked.join() || state.storage.saveFailed !== saveFailed) setState({ storage: { blocked: blockedNow, saveFailed } });
}

// Persistence of the edits and the cache, debounced (the note editor writes on every keystroke).
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSoon(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void flush(), 300);
}

/** The cache file's text as last written (it's rewritten only when it changed). */
let lastCacheText: string | null = null;
/** The cache parts last written, by identity: unchanged, nothing to compare. */
let lastCacheParts: unknown[] = [];
let saveChain: Promise<unknown> = Promise.resolve();

/** One save at a time, in order (a later one always sees the latest state). */
function serial(fn: () => Promise<void>): Promise<void> {
  const next = saveChain.then(fn, fn);
  saveChain = next.catch(() => {});
  return next;
}

/** Saves the phone's edits (always, their own row) and the library cache
 * (when paired, its own file, only when it changed). One failing never
 * stops the other. Never throws. */
export function flush(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  return serial(async () => {
    const edits = editsOf(state.sync);
    const r = await saveRow<Edits>(kv, KEYS.edits, edits, { blocked: blocked.has("edits"), decode: decodeEdits, merge: mergeEdits, encode: (v) => JSON.stringify(v), now: Date.now() });
    noteStorage("edits", r);
    if (r.status === "ok" && r.value !== edits) setState({ sync: { ...state.sync, pending: r.value.pending, gone: r.value.gone } });
    if (r.status === "failed") console.warn("Hivo: could not save the note edits", r.error);
    if (!state.pairing) return;
    const c = cacheOf(state.sync);
    const parts = [c.items, c.conflicts, c.tooLong, c.helloDone, c.rebase, c.generatedAt, c.lastSyncAt];
    if (parts.every((p, i) => p === lastCacheParts[i])) return;
    try {
      lastCacheText = await saveCache(kv, dataFS, c, lastCacheText);
      lastCacheParts = parts;
    } catch (e) {
      console.warn("Hivo: could not save the library cache", e);
      noteStorage(null, { status: "failed" });
    }
  });
}

function setSync(sync: SyncState): void {
  setState({ sync });
  persistSoon();
}

// Ideas and the outbox, saved on their own (kept when unpairing).
let extrasTimer: ReturnType<typeof setTimeout> | null = null;
function persistExtrasSoon(): void {
  if (extrasTimer) clearTimeout(extrasTimer);
  extrasTimer = setTimeout(() => void flushExtras(), 300);
}

/** Saves ideas, the outbox and the binding, each in its own row. A row that
 * couldn't be read is never written over (read again first, then merged).
 * Never throws; true when ideas and the outbox are on disk now (a share's
 * copies may go only then: review #8). */
export async function flushExtras(): Promise<boolean> {
  if (extrasTimer) clearTimeout(extrasTimer);
  extrasTimer = null;
  let saved = false;
  await serial(async () => {
    const now = Date.now();
    const ideas = state.ideas;
    const ri = await saveRow<Idea[]>(kv, KEYS.ideas, ideas, { blocked: blocked.has("ideas"), decode: decodeList(parseIdea), merge: mergeById, encode: (v) => JSON.stringify(v), now });
    noteStorage("ideas", ri);
    if (ri.status === "ok" && ri.value !== ideas) setState({ ideas: mergeById(ri.value, state.ideas) });
    const outbox = state.outbox;
    const ro = await saveRow<OutItem[]>(kv, KEYS.outbox, outbox, { blocked: blocked.has("outbox"), decode: decodeList(parseOutItem), merge: mergeById, encode: (v) => JSON.stringify(v), now });
    noteStorage("outbox", ro);
    if (ro.status === "ok" && ro.value !== outbox) setState({ outbox: mergeById(ro.value, state.outbox) });
    const rb = await saveRow<string>(kv, KEYS.bound, boundDevice ?? "", { blocked: blocked.has("bound"), decode: (raw) => raw ?? "", merge: (stored, mem) => mem || stored, encode: (v) => v, now });
    noteStorage("bound", rb);
    if (rb.status === "ok") boundDevice = rb.value || null;
    for (const r of [ri, ro, rb]) if (r.status === "failed") console.warn("Hivo: could not save ideas and memos", r.error);
    saved = ri.status === "ok" && ro.status === "ok";
  }).catch((e) => console.warn("Hivo: could not save ideas and memos", e));
  return saved;
}

/** `now`: a new or removed record is saved at once (a kill must not lose it); edits are debounced. */
function setIdeas(ideas: Idea[], now = false): void {
  setState({ ideas });
  if (now) void flushExtras();
  else persistExtrasSoon();
}

function setOutbox(outbox: OutItem[], now = false): void {
  setState({ outbox });
  if (now) void flushExtras();
  else persistExtrasSoon();
}

function replaceOut(item: OutItem): void {
  setOutbox(state.outbox.map((i) => (i.id === item.id ? item : i)));
}

const randomId = () => newId(getRandomBytes);

// ---- Ideas ----

/** A new idea (empty ones aren't sent); returns its id. */
export function addIdea(init: { title?: string; text?: string; target?: IdeaTarget | null } = {}): string {
  const id = randomId();
  setIdeas([createIdea(id, Date.now(), init), ...state.ideas], true);
  return id;
}

export function updateIdea(id: string, patch: Partial<Pick<Idea, "title" | "text" | "target">>): void {
  setIdeas(editIdea(state.ideas, id, patch, Date.now()));
}

export function removeIdea(id: string): void {
  setIdeas(deleteIdea(state.ideas, id, Date.now()), true);
}

// ---- Outbox (memos and shared files) ----

/** Adds files already moved into the outbox folder (files.ts `adopt`) as one
 * item, saved at once. `state: "draft"`: a take not kept yet (never sent). */
export function addOutItem(
  id: string,
  type: OutType,
  files: OutFile[],
  init: { title?: string; text?: string; target?: IdeaTarget | null; durationMs?: number | null; state?: Extract<OutState, "draft" | "waiting"> } = {},
): void {
  const item: OutItem = {
    id,
    type,
    title: clip(init.title ?? "", 200),
    ...(init.text ? { text: clip(init.text, 2000) } : {}),
    target: init.target ?? null,
    createdAt: Date.now(),
    durationMs: init.durationMs ?? null,
    files,
    state: init.state ?? "waiting",
    error: null,
    sentBytes: 0,
    status: null,
    filedTo: null,
    sentAt: null,
  };
  setOutbox([item, ...state.outbox], true);
}

/** Keep on a draft take (RecordScreen): named, aimed, queued, saved at once. */
export function keepDraftOut(id: string, init: { title: string; target: IdeaTarget | null; fallbackName: string }): boolean {
  const cur = state.outbox.find((i) => i.id === id);
  if (!cur || cur.state !== "draft") return false;
  const ext = /\.[a-z0-9]{1,5}$/i.exec(cur.files[0]?.name ?? "")?.[0] ?? ".m4a";
  const fileName = safeFileName(`${init.title.trim() || init.fallbackName}${ext}`);
  setOutbox(state.outbox.map((i) => (i.id === id ? keepDraft(i, { title: init.title.trim(), target: init.target, fileName }) : i)), true);
  return true;
}

/** A draft's name and target as typed (saved soon: a kill keeps them too). */
export function updateDraft(id: string, patch: { title?: string; target?: IdeaTarget | null }): void {
  setOutbox(state.outbox.map((i) => (i.id === id && i.state === "draft" ? { ...i, ...(patch.title !== undefined ? { title: clip(patch.title, 200) } : {}), ...(patch.target !== undefined ? { target: patch.target } : {}) } : i)));
}

export const newOutId = randomId;

export function retryOut(id: string): void {
  setOutbox(state.outbox.map((i) => (i.id === id && i.state === "failed" ? retry(i) : i)), true);
}

/** Removes an item from the phone (and its files). What the computer got stays there. */
export function removeOut(id: string): void {
  removeItemFiles(id);
  setOutbox(state.outbox.filter((i) => i.id !== id), true);
}

function isPairing(v: unknown): v is Pairing {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.deviceId === "string" && typeof p.key === "string" && Array.isArray(p.hosts) && typeof p.port === "number" && typeof p.desktopName === "string";
}

/** The library read at launch, held while the pairing can't be read (applied once it can). */
let heldCache: LibraryCache | null = null;

type PairingRead = { ok: true; pairing: Pairing | null } | { ok: false };
async function readPairing(): Promise<PairingRead> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(PAIRING_KEY);
  } catch (e) {
    console.warn("Hivo: could not read the pairing", e);
    return { ok: false };
  }
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return { ok: true, pairing: isPairing(parsed) ? parsed : null };
  } catch {
    return { ok: true, pairing: null };
  }
}

function syncFrom(edits: Edits, cache: LibraryCache | null): SyncState {
  return cache ? { ...emptyState(), ...cache, pending: edits.pending, gone: edits.gone } : keepEdits(edits);
}

/** Reads everything; always ends with `loaded: true` (a crash here used to
 * leave the spinner up for good). */
export async function load(): Promise<void> {
  try {
    const now = Date.now();
    const got = await loadAll(kv, dataFS, now);
    for (const r of got.blocked) blocked.add(r);
    if (got.blocked.length > 0 || got.dropped.length > 0) console.warn("Hivo: storage", { blocked: got.blocked, dropped: got.dropped });
    boundDevice = got.bound;
    // An upload cut by the app being killed: back to waiting.
    let outbox = got.outbox.map((x) => (x.state === "sending" ? { ...x, state: "waiting" as const } : x));
    // Sent memos and filed ideas leave the phone after 30 days.
    const pruned = pruneOut(outbox, now);
    for (const id of pruned.removed) removeItemFiles(id);
    outbox = pruned.keep;
    // Empty ideas a killed idea screen left behind.
    const ideas = dropEmptyIdeas(pruneIdeas(got.ideas, now, KEEP_SENT_MS));
    // Files no item points to (an app killed between the copy and the save).
    // Never when the list couldn't be read whole: its files are all there is.
    if (got.outboxClean && !blocked.has("outbox")) sweepOutbox(new Set(outbox.map((o) => o.id)));
    // expo-audio's takes never adopted (killed while recording: unplayable).
    sweepRecordings();
    setState({ ideas, outbox, storage: { blocked: [...blocked], saveFailed: false } });
    if (pruned.removed.length > 0 || ideas.length !== got.ideas.length || outbox.length !== got.outbox.length) void flushExtras();

    const p = await readPairing();
    if (!p.ok) {
      heldCache = got.cache;
      setState({ pairingUnreadable: true, sync: keepEdits(got.edits) });
      return;
    }
    setState({ pairing: p.pairing, sync: p.pairing ? syncFrom(got.edits, got.cache) : keepEdits(got.edits) });
    // What's on disk is what was just read: no rewrite until it changes.
    if (p.pairing && got.cache) {
      const c = cacheOf(state.sync);
      lastCacheParts = [c.items, c.conflicts, c.tooLong, c.helloDone, c.rebase, c.generatedAt, c.lastSyncAt];
    }
  } catch (e) {
    console.warn("Hivo: could not read saved data", e);
  } finally {
    setState({ loaded: true });
  }
}

/** "Retry" after the pairing couldn't be read. True once it reads. */
export async function retryPairingRead(): Promise<boolean> {
  const p = await readPairing();
  if (!p.ok) return false;
  const sync = p.pairing && heldCache ? syncFrom(editsOf(state.sync), heldCache) : state.sync;
  heldCache = null;
  setState({ pairingUnreadable: false, pairing: p.pairing, sync });
  if (p.pairing) void sync_();
  return true;
}

/** "Reset this phone's cache" (the error screen): the library cache goes;
 * the phone's note text, ideas, memos and the pairing stay. Works before
 * `load` (the app may not have got that far). */
export async function resetLocalCache(): Promise<void> {
  // In the save chain: a cache save queued before can't write it back after.
  await serial(async () => {
    await clearCache(kv, dataFS).catch((e) => console.warn("Hivo: could not clear the cache", e));
    lastCacheText = null;
    lastCacheParts = [];
    setState({ sync: keepEdits(editsOf(state.sync)) });
  });
}

/** The code check waiting now; Cancel ends only this one (review #14). */
let confirmAttempt: { cancelled: boolean } | null = null;

/** "Cancel" while waiting for the computer's confirmation: nothing is saved. */
export function cancelConfirmation(): void {
  if (confirmAttempt) confirmAttempt.cancelled = true;
}

const transport: Transport = (url, init) => fetch(url, init);

/** Checks a scanned pairing before keeping it: a v1.2 QR (an offer) pairs
 * with /v1/pair (the token works once), then waits while the user confirms
 * on the computer that it shows the same code as this phone (`confirming`);
 * an older computer's QR is checked with /v1/hello. Returns the pairing to
 * save, or why not (`code: null`: cancelled on the phone). */
export async function verifyPairing(p: Pairing | PairOffer): Promise<{ ok: true; pairing: Pairing } | { ok: false; code: SyncErrorCode | null }> {
  try {
    if ("token" in p) {
      const r = await completePairing(p, { transport, random: getRandomBytes, now: Date.now, phoneName: phoneName(), appVersion: appVersion() });
      if (!r.pending) return { ok: true, pairing: r.pairing };
      const attempt = { cancelled: false };
      // An older wait still running (it shouldn't: App.tsx checks one at a time) ends here.
      if (confirmAttempt) confirmAttempt.cancelled = true;
      confirmAttempt = attempt;
      const confirming = { code: r.code, desktopName: r.desktopName, startedAt: Date.now() };
      setState({ confirming });
      try {
        const call = createClient({ pairing: r.pairing, transport, random: getRandomBytes, now: Date.now, probe: probeTcp });
        const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
        const done = await waitForConfirmation(call, { phoneName: phoneName(), appVersion: appVersion() }, { now: Date.now, sleep, startedAt: Date.now(), cancelled: () => attempt.cancelled });
        return done.ok ? { ok: true, pairing: confirmedPairing(r.pairing, done.hello) } : done;
      } finally {
        if (confirmAttempt === attempt) confirmAttempt = null;
        // Only this attempt's code leaves the screen.
        if (state.confirming === confirming) setState({ confirming: null });
      }
    }
    let bound = false;
    const call = createClient({ pairing: p, transport, random: getRandomBytes, now: Date.now, probe: probeTcp, onBound: () => (bound = true) });
    const h = (await call("/v1/hello", { phoneName: phoneName(), appVersion: appVersion() })) as { desktopName?: unknown; computerId?: unknown } | null;
    const name = h && typeof h.desktopName === "string" && h.desktopName.trim() ? h.desktopName.trim().slice(0, 80) : p.desktopName;
    const computerId = computerIdOf(h?.computerId);
    return { ok: true, pairing: { ...p, desktopName: name, ...(bound ? { bound: true } : {}), ...(computerId ? { computerId } : {}) } };
  } catch (e) {
    return { ok: false, code: e instanceof SyncError ? e.code : "server" };
  }
}

async function savePairing(p: Pairing): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(p)).catch((e) => console.warn("Hivo: could not save the pairing", e));
}

/** A pairing from before 1.2 got a bound answer: from now on only bound ones count. */
async function markBound(deviceId: string): Promise<void> {
  const p = state.pairing;
  if (!p || p.deviceId !== deviceId || p.bound || p.scheme === "1.2") return;
  const updated: Pairing = { ...p, bound: true };
  setState({ pairing: updated });
  await savePairing(updated);
}

/** Saves a pairing (already verified: hello done). The same computer as
 * the current pairing (same computer id): its library and the notes waiting
 * to sync stay as they are. Another one: note edits made on the phone stay
 * and are re-based on its first snapshot. Ideas and memos: `runExtras`.
 * The old computer's cache is cleared before the new key is saved, so a kill
 * in between can't open this computer's pairing on the other's library.
 * Throws when the pairing can't be saved (nothing changed then). */
export async function pair(p: Pairing): Promise<void> {
  await cancelSync();
  // In the save chain (review #13): a cache save queued before runs first
  // and can't write the old library back after it's cleared.
  await serial(async () => {
    const kept = carryOver(state.pairing, p, state.sync);
    if (!kept.keepCache) {
      await clearCache(kv, dataFS);
      lastCacheText = null;
      lastCacheParts = [];
    }
    await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(p));
    heldCache = null;
    setState({ pairing: p, pairingUnreadable: false, sync: kept.sync, error: null, errorDetail: null });
  });
  await flush();
}

/** Forgets the computer. The phone's own text (unsynced edits, ideas, memos) stays. */
export async function unpair(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  cancelLook();
  await cancelSync();
  await serial(async () => {
    await SecureStore.deleteItemAsync(PAIRING_KEY);
    await clearCache(kv, dataFS).catch((e) => console.warn("Hivo: could not clear the cache", e));
    lastCacheText = null;
    lastCacheParts = [];
    setState({ pairing: null, sync: keepEdits(editsOf(state.sync)), error: null, errorDetail: null, syncing: false });
  });
  await flush();
}

/** The notes the computer doesn't have, as text to copy. */
export const unsyncedNotes = (): string => unsyncedText(state.sync);

export function setNote(kind: Kind, id: string, text: string): void {
  setSync(editNote(state.sync, kind, id, text, Date.now()));
}

export function removeGone(kind: Kind, id: string): void {
  setSync(forgetGone(state.sync, kind, id));
}

export function clearConflict(kind: Kind, id: string): void {
  setSync(dismissConflict(state.sync, kind, id));
}

export function phoneName(): string {
  return (Device.modelName ?? "Phone").slice(0, 60);
}

export function appVersion(): string {
  return Constants.expoConfig?.version ?? "0.0.0";
}

/** The screen stays on while something is being sent (Android freezes the
 * request with the screen off, and the upload stalls). */
let awake = false;
function stayAwake(on: boolean): void {
  if (on === awake) return;
  awake = on;
  if (on) void activateKeepAwakeAsync(SENDING_AWAKE_TAG).catch(() => {});
  else void deactivateKeepAwake(SENDING_AWAKE_TAG).catch(() => {});
}

/**
 * After the notes: ideas, then the outbox (memos, exports), then what the
 * computer did with them. "outdated" (an older Hivo on the computer), "demo"
 * and a full inbox/disk stop only this part; offline & co. stop the sync.
 * One refused item fails on its own; the others still go. Not run while the
 * binding row can't be read (which computer has what is unknown then).
 */
async function runExtras(call: (path: string, payload: unknown) => Promise<unknown>, pairing: Pairing, live: () => boolean): Promise<void> {
  if (blocked.has("bound")) return;
  // Another computer than last time: it has none of them yet. The same one
  // paired again (same computer id) has them: nothing goes twice.
  const binding = extrasBinding(boundDevice, pairing);
  if (binding.reset) {
    setIdeas(resetSent(state.ideas));
    setOutbox(resetOut(state.outbox));
  }
  if (binding.bound !== boundDevice) {
    boundDevice = binding.bound;
    void flushExtras();
  }
  try {
    let lastPush = "";
    for (let round = 0; round < 20; round++) {
      const push = ideasToPush(state.ideas);
      if (push.length === 0) break;
      // The computer left the same ones unmarked: don't send them again and again.
      const key = push.map((i) => `${i.id}:${i.updatedAt}`).join(",");
      if (key === lastPush) break;
      lastPush = key;
      const results = parseIdeaResults(await call("/v1/ideas", { ideas: push.map(ideaPayload) }));
      if (!results) throw new SyncError("outdated", "bad ideas response");
      if (!live()) throw new CancelledError();
      setIdeas(applyIdeaResults(state.ideas, push, results), true);
    }
    const io = { call, read: readChunk, exists: fileExists, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now: Date.now };
    const held = await sendQueue(io, {
      items: () => (live() ? state.outbox : []),
      onStart: (id) => {
        stayAwake(true);
        setState({ sending: id });
      },
      onUpdate: (i) => live() && replaceOut(i),
      onDone: (done) => {
        if (!live()) return;
        // An export is on the computer now: free the phone (memos stay, to replay).
        if (done.state === "sent" && done.type === "sketch") {
          removeItemFiles(done.id);
          setOutbox(state.outbox.map((i) => (i.id === done.id ? { ...done, purged: true } : i)), true);
        } else setOutbox(state.outbox.map((i) => (i.id === done.id ? done : i)), true);
      },
    });
    setState({ sending: null });
    stayAwake(false);
    const statuses = parseInboxStatuses(await call("/v1/inbox", {}));
    if (!live()) throw new CancelledError();
    setIdeas(applyIdeaStatuses(state.ideas, statuses));
    setOutbox(applyOutStatuses(state.outbox, statuses));
    setState({ extrasError: held });
  } catch (e) {
    if (e instanceof SyncError && (e.code === "outdated" || e.code === "demo")) setState({ extrasError: e.code });
    else throw e;
  } finally {
    stayAwake(false);
    setState({ sending: null, outbox: state.outbox.map((i) => (i.state === "sending" ? { ...i, state: "waiting" } : i)) });
    await flushExtras();
  }
}

/** The sync running now: cancelled by unpair / pair / a restart.
 * `progressAt`: when it started or last got an answer (a chunk, a note). */
let current: { ctrl: AbortController; done: Promise<boolean>; progressAt: number } | null = null;
let lastFinishedAt: number | null = null;

/** Cancels the running sync (if any) and waits a little for it to wind down. */
export async function cancelSync(): Promise<void> {
  const c = current;
  if (!c) return;
  current = null;
  again = false;
  c.ctrl.abort();
  setState({ syncing: false, sending: null });
  stayAwake(false);
  await Promise.race([c.done.catch(() => false), new Promise((r) => setTimeout(r, 5000))]);
}

/** The usual sealed hello to one address: true when the paired computer answered. */
async function sealedHello(pairing: Pairing, host: string, stop: AbortSignal, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  stop.addEventListener("abort", abort);
  signal.addEventListener("abort", abort);
  try {
    const call = createClient({ pairing: { ...pairing, hosts: [host] }, transport, random: getRandomBytes, now: Date.now, timeoutMs, signal: ctrl.signal });
    await call("/v1/hello", { phoneName: phoneName(), appVersion: appVersion() });
    return true;
  } catch (e) {
    // A sealed refusal is from the paired computer too (only it has the key).
    return e instanceof SyncError && ["clock", "demo", "read-only", "pending"].includes(e.code);
  } finally {
    stop.removeEventListener("abort", abort);
    signal.removeEventListener("abort", abort);
  }
}

/** The search running now (Settings): Cancel aborts it. */
let lookCtrl: AbortController | null = null;
const LOOK_AWAKE_TAG = "hivo-looking";

/**
 * Settings → "Look for my computer again", only when tapped (never on its
 * own: review #3). Its saved addresses first ("usual"), then every address
 * of the Wi-Fi the phone is on now (else the saved hosts' networks), with
 * the same sealed hello as a sync. The screen stays on meanwhile; Cancel:
 * `cancelLook`. A sync follows when it answered. Null: not run (unpaired,
 * already looking).
 */
export async function lookForComputer(): Promise<LookResult["kind"] | null> {
  const pairing = state.pairing;
  if (!pairing || lookCtrl) return null;
  const ctrl = new AbortController();
  lookCtrl = ctrl;
  setState({ rediscovering: true, lookProgress: null });
  void activateKeepAwakeAsync(LOOK_AWAKE_TAG).catch(() => {});
  const cancelled = () => ctrl.signal.aborted || state.pairing?.deviceId !== pairing.deviceId;
  try {
    const r = await lookAgain(pairing.hosts, {
      hello: (host, stop, phase) => sealedHello(pairing, host, stop, ctrl.signal, phase === "usual" ? SAVED_TIMEOUT_MS : PROBE_TIMEOUT_MS),
      phoneAddresses: localIPv4s,
      cancelled,
      onProgress: (p) => setState({ lookProgress: p }),
    });
    if (cancelled()) return "cancelled";
    if (r.kind === "found" && state.pairing) {
      const updated = { ...state.pairing, hosts: withFound(state.pairing.hosts, r.host) };
      setState({ pairing: updated });
      await savePairing(updated);
    }
    if (r.kind === "found" || r.kind === "usual") requestSync();
    return r.kind;
  } finally {
    if (lookCtrl === ctrl) lookCtrl = null;
    setState({ rediscovering: false, lookProgress: null });
    void deactivateKeepAwake(LOOK_AWAKE_TAG).catch(() => {});
  }
}

/** Cancel on "Look for my computer again". */
export function cancelLook(): void {
  lookCtrl?.abort();
}

/** Push queued notes, then pull the snapshot. Never throws: errors land in state. */
export function sync(): Promise<boolean> {
  if (!state.pairing || current) return Promise.resolve(false);
  return sync_();
}

function sync_(): Promise<boolean> {
  const pairing = state.pairing;
  if (!pairing || current) return Promise.resolve(false);
  const ctrl = new AbortController();
  const done = runOnce(pairing, ctrl);
  current = { ctrl, done, progressAt: Date.now() };
  return done;
}

async function runOnce(pairing: Pairing, ctrl: AbortController): Promise<boolean> {
  // Let `current` be set before anything runs.
  await Promise.resolve();
  setState({ syncing: true, error: null, errorDetail: null });
  // Cancelled (unpaired, paired elsewhere, restarted): its results belong to no one.
  const live = () => !ctrl.signal.aborted && state.pairing?.deviceId === pairing.deviceId;
  const finish = () => {
    if (current?.ctrl === ctrl) {
      current = null;
      setState({ syncing: false });
    }
  };
  try {
    const client = createClient({ pairing, transport, random: getRandomBytes, now: Date.now, probe: probeTcp, signal: ctrl.signal, onBound: () => void markBound(pairing.deviceId) });
    // Every answer is progress: a long upload that keeps sending isn't "stuck" (review #10).
    const call = async (path: string, payload: unknown): Promise<unknown> => {
      const res = await client(path, payload);
      if (current?.ctrl === ctrl) current.progressAt = Date.now();
      return res;
    };
    // Once per app run (and per computer): hello again, so a version change on either side shows.
    const sayHello = helloedFor !== pairing.deviceId;
    const res = await runSync(call, () => state.sync, (s) => live() && setSync(s), { phoneName: phoneName(), appVersion: appVersion() }, Date.now, { hello: sayHello });
    if (!live()) throw new CancelledError();
    if (sayHello) helloedFor = pairing.deviceId;
    if (res.desktopVersion !== undefined) setState({ desktopOutdated: desktopIsOlder(res.desktopVersion, appVersion()) });
    // The computer's id, kept with the pairing (a computer updated since pairing says it now).
    if (res.computerId && state.pairing && state.pairing.computerId !== res.computerId) {
      const updated = { ...state.pairing, computerId: res.computerId };
      setState({ pairing: updated });
      await savePairing(updated);
    }
    await runExtras(call, state.pairing ?? pairing, live);
    if (!live()) throw new CancelledError();
    if (res.desktopName && state.pairing && res.desktopName !== state.pairing.desktopName) {
      const updated = { ...state.pairing, desktopName: res.desktopName };
      setState({ pairing: updated });
      await savePairing(updated);
    }
    await flush();
    lastFinishedAt = Date.now();
    finish();
    if (again) {
      again = false;
      void sync();
    }
    return true;
  } catch (e) {
    if (e instanceof CancelledError || !live()) {
      finish();
      return false;
    }
    const code: SyncErrorCode = e instanceof SyncError ? e.code : "server";
    again = false;
    // No search of the network from here: only Settings → "Look for my computer again" does that (review #3).
    if (current?.ctrl === ctrl) setState({ error: code, errorDetail: e instanceof Error ? e.message : String(e) });
    finish();
    await flush();
    return false;
  }
}

let again = false;
/** The computer (device id) this app run already said hello to. */
let helloedFor: string | null = null;

/** Sync now, or right after the one running (something new to send). */
export function requestSync(): void {
  if (!state.pairing) return;
  if (current) again = true;
  else void sync();
}

/**
 * The app came back to the screen: sync, unless one finished less than 30 s
 * ago (F12); a sync with no answer for over a minute (the screen went off
 * mid-upload) is cancelled and a fresh one starts (B3). App.tsx calls this
 * instead of `sync()` on "active".
 */
export function syncOnForeground(): void {
  const action = onForeground({ paired: !!state.pairing, syncing: current !== null, progressAt: current?.progressAt ?? null, finishedAt: lastFinishedAt }, Date.now());
  if (action === "sync") void sync();
  else if (action === "restart") void cancelSync().then(() => void sync());
}
