// After `/v1/pair` (docs/PHONE-SYNC.md, "Confirmation code"): the computer
// keeps the pairing waiting until the user checks on it that both screens
// show the same code, and answers every request "pending" meanwhile. Also:
// what pairing again with the same computer (same `computerId`) keeps.
import { SyncError, type SyncErrorCode } from "./client";
import { computerIdOf } from "./handshake";
import type { Pairing } from "./pairing";
import { editsOf, keepEdits, type SyncState } from "./sync";

/** The computer drops a pairing not confirmed within this long (paired with
 * `CONFIRM_TTL_MS` in src-tauri/src/phone_sync.rs). */
export const CONFIRM_TTL_MS = 300_000;
/** How often the phone asks whether it was confirmed. */
export const CONFIRM_POLL_MS = 2000;

export type ConfirmOutcome = { ok: true; hello: Record<string, unknown> | null } | { ok: false; code: SyncErrorCode | null };

/**
 * Says hello every `pollMs` until the computer answers it (confirmed), drops
 * the pairing (a bare 401: "Not my phone", the 5 minutes passed, Hivo
 * restarted: `not-confirmed`) or `CONFIRM_TTL_MS` passed since `startedAt`.
 * A Wi-Fi blip or a busy computer doesn't end the wait. `code: null`: the
 * user cancelled on the phone.
 */
export async function waitForConfirmation(
  call: (path: string, payload: unknown) => Promise<unknown>,
  hello: { phoneName: string; appVersion: string },
  opts: { now: () => number; sleep: (ms: number) => Promise<void>; startedAt: number; cancelled: () => boolean; pollMs?: number; ttlMs?: number },
): Promise<ConfirmOutcome> {
  const ttl = opts.ttlMs ?? CONFIRM_TTL_MS;
  const poll = opts.pollMs ?? CONFIRM_POLL_MS;
  for (;;) {
    if (opts.cancelled()) return { ok: false, code: null };
    if (opts.now() - opts.startedAt > ttl) return { ok: false, code: "not-confirmed" };
    try {
      const h = await call("/v1/hello", hello);
      if (opts.cancelled()) return { ok: false, code: null };
      return { ok: true, hello: h && typeof h === "object" ? (h as Record<string, unknown>) : null };
    } catch (e) {
      const code: SyncErrorCode = e instanceof SyncError ? e.code : "server";
      if (code === "forgotten") return { ok: false, code: "not-confirmed" };
      if (!["pending", "offline", "off", "busy"].includes(code)) return { ok: false, code };
    }
    await opts.sleep(poll);
  }
}

/** The pairing once confirmed, with what the computer's hello said. */
export function confirmedPairing(p: Pairing, hello: Record<string, unknown> | null): Pairing {
  const name = typeof hello?.desktopName === "string" && hello.desktopName.trim() ? hello.desktopName.trim().slice(0, 80) : p.desktopName;
  const computerId = computerIdOf(hello?.computerId) ?? p.computerId;
  return { ...p, desktopName: name, ...(computerId ? { computerId } : {}) };
}

/** Same computer: both pairings carry the same computer id. */
export const sameComputer = (a: Pairing | null | undefined, b: Pairing): boolean => !!a?.computerId && a.computerId === b.computerId;

/**
 * What a new pairing keeps of the phone's library state. The same computer
 * again: everything (its library, the notes waiting to sync, conflicts),
 * nothing to re-base. Another computer: only the phone's own text (pending
 * edits and gone items), re-based on its first snapshot.
 */
export function carryOver(prev: Pairing | null, next: Pairing, sync: SyncState): { sync: SyncState; keepCache: boolean } {
  if (sameComputer(prev, next)) return { sync: { ...sync, helloDone: true }, keepCache: true };
  return { sync: { ...keepEdits(editsOf(sync)), helloDone: true }, keepCache: false };
}

/**
 * Which computer the ideas' and memos' "sent" marks are for, and whether
 * they must be reset (everything sent again). Bound by computer id when the
 * computer has one, else by device id (computers older than this). A
 * binding saved by device id for this very pairing moves to its computer id
 * without a reset (the first sync after updating).
 */
export function extrasBinding(bound: string | null, pairing: Pairing): { bound: string; reset: boolean } {
  const key = pairing.computerId ? `computer:${pairing.computerId}` : pairing.deviceId;
  if (bound === key || bound === pairing.deviceId) return { bound: key, reset: false };
  return { bound: key, reset: true };
}
