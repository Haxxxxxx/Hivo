// App state: the pairing (secure store), the cached library, the phone's own
// note edits (kept across pairings), ideas and the outbox (AsyncStorage), and
// the sync status. A tiny external store, read with useSyncExternalStore.
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { createClient, SyncError, type SyncErrorCode, type Transport } from "./lib/client";
import { carryOver, confirmedPairing, extrasBinding, waitForConfirmation } from "./lib/confirm";
import { completePairing, computerIdOf } from "./lib/handshake";
import type { PairOffer, Pairing } from "./lib/pairing";
import { clip } from "./lib/text";
import { desktopIsOlder } from "./lib/update";
import {
  cacheOf,
  dismissConflict,
  editNote,
  editsOf,
  emptyState,
  forgetGone,
  keepEdits,
  parseEdits,
  runSync,
  unsyncedText,
  type Kind,
  type SyncState,
} from "./lib/sync";
import {
  applyIdeaResults,
  applyIdeaStatuses,
  createIdea,
  deleteIdea,
  editIdea,
  ideaPayload,
  ideasToPush,
  newId,
  parseIdeaResults,
  pruneIdeas,
  resetSent,
  type Idea,
  type IdeaTarget,
} from "./lib/ideas";
import {
  applyOutStatuses,
  KEEP_SENT_MS,
  parseInboxStatuses,
  pruneOut,
  resetOut,
  retry,
  sendQueue,
  type HoldReason,
  type OutFile,
  type OutItem,
  type OutType,
} from "./lib/outbox";
import { fileExists, readChunk, removeItemFiles, sweepOutbox } from "./files";

const PAIRING_KEY = "hivo.pairing.v1";
/** The library as the computer last sent it (big: every note). Per pairing. */
const CACHE_KEY = "hivo.sync.v1";
/** Note edits not on the computer yet, and notes of items it deleted: the
 * phone's own text, kept across unpairing and re-pairing. */
const EDITS_KEY = "hivo.edits.v1";
// Kept across unpairing: they're what was written and recorded on the phone.
const IDEAS_KEY = "hivo.ideas.v1";
const OUTBOX_KEY = "hivo.outbox.v1";
/** The computer (device id) the ideas' and outbox's "sent" marks are for. */
const BOUND_KEY = "hivo.extras.device.v1";

/** Why ideas / memos / exports didn't go (notes may have synced fine). */
export type ExtrasError = "outdated" | "demo" | HoldReason;

export type AppState = {
  loaded: boolean;
  pairing: Pairing | null;
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
};

let state: AppState = {
  loaded: false,
  pairing: null,
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
};
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

// Persistence of the cache, debounced (the note editor writes on every keystroke).
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSoon(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void flush(), 300);
}

/** Saves the phone's edits (always) and the library cache (when paired), in two rows. */
export async function flush(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  try {
    const rows: [string, string][] = [[EDITS_KEY, JSON.stringify(editsOf(state.sync))]];
    if (state.pairing) rows.push([CACHE_KEY, JSON.stringify(cacheOf(state.sync))]);
    await AsyncStorage.multiSet(rows);
  } catch (e) {
    console.warn("Hivo: could not save the local cache", e);
  }
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

export async function flushExtras(): Promise<void> {
  if (extrasTimer) clearTimeout(extrasTimer);
  extrasTimer = null;
  try {
    await AsyncStorage.multiSet([
      [IDEAS_KEY, JSON.stringify(state.ideas)],
      [OUTBOX_KEY, JSON.stringify(state.outbox)],
      [BOUND_KEY, boundDevice ?? ""],
    ]);
  } catch (e) {
    console.warn("Hivo: could not save ideas and memos", e);
  }
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

/** Adds files already moved into the outbox folder (files.ts `adopt`) as one item. */
export function addOutItem(id: string, type: OutType, files: OutFile[], init: { title?: string; text?: string; target?: IdeaTarget | null; durationMs?: number | null } = {}): void {
  const item: OutItem = {
    id,
    type,
    title: clip(init.title ?? "", 200),
    ...(init.text ? { text: clip(init.text, 2000) } : {}),
    target: init.target ?? null,
    createdAt: Date.now(),
    durationMs: init.durationMs ?? null,
    files,
    state: "waiting",
    error: null,
    sentBytes: 0,
    status: null,
    filedTo: null,
    sentAt: null,
  };
  setOutbox([item, ...state.outbox], true);
}

export const newOutId = randomId;

export function retryOut(id: string): void {
  setOutbox(state.outbox.map((i) => (i.id === id ? retry(i) : i)), true);
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

function isCache(v: unknown): v is Omit<SyncState, "pending" | "gone"> {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return Array.isArray(s.items) && !!s.conflicts && typeof s.conflicts === "object";
}

/** Reads a JSON list; a row that doesn't parse is copied aside first, never
 * overwritten by an empty list at the next save. */
async function readList<T extends { id: string }>(key: string, raw: string | null | undefined): Promise<T[] | null> {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) return (v as T[]).filter((x) => x && typeof x.id === "string");
  } catch {
    // Kept below.
  }
  console.warn(`Hivo: ${key} was unreadable; a copy is kept`);
  await AsyncStorage.setItem(`${key}.corrupt.${Date.now()}`, raw).catch(() => {});
  return null;
}

export async function load(): Promise<void> {
  let pairing: Pairing | null = null;
  let ideas: Idea[] = [];
  let outbox: OutItem[] = [];
  let edits = parseEdits(null);
  let cacheRaw: string | null = null;
  let outboxKnown = false;
  try {
    const rows = await AsyncStorage.multiGet([IDEAS_KEY, OUTBOX_KEY, BOUND_KEY, EDITS_KEY, CACHE_KEY]);
    const [rawIdeas, rawOut, bound, rawEdits] = rows.map(([, v]) => v);
    cacheRaw = rows[4][1];
    ideas = (await readList<Idea>(IDEAS_KEY, rawIdeas)) ?? [];
    // An upload cut by the app being killed: back to waiting.
    const out = await readList<OutItem>(OUTBOX_KEY, rawOut);
    outbox = (out ?? []).map((x) => (x.state === "sending" ? { ...x, state: "waiting" } : x));
    outboxKnown = out !== null;
    boundDevice = bound || null;
    // Before the split (0.6.2), the edits lived inside the cache row.
    const editsRaw = rawEdits ?? cacheRaw;
    try {
      edits = parseEdits(editsRaw ? JSON.parse(editsRaw) : null);
    } catch {
      if (editsRaw) await AsyncStorage.setItem(`${EDITS_KEY}.corrupt.${Date.now()}`, editsRaw).catch(() => {});
    }
  } catch (e) {
    console.warn("Hivo: could not read ideas and memos", e);
  }
  // Sent memos and filed ideas leave the phone after 30 days.
  const now = Date.now();
  const pruned = pruneOut(outbox, now);
  for (const id of pruned.removed) removeItemFiles(id);
  outbox = pruned.keep;
  ideas = pruneIdeas(ideas, now, KEEP_SENT_MS);
  // Files no item points to (an app killed between the copy and the save).
  // Never when the list couldn't be read: its files are all there is.
  if (outboxKnown) sweepOutbox(new Set(outbox.map((o) => o.id)));
  setState({ ideas, outbox });
  if (pruned.removed.length > 0) void flushExtras();

  let sync = keepEdits(edits);
  try {
    const raw = await SecureStore.getItemAsync(PAIRING_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    pairing = isPairing(parsed) ? parsed : null;
    if (pairing) {
      const c: unknown = cacheRaw ? JSON.parse(cacheRaw) : null;
      if (isCache(c)) sync = { ...emptyState(), ...c, pending: edits.pending, gone: edits.gone };
    }
  } catch (e) {
    console.warn("Hivo: could not read saved data", e);
  }
  setState({ loaded: true, pairing, sync });
}

let confirmCancelled = false;

/** "Cancel" while waiting for the computer's confirmation: nothing is saved. */
export function cancelConfirmation(): void {
  confirmCancelled = true;
}

/** Checks a scanned pairing before keeping it: a v1.2 QR (an offer) pairs
 * with /v1/pair (the token works once), then waits while the user confirms
 * on the computer that it shows the same code as this phone (`confirming`);
 * an older computer's QR is checked with /v1/hello. Returns the pairing to
 * save, or why not (`code: null`: cancelled on the phone). */
export async function verifyPairing(p: Pairing | PairOffer): Promise<{ ok: true; pairing: Pairing } | { ok: false; code: SyncErrorCode | null }> {
  const transport: Transport = (url, init) => fetch(url, init);
  try {
    if ("token" in p) {
      const r = await completePairing(p, { transport, random: getRandomBytes, now: Date.now, phoneName: phoneName(), appVersion: appVersion() });
      if (!r.pending) return { ok: true, pairing: r.pairing };
      confirmCancelled = false;
      setState({ confirming: { code: r.code, desktopName: r.desktopName, startedAt: Date.now() } });
      try {
        const call = createClient({ pairing: r.pairing, transport, random: getRandomBytes, now: Date.now });
        const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
        const done = await waitForConfirmation(call, { phoneName: phoneName(), appVersion: appVersion() }, { now: Date.now, sleep, startedAt: Date.now(), cancelled: () => confirmCancelled });
        return done.ok ? { ok: true, pairing: confirmedPairing(r.pairing, done.hello) } : done;
      } finally {
        setState({ confirming: null });
      }
    }
    let bound = false;
    const call = createClient({ pairing: p, transport, random: getRandomBytes, now: Date.now, onBound: () => (bound = true) });
    const h = (await call("/v1/hello", { phoneName: phoneName(), appVersion: appVersion() })) as { desktopName?: unknown; computerId?: unknown } | null;
    const name = h && typeof h.desktopName === "string" && h.desktopName.trim() ? h.desktopName.trim().slice(0, 80) : p.desktopName;
    const computerId = computerIdOf(h?.computerId);
    return { ok: true, pairing: { ...p, desktopName: name, ...(bound ? { bound: true } : {}), ...(computerId ? { computerId } : {}) } };
  } catch (e) {
    return { ok: false, code: e instanceof SyncError ? e.code : "server" };
  }
}

/** A pairing from before 1.2 got a bound answer: from now on only bound ones count. */
async function markBound(deviceId: string): Promise<void> {
  const p = state.pairing;
  if (!p || p.deviceId !== deviceId || p.bound || p.scheme === "1.2") return;
  const updated: Pairing = { ...p, bound: true };
  setState({ pairing: updated });
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(updated)).catch((e) => console.warn("Hivo: could not save the pairing", e));
}

/** Saves a pairing (already verified: hello done). The same computer as
 * the current pairing (same computer id): its library and the notes waiting
 * to sync stay as they are. Another one: note edits made on the phone stay
 * and are re-based on its first snapshot. Ideas and memos: `runExtras`. */
export async function pair(p: Pairing): Promise<void> {
  const kept = carryOver(state.pairing, p, state.sync);
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(p));
  if (!kept.keepCache) await AsyncStorage.removeItem(CACHE_KEY);
  setState({ pairing: p, sync: kept.sync, error: null, errorDetail: null });
  await flush();
}

/** Forgets the computer. The phone's own text (unsynced edits, ideas, memos) stays. */
export async function unpair(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  await SecureStore.deleteItemAsync(PAIRING_KEY);
  await AsyncStorage.removeItem(CACHE_KEY);
  setState({ pairing: null, sync: keepEdits(editsOf(state.sync)), error: null, errorDetail: null, syncing: false });
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

/**
 * After the notes: ideas, then the outbox (memos, exports), then what the
 * computer did with them. "outdated" (an older Hivo on the computer), "demo"
 * and a full inbox/disk stop only this part; offline & co. stop the sync.
 * One refused item fails on its own; the others still go.
 */
async function runExtras(call: (path: string, payload: unknown) => Promise<unknown>, pairing: Pairing): Promise<void> {
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
      setIdeas(applyIdeaResults(state.ideas, push, results), true);
    }
    const io = { call, read: readChunk, exists: fileExists, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now: Date.now };
    const held = await sendQueue(io, {
      items: () => state.outbox,
      onStart: (id) => setState({ sending: id }),
      onUpdate: replaceOut,
      onDone: (done) => {
        // An export is on the computer now: free the phone (memos stay, to replay).
        if (done.state === "sent" && done.type === "sketch") {
          removeItemFiles(done.id);
          setOutbox(state.outbox.map((i) => (i.id === done.id ? { ...done, purged: true } : i)), true);
        } else setOutbox(state.outbox.map((i) => (i.id === done.id ? done : i)), true);
      },
    });
    setState({ sending: null });
    const statuses = parseInboxStatuses(await call("/v1/inbox", {}));
    setIdeas(applyIdeaStatuses(state.ideas, statuses));
    setOutbox(applyOutStatuses(state.outbox, statuses));
    setState({ extrasError: held });
  } catch (e) {
    if (e instanceof SyncError && (e.code === "outdated" || e.code === "demo")) setState({ extrasError: e.code });
    else throw e;
  } finally {
    setState({ sending: null, outbox: state.outbox.map((i) => (i.state === "sending" ? { ...i, state: "waiting" } : i)) });
    await flushExtras();
  }
}

/** Push queued notes, then pull the snapshot. Never throws: errors land in state. */
export async function sync(): Promise<boolean> {
  const pairing = state.pairing;
  if (!pairing || state.syncing) return false;
  setState({ syncing: true, error: null, errorDetail: null });
  try {
    const call = createClient({ pairing, transport: (url, init) => fetch(url, init), random: getRandomBytes, now: Date.now, onBound: () => void markBound(pairing.deviceId) });
    // Unpaired (or paired elsewhere) while this ran: its results belong to the old computer.
    const stillPaired = () => state.pairing?.deviceId === pairing.deviceId;
    // Once per app run (and per computer): hello again, so a version change on either side shows.
    const sayHello = helloedFor !== pairing.deviceId;
    const res = await runSync(call, () => state.sync, (s) => stillPaired() && setSync(s), { phoneName: phoneName(), appVersion: appVersion() }, Date.now, { hello: sayHello });
    if (!stillPaired()) {
      setState({ syncing: false });
      return false;
    }
    if (sayHello) helloedFor = pairing.deviceId;
    if (res.desktopVersion !== undefined) setState({ desktopOutdated: desktopIsOlder(res.desktopVersion, appVersion()) });
    // The computer's id, kept with the pairing (a computer updated since pairing says it now).
    if (res.computerId && state.pairing && state.pairing.computerId !== res.computerId) {
      const updated = { ...state.pairing, computerId: res.computerId };
      setState({ pairing: updated });
      await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(updated)).catch((e) => console.warn("Hivo: could not save the pairing", e));
    }
    await runExtras(call, state.pairing ?? pairing);
    if (res.desktopName && state.pairing && res.desktopName !== state.pairing.desktopName) {
      const updated = { ...state.pairing, desktopName: res.desktopName };
      setState({ pairing: updated });
      await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(updated));
    }
    // The client tries the host that answered first for the rest of this
    // sync; the saved order stays the desktop's (its best address first).
    await flush();
    setState({ syncing: false });
    if (again) {
      again = false;
      void sync();
    }
    return true;
  } catch (e) {
    const code: SyncErrorCode = e instanceof SyncError ? e.code : "server";
    again = false;
    setState({ syncing: false, error: code, errorDetail: e instanceof Error ? e.message : String(e) });
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
  if (state.syncing) again = true;
  else void sync();
}
