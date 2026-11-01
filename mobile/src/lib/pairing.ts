import { fromB64url } from "./bytes";

/** What the phone keeps after scanning the desktop's QR code. */
export type Pairing = {
  deviceId: string; // b64url, as in the URL (also the X-Hivo-Device header and the AAD)
  key: string; // b64url of the 32-byte device key
  hosts: string[]; // private IPv4 addresses, best first
  port: number;
  desktopName: string;
};

export type PairingError = "not-hivo" | "version" | "device" | "key" | "hosts" | "port";

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

/** Parses `hivo://pair?v=1&d=…&k=…&h=…&p=…&n=…` (pasted text may carry spaces
 * or a trailing newline). Never throws. */
export function parsePairingUrl(input: string, opts: { loopback?: boolean } = {}): { ok: true; pairing: Pairing } | { ok: false; error: PairingError } {
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
  if (params.get("v") !== "1") return { ok: false, error: "version" };

  const deviceId = params.get("d") ?? "";
  const id = fromB64url(deviceId);
  if (!id || id.length !== 16 || !/^[A-Za-z0-9_-]+$/.test(deviceId)) return { ok: false, error: "device" };

  const key = params.get("k") ?? "";
  const keyBytes = fromB64url(key);
  if (!keyBytes || keyBytes.length !== 32 || !/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false, error: "key" };

  const hosts = [...new Set((params.get("h") ?? "").split(",").map((h) => h.trim()).filter((h) => isPrivateIPv4(h, opts.loopback)))].slice(0, MAX_HOSTS);
  if (hosts.length === 0) return { ok: false, error: "hosts" };

  const portText = params.get("p") ?? "";
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "port" };

  const name = (params.get("n") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
  return { ok: true, pairing: { deviceId, key, hosts, port, desktopName: name || DEFAULT_DESKTOP_NAME } };
}
