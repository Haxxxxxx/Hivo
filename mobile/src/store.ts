// App state: the pairing (secure store), the cached library + queued edits
// (AsyncStorage), and the sync status. A tiny external store, read with
// useSyncExternalStore.
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { createClient, SyncError, type SyncErrorCode } from "./lib/client";
import type { Pairing } from "./lib/pairing";
import { clip } from "./lib/text";
import { dismissConflict, editNote, emptyState, forgetGone, runSync, type Kind, type SyncState } from "./lib/sync";
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
  resetSent,
  type Idea,
  type IdeaTarget,
} from "./lib/ideas";
import {
  applyOutStatuses,
  HoldError,
  parseInboxStatuses,
  resetOut,
  retry,
  toSend,
  uploadItem,
  type HoldReason,
  type OutFile,
  type OutItem,
  type OutType,
} from "./lib/outbox";
import { fileExists, readChunk, removeItemFiles } from "./files";

const PAIRING_KEY = "hivo.pairing.v1";
const CACHE_KEY = "hivo.sync.v1";
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

export async function flush(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  if (!state.pairing) return;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(state.sync));
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

function setIdeas(ideas: Idea[]): void {
  setState({ ideas });
  persistExtrasSoon();
}

function setOutbox(outbox: OutItem[]): void {
  setState({ outbox });
  persistExtrasSoon();
}

function replaceOut(item: OutItem): void {
  setOutbox(state.outbox.map((i) => (i.id === item.id ? item : i)));
}

const randomId = () => newId(getRandomBytes);

// ---- Ideas ----

/** A new idea (empty ones aren't sent); returns its id. */
export function addIdea(init: { title?: string; text?: string; target?: IdeaTarget | null } = {}): string {
  const id = randomId();
  setIdeas([createIdea(id, Date.now(), init), ...state.ideas]);
  return id;
}

export function updateIdea(id: string, patch: Partial<Pick<Idea, "title" | "text" | "target">>): void {
  setIdeas(editIdea(state.ideas, id, patch, Date.now()));
}

export function removeIdea(id: string): void {
  setIdeas(deleteIdea(state.ideas, id, Date.now()));
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
  setOutbox([item, ...state.outbox]);
}

export const newOutId = randomId;

export function retryOut(id: string): void {
  setOutbox(state.outbox.map((i) => (i.id === id ? retry(i) : i)));
}

/** Removes an item from the phone (and its files). What the computer got stays there. */
export function removeOut(id: string): void {
  removeItemFiles(id);
  setOutbox(state.outbox.filter((i) => i.id !== id));
}

function isPairing(v: unknown): v is Pairing {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.deviceId === "string" && typeof p.key === "string" && Array.isArray(p.hosts) && typeof p.port === "number" && typeof p.desktopName === "string";
}

function isSyncState(v: unknown): v is SyncState {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return Array.isArray(s.items) && !!s.pending && typeof s.pending === "object" && !!s.conflicts && typeof s.conflicts === "object";
}

export async function load(): Promise<void> {
  let pairing: Pairing | null = null;
  let sync = emptyState();
  let ideas: Idea[] = [];
  let outbox: OutItem[] = [];
  try {
    const [[, rawIdeas], [, rawOut], [, bound]] = await AsyncStorage.multiGet([IDEAS_KEY, OUTBOX_KEY, BOUND_KEY]);
    const i: unknown = rawIdeas ? JSON.parse(rawIdeas) : [];
    const o: unknown = rawOut ? JSON.parse(rawOut) : [];
    ideas = Array.isArray(i) ? (i as Idea[]).filter((x) => x && typeof x.id === "string") : [];
    // An upload cut by the app being killed: back to waiting.
    outbox = Array.isArray(o) ? (o as OutItem[]).filter((x) => x && typeof x.id === "string").map((x) => (x.state === "sending" ? { ...x, state: "waiting" } : x)) : [];
    boundDevice = bound || null;
  } catch (e) {
    console.warn("Hivo: could not read ideas and memos", e);
  }
  setState({ ideas, outbox });
  try {
    const raw = await SecureStore.getItemAsync(PAIRING_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    pairing = isPairing(parsed) ? parsed : null;
    if (pairing) {
      const cached = await AsyncStorage.getItem(CACHE_KEY);
      const c: unknown = cached ? JSON.parse(cached) : null;
      if (isSyncState(c)) sync = { ...emptyState(), ...c };
    }
  } catch (e) {
    console.warn("Hivo: could not read saved data", e);
  }
  setState({ loaded: true, pairing, sync });
}

export async function pair(p: Pairing): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(p));
  await AsyncStorage.removeItem(CACHE_KEY);
  setState({ pairing: p, sync: emptyState(), error: null, errorDetail: null });
  await flush();
}

export async function unpair(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  await SecureStore.deleteItemAsync(PAIRING_KEY);
  await AsyncStorage.removeItem(CACHE_KEY);
  setState({ pairing: null, sync: emptyState(), error: null, errorDetail: null, syncing: false });
}

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
 */
async function runExtras(call: (path: string, payload: unknown) => Promise<unknown>, deviceId: string): Promise<void> {
  // Another computer than last time: it has none of them yet.
  if (boundDevice !== deviceId) {
    boundDevice = deviceId;
    setIdeas(resetSent(state.ideas));
    setOutbox(resetOut(state.outbox));
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
      setIdeas(applyIdeaResults(state.ideas, push, results));
    }
    const io = { call, read: readChunk, exists: fileExists, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now: Date.now };
    for (const item of toSend(state.outbox)) {
      // Removed from the phone while an earlier item was sending.
      if (!state.outbox.some((i) => i.id === item.id)) continue;
      setState({ sending: item.id });
      const done = await uploadItem(io, item, replaceOut);
      replaceOut(done);
      // An export is on the computer now: free the phone (memos stay, to replay).
      if (done.state === "sent" && done.type === "sketch") {
        removeItemFiles(done.id);
        replaceOut({ ...done, purged: true });
      }
    }
    const statuses = parseInboxStatuses(await call("/v1/inbox", {}));
    setIdeas(applyIdeaStatuses(state.ideas, statuses));
    setOutbox(applyOutStatuses(state.outbox, statuses));
    setState({ extrasError: null });
  } catch (e) {
    if (e instanceof HoldError) setState({ extrasError: e.reason });
    else if (e instanceof SyncError && (e.code === "outdated" || e.code === "demo")) setState({ extrasError: e.code });
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
    const call = createClient({ pairing, transport: (url, init) => fetch(url, init), random: getRandomBytes, now: Date.now });
    // Unpaired (or paired elsewhere) while this ran: its results belong to the old computer.
    const stillPaired = () => state.pairing?.deviceId === pairing.deviceId;
    const res = await runSync(call, () => state.sync, (s) => stillPaired() && setSync(s), { phoneName: phoneName(), appVersion: appVersion() }, Date.now);
    if (!stillPaired()) {
      setState({ syncing: false });
      return false;
    }
    await runExtras(call, pairing.deviceId);
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

/** Sync now, or right after the one running (something new to send). */
export function requestSync(): void {
  if (!state.pairing) return;
  if (state.syncing) again = true;
  else void sync();
}
