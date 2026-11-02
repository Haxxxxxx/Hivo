// Pairing v1.2 (docs/PHONE-SYNC.md): the QR holds a one-time token and the
// computer's X25519 public key, never the device key. The phone makes its own
// X25519 key pair and both sides derive the device key:
//   HKDF-SHA256(salt = token, ikm = X25519 shared secret,
//               info = "hivo-sync-v1.2|pair|" + deviceId + "|" + b64(desktop pub) + "|" + b64(phone pub))
// The first request (`/v1/pair`) is sealed with that key and carries the
// phone's public key: opening it proves the phone had the token, and the
// computer's bound answer proves it had its secret. The token then stops
// working, so a photo of the QR is useless after pairing.
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromB64url, toB64url, utf8 } from "./bytes";
import { createClient, PAIR_PATH, SyncError, type Transport } from "./client";
import type { RandomBytes } from "./envelope";
import type { PairOffer, Pairing } from "./pairing";

export const PAIR_INFO_PREFIX = "hivo-sync-v1.2|pair|";
/** HKDF info prefix for the confirmation code (then the device id). */
export const CONFIRM_INFO_PREFIX = "hivo-sync-v1.2|confirm|";

/**
 * The 6-digit code the phone and the computer both show after `/v1/pair`
 * (same as `confirm_code` in phone_sync.rs): HKDF-SHA256(salt = token,
 * ikm = desktop pub || phone pub, info = prefix + deviceId, 4 bytes) as a
 * big-endian number, mod 1 000 000, zero-padded. Each side computes it; it's
 * never sent. The user confirms on the computer that both match.
 */
export function confirmCode(token: Uint8Array, deviceId: string, desktopPub: Uint8Array, phonePub: Uint8Array): string {
  const ikm = new Uint8Array(64);
  ikm.set(desktopPub, 0);
  ikm.set(phonePub, 32);
  const b = hkdf(sha256, ikm, token, utf8(CONFIRM_INFO_PREFIX + deviceId), 4);
  const n = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** `123456` -> `123 456`, as both screens show it. */
export const spacedCode = (code: string): string => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** A computer id from an answer (16 random bytes, b64url), or undefined. */
export function computerIdOf(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : undefined;
}

/** The device key (same as `derive_device_key` in phone_sync.rs). */
export function deriveDeviceKey(shared: Uint8Array, token: Uint8Array, deviceId: string, desktopPub: Uint8Array, phonePub: Uint8Array): Uint8Array {
  const info = PAIR_INFO_PREFIX + deviceId + "|" + toB64url(desktopPub) + "|" + toB64url(phonePub);
  return hkdf(sha256, shared, token, utf8(info), 32);
}

/** The phone's half: its public key and the device key, from its secret and the QR. Throws on a bad key. */
export function phoneDerive(secret: Uint8Array, offer: Pick<PairOffer, "deviceId" | "token" | "desktopKey">): { key: Uint8Array; phonePub: Uint8Array } {
  const token = fromB64url(offer.token);
  const desktopPub = fromB64url(offer.desktopKey);
  if (!token || token.length !== 32 || !desktopPub || desktopPub.length !== 32) throw new SyncError("expired", "bad pairing code");
  const phonePub = x25519.getPublicKey(secret);
  // noble refuses a low-order public key (an all-zero shared secret).
  const shared = x25519.getSharedSecret(secret, desktopPub);
  return { key: deriveDeviceKey(shared, token, offer.deviceId, desktopPub, phonePub), phonePub };
}

/** `code`: what this phone shows. `pending`: the computer waits for the
 * user to confirm that code there (every request gets "pending" until then). */
export type PairResult = { pairing: Pairing; desktopName: string; desktopVersion: string | null; code: string; pending: boolean };

/**
 * Pairs with the computer from a v1.2 QR: `/v1/pair` with the phone's
 * public key, answered (bound) like a hello. Throws SyncError: "expired"
 * when the QR was used already or is too old, the usual codes otherwise.
 */
export async function completePairing(
  offer: PairOffer,
  opts: { transport: Transport; random: RandomBytes; now: () => number; phoneName: string; appVersion: string; sleep?: (ms: number) => Promise<void> },
): Promise<PairResult> {
  const secret = opts.random(32);
  let derived;
  try {
    derived = phoneDerive(secret, offer);
  } catch (e) {
    if (e instanceof SyncError) throw e;
    throw new SyncError("expired", "bad pairing code");
  } finally {
    secret.fill(0);
  }
  const code = confirmCode(fromB64url(offer.token)!, offer.deviceId, fromB64url(offer.desktopKey)!, derived.phonePub);
  const pairing: Pairing = {
    deviceId: offer.deviceId,
    key: toB64url(derived.key),
    hosts: offer.hosts,
    port: offer.port,
    desktopName: offer.desktopName,
    scheme: "1.2",
  };
  const call = createClient({ pairing, transport: opts.transport, random: opts.random, now: opts.now, pairWith: toB64url(derived.phonePub) });
  const hello = { phoneName: opts.phoneName, appVersion: opts.appVersion };
  let h: { desktopName?: unknown; hivoVersion?: unknown; computerId?: unknown; confirm?: unknown } | null;
  try {
    h = (await call(PAIR_PATH, hello)) as typeof h;
  } catch (e) {
    // The answer may have been lost after the computer burnt the QR: once
    // more with the same key (it answers a phone it already paired).
    if (!(e instanceof SyncError) || !["offline", "off", "busy"].includes(e.code)) throw e;
    await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(1000);
    h = (await call(PAIR_PATH, hello)) as typeof h;
  }
  const name = h && typeof h.desktopName === "string" && h.desktopName.trim() ? h.desktopName.trim().slice(0, 80) : offer.desktopName;
  const computerId = computerIdOf(h?.computerId);
  return {
    pairing: { ...pairing, desktopName: name, ...(computerId ? { computerId } : {}) },
    desktopName: name,
    desktopVersion: h && typeof h.hivoVersion === "string" ? h.hivoVersion.slice(0, 20) : null,
    code,
    pending: h?.confirm === "pending",
  };
}
