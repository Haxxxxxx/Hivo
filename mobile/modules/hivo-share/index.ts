// "Share to Hivo" on Android (android/…/HivoShareModule.kt). iOS has no share
// target yet (no iOS distribution): the module is absent and everything
// here returns nothing.
import { requireOptionalNativeModule, type EventSubscription } from "expo";

/** `named`: the sharing app gave a real name (false: `name` is the provider's id, e.g. "msf_1000032969"). */
export type SharedFile = { uri: string; name: string; size: number; mime: string | null; named?: boolean };
export type SkipReason = "count" | "too-big" | "unreadable" | "space";
export type Shared = {
  files: SharedFile[];
  skipped: { name: string; reason: SkipReason; size?: number }[];
  text: string | null;
  subject: string | null;
};

type Native = {
  takeShared(): Promise<Shared | null>;
  clearCache(): Promise<boolean>;
  addListener(event: "onShare", listener: (s: Shared) => void): EventSubscription;
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

/** Deletes the shared copies once they're in the outbox. */
export async function clearShareCache(): Promise<void> {
  if (native) await native.clearCache().catch(() => false);
}
