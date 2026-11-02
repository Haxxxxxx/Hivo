import { fromB64url } from "./bytes";

/** What the phone keeps once paired. */
export type Pairing = {
  deviceId: string; // b64url, as in the URL (also the X-Hivo-Device header and the AAD)
  key: string; // b64url of the 32-byte device key
  hosts: string[]; // private IPv4 addresses, best first
  port: number;
  desktopName: string;
  /** "1.2": the key was derived at pairing (X25519, never in a QR) and every
   * answer must be bound to its request. Absent: paired before 1.2. */
  scheme?: "1.2";
  /** Paired before 1.2, and the computer has answered bound since: unbound
   * answers (a 1.1 desktop, or an old one replayed) are refused from then on. */
  bound?: boolean;
};

/** A v1.2 QR (`v=2`): what the phone needs to pair once (`handshake.ts`). */
export type PairOffer = {
  deviceId: string;
  token: string; // b64url, 32 bytes, works once for 5 minutes
  desktopKey: string; // b64url of the computer's X25519 public key
  hosts: string[];
  port: number;
  desktopName: string;
};

export type PairingError = "not-hivo" | "version" | "device" | "key" | "hosts" | "port";

export type ParsedPairing = { ok: true; pairing: Pairing } | { ok: true; offer: PairOffer } | { ok: false; error: PairingError };

const MAX_NAME = 80;
/** The desktop puts at most 4 addresses in `h`. */
export const MAX_HOSTS = 4;
export const DEFAULT_DESKTOP_NAME = "Hivo";

function isIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** 10/8, 172.16/12, 192.168/16 (the contract's list). Loopback only when
 * asked (the iOS Simulator runs on the desktop's own Mac); on a phone,
 * 127.x is the phone itself, never the computer. */
export function isPrivateIPv4(s: string, loopback = false): boolean {
  const p = isIPv4(s);
  if (!p) return false;
  const [a, b] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (loopback && a === 127);
}

function decodeParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/** 32 bytes in b64url, or false. */
function is32(s: string): boolean {
  const b = fromB64url(s);
  return !!b && b.length === 32 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** Parses a pairing link (pasted text may carry spaces or a trailing
 * newline). Never throws.
 * - `hivo://pair?v=2&d=…&t=<token>&x=<desktop key>&h=…&p=…&n=…` (Hivo 1.2+):
 *   an offer, completed with `/v1/pair`.
 * - `hivo://pair?v=1&d=…&k=<device key>&h=…&p=…&n=…` (older computers): the pairing itself. */
export function parsePairingUrl(input: string, opts: { loopback?: boolean } = {}): ParsedPairing {
  const text = input.trim();
  const m = /^hivo:\/\/pair\/?\?(.*)$/i.exec(text);
  if (!m) return { ok: false, error: "not-hivo" };
  const params = new Map<string, string>();
  for (const part of m[1].split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = decodeParam(eq < 0 ? "" : part.slice(eq + 1));
    if (v === null) return { ok: false, error: "not-hivo" };
    if (!params.has(k)) params.set(k, v);
  }
  const version = params.get("v");
  if (version !== "1" && version !== "2") return { ok: false, error: "version" };

  const deviceId = params.get("d") ?? "";
  const id = fromB64url(deviceId);
  if (!id || id.length !== 16 || !/^[A-Za-z0-9_-]+$/.test(deviceId)) return { ok: false, error: "device" };

  const key = params.get("k") ?? "";
  const token = params.get("t") ?? "";
  const desktopKey = params.get("x") ?? "";
  if (version === "1" ? !is32(key) : !is32(token) || !is32(desktopKey)) return { ok: false, error: "key" };

  const hosts = [...new Set((params.get("h") ?? "").split(",").map((h) => h.trim()).filter((h) => isPrivateIPv4(h, opts.loopback)))].slice(0, MAX_HOSTS);
  if (hosts.length === 0) return { ok: false, error: "hosts" };

  const portText = params.get("p") ?? "";
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "port" };

  const name = (params.get("n") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
  const desktopName = name || DEFAULT_DESKTOP_NAME;
  if (version === "2") return { ok: true, offer: { deviceId, token, desktopKey, hosts, port, desktopName } };
  return { ok: true, pairing: { deviceId, key, hosts, port, desktopName } };
}
