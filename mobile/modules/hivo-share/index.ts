// "Share to Hivo" on Android (android/…/HivoShareModule.kt). iOS has no share
// target yet (no iOS distribution): the module is absent and everything
// here returns nothing.
import { requireOptionalNativeModule, type EventSubscription } from "expo";

/** `named`: the sharing app gave a real name (false: `name` is the provider's id, e.g. "msf_1000032969"). */
export type SharedFile = { uri: string; name: string; size: number; mime: string | null; named?: boolean };
export type SkipReason = "count" | "too-big" | "total" | "unreadable" | "space";
export type Shared = {
  /** This share's own cache folder (cleared on its own when done). */
  dir: string | null;
  files: SharedFile[];
  skipped: { name: string; reason: SkipReason; size?: number }[];
  text: string | null;
  subject: string | null;
};

type Native = {
  takeShared(): Promise<Shared | null>;
  clearCache(dir: string): Promise<boolean>;
  sweepCache(keep: string[]): Promise<number>;
  addListener(event: "onShare", listener: (s: Shared) => void): EventSubscription;
  addListener(event: "onShareStart", listener: (e: { count: number }) => void): EventSubscription;
};

const native = requireOptionalNativeModule<Native>("HivoShare");

/** What started (or was last shared to) the app, once; null when nothing. */
export async function takeShared(): Promise<Shared | null> {
  return native ? native.takeShared() : null;
}

/** A share while the app is open. */
export function onShare(listener: (s: Shared) => void): { remove: () => void } {
  if (!native) return { remove: () => {} };
  const sub = native.addListener("onShare", listener);
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
  if (native && dir) await native.clearCache(dir).catch(() => false);
}

/** At start: deletes every share's copies except the ones still waiting. */
export async function sweepShareCache(keep: string[]): Promise<void> {
  if (native) await native.sweepCache(keep).catch(() => 0);
}
