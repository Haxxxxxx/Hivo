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

export type PairResult = { pairing: Pairing; desktopName: string; desktopVersion: string | null };

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
  let h: { desktopName?: unknown; hivoVersion?: unknown } | null;
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
  return { pairing: { ...pairing, desktopName: name }, desktopName: name, desktopVersion: h && typeof h.hivoVersion === "string" ? h.hivoVersion.slice(0, 20) : null };
}
