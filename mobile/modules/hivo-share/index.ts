// "Share to Hivo" on Android (android/…/HivoShareModule.kt). iOS has no share
// target yet (no iOS distribution): the module is absent and everything
// here returns nothing.
//
// A share that reached JS is remembered (AsyncStorage, `PENDING_KEY`) until
// it's sent or left (`clearShareCache`): an app killed with it on screen, or
// waiting its turn, shows it again at the next launch (`takeShared`), and the
// launch sweep never deletes its copies.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { requireOptionalNativeModule, type EventSubscription } from "expo";
import { File } from "expo-file-system";
import { addPending, pendingDirs, removePending, restorable, type PendingShare } from "../../src/lib/pendingShares";

/** `named`: the sharing app gave a real name (false: `name` is the provider's id, e.g. "msf_1000032969"). */
export type SharedFile = { uri: string; name: string; size: number; mime: string | null; named?: boolean };
export type SkipReason = "count" | "too-big" | "total" | "unreadable" | "space";
export type Shared = {
  /** This share's own cache folder (cleared on its own when done). */
  dir: string | null;
  files: SharedFile[];
  skipped: { name: string; reason: SkipReason; size?: number; named?: boolean }[];
  text: string | null;
  subject: string | null;
};

type Native = {
  takeShared(): Promise<Shared | null>;
  clearCache(dir: string): Promise<boolean>;
  sweepCache(keep: string[]): Promise<number>;
  probeTcp(host: string, port: number, timeoutMs: number): Promise<"open" | "refused" | "other">;
  addListener(event: "onShare", listener: (s: Shared) => void): EventSubscription;
  addListener(event: "onShareStart", listener: (e: { count: number }) => void): EventSubscription;
};

const native = requireOptionalNativeModule<Native>("HivoShare");
const PENDING_KEY = "hivo.share.pending.v1";

async function readPending(): Promise<PendingShare<Shared>[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as PendingShare<Shared>[]).filter((p) => p && typeof p.dir === "string" && p.share && typeof p.share === "object") : [];
  } catch {
    return [];
  }
}

// One write at a time (a share and a clear can cross).
let chain: Promise<unknown> = Promise.resolve();
function updatePending(fn: (list: PendingShare<Shared>[]) => PendingShare<Shared>[]): Promise<void> {
  const next = chain.then(async () => {
    const list = fn(await readPending());
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(list)).catch((e) => console.warn("Hivo: could not remember a share", e));
  });
  chain = next.catch(() => {});
  return next;
}

/** Remembered before JS shows it: a kill from here on doesn't lose it. */
async function remember(s: Shared | null): Promise<Shared | null> {
  if (s?.dir) await updatePending((list) => addPending(list, s.dir as string, s, Date.now())).catch(() => {});
  return s;
}

/** Dirs handed to JS in this run (a restored share is shown once per run). */
const shownThisRun = new Set<string>();

/** What started (or was last shared to) the app, once; else a share a
 * killed run left waiting (oldest first, each once per run); null when nothing. */
export async function takeShared(): Promise<Shared | null> {
  if (!native) return null;
  const fresh = await remember(await native.takeShared());
  if (fresh) {
    if (fresh.dir) shownThisRun.add(fresh.dir);
    return fresh;
  }
  const next = restorable(await readPending(), shownThisRun, (uri) => {
    try {
      return new File(uri).exists;
    } catch {
      return false;
    }
  });
  if (!next) return null;
  shownThisRun.add(next.dir);
  return next.share;
}

/** A share while the app is open. */
export function onShare(listener: (s: Shared) => void): { remove: () => void } {
  if (!native) return { remove: () => {} };
  const sub = native.addListener("onShare", (s) => {
    if (s.dir) shownThisRun.add(s.dir);
    void remember(s);
    listener(s);
  });
  return { remove: () => sub.remove() };
}

/** A share's files started copying (big ones take a while): show "Copying…". */
export function onShareStart(listener: () => void): { remove: () => void } {
  if (!native) return { remove: () => {} };
  const sub = native.addListener("onShareStart", () => listener());
  return { remove: () => sub.remove() };
}

/** Deletes one share's copies once they're in the outbox (or the share was left). */
export async function clearShareCache(dir: string | null | undefined): Promise<void> {
  if (!native || !dir) return;
  await updatePending((list) => removePending(list, dir)).catch(() => {});
  await native.clearCache(dir).catch(() => false);
}

/** At start: deletes every share's copies except the ones still waiting
 * (named by the caller, or remembered from a run that was killed). */
export async function sweepShareCache(keep: string[]): Promise<void> {
  if (!native) return;
  const pending = pendingDirs(await readPending());
  await native.sweepCache([...keep, ...pending]).catch(() => 0);
}

/** "refused" only when a plain TCP connect to the computer was refused (Android). */
export async function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<"refused" | "other"> {
  if (!native) return "other";
  const r = await native.probeTcp(host, port, timeoutMs).catch(() => "other" as const);
  return r === "refused" ? "refused" : "other";
}
