// Talks to the desktop: tries the pairing's hosts in order, seals each
// request, opens each response, and turns failures into a few typed codes.
import { EnvelopeError, keyBytes, openResponse, sealCall, type RandomBytes, type Reply } from "./envelope";
import type { Pairing } from "./pairing";

export type SyncErrorCode =
  | "offline" // no host answered: not on the same Wi-Fi
  | "off" // a host refused the connection: phone sync is off (or Hivo is closed)
  | "forgotten" // bare 401: the desktop no longer knows this phone's key (or, from an older desktop, the clock is off)
  | "clock" // sealed "clock": the request opened but its time is more than 2 minutes off the computer's
  | "demo" // the desktop is in demo mode
  | "read-only" // sealed "read only": the desktop's workspace can't be saved (unreadable, or from a newer Hivo)
  | "busy" // 429 / 503 / "busy": scan running, workspace loading, rate limit; retry in a few seconds
  | "too-big" // 413, "too many changes", "note too long": the whole push was refused
  | "outdated" // 404 or "bad request": the two apps don't speak the same version
  | "expired" // bare 401 on /v1/pair: the QR was used already, replaced, or is more than 5 minutes old
  | "pending" // sealed "pending": paired, but not confirmed on the computer yet (check the code there)
  | "not-confirmed" // the computer dropped the pairing before it was confirmed ("Not my phone", 5 minutes, a restart)
  | "server"; // anything else (bad envelope, other error message)

export class SyncError extends Error {
  constructor(public code: SyncErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SyncError";
  }
}

export type HttpResponse = { status: number; text: () => Promise<string> };
export type Transport = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponse>;

export type ClientOptions = {
  pairing: Pairing;
  transport: Transport;
  random: RandomBytes;
  now: () => number;
  timeoutMs?: number;
  /** A failure faster than this is a refused connection (port closed), not an unreachable network. */
  refusedUnderMs?: number;
  /** `/v1/pair` only: the phone's X25519 public key (b64url), sent next to the envelope. */
  pairWith?: string;
  /** A pairing from before 1.2 got its first bound answer: save `bound: true`
   * (unbound answers are refused from then on). */
  onBound?: () => void;
};

/** The pairing path (v1.2): the first request, sealed with the derived key. */
export const PAIR_PATH = "/v1/pair";

/**
 * Opens an answer. 1.2 pairings (and older ones once they saw a bound answer)
 * take only an answer bound to `nonce`, the request just sent: an answer
 * recorded earlier (say "stored" for an upload) can't be replayed. A pairing
 * from before 1.2 still takes the 1.1 form until its computer is updated.
 * Returns the reply and whether it was bound. Throws EnvelopeError.
 */
export function openAnswer(key: Uint8Array, deviceId: string, path: string, env: unknown, nonce: string, requireBound: boolean): { reply: Reply; bound: boolean } {
  try {
    return { reply: openResponse(key, deviceId, path, env, nonce), bound: true };
  } catch (e) {
    if (requireBound || !(e instanceof EnvelopeError)) throw e instanceof EnvelopeError ? new EnvelopeError("unbound answer") : e;
  }
  return { reply: openResponse(key, deviceId, path, env), bound: false };
}

/** How long to wait for `path`. A chunk is ~700 KB sealed: on weak Wi-Fi 5 s
 * would cut every one at the same point. The desktop gives its webview 10 s
 * for a snapshot or a notes push, so the phone waits a little longer. */
export function timeoutFor(path: string, base: number): number {
  if (path === "/v1/upload/chunk") return Math.max(base, 30_000);
  if (path === "/v1/snapshot" || path === "/v1/notes") return Math.max(base, 12_000);
  return base;
}

/** Returns `call(path, payload)`; remembers the host that answered last and tries it first. */
export function createClient(opts: ClientOptions) {
  const key = keyBytes(opts.pairing.key);
  let requireBound = opts.pairing.scheme === "1.2" || opts.pairing.bound === true;
  const { deviceId, port } = opts.pairing;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const refusedUnderMs = opts.refusedUnderMs ?? 1500;
  let hosts = [...opts.pairing.hosts];

  async function call(path: string, payload: unknown): Promise<unknown> {
    let refused = false;
    for (const host of hosts) {
      const sealed = sealCall(key, deviceId, path, payload, opts.random, opts.now());
      const body = JSON.stringify(path === PAIR_PATH && opts.pairWith ? { ...sealed.envelope, x: opts.pairWith } : sealed.envelope);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutFor(path, timeoutMs));
      const started = opts.now();
      let res: HttpResponse;
      let text: string;
      try {
        res = await opts.transport(`http://${host}:${port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Hivo-Device": deviceId },
          body,
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch {
        if (!ctrl.signal.aborted && opts.now() - started < refusedUnderMs) refused = true;
        continue;
      } finally {
        clearTimeout(timer);
      }
      // This host answered: try it first next time.
      hosts = [host, ...hosts.filter((h) => h !== host)];
      // Bare statuses aren't authenticated: they only ever stop or delay a
      // sync, never mark anything as delivered.
      if (res.status === 401) throw new SyncError(path === PAIR_PATH ? "expired" : "forgotten");
      if (res.status === 429 || res.status === 503) throw new SyncError("busy", `HTTP ${res.status}`);
      if (res.status === 413) throw new SyncError("too-big", "HTTP 413");
      if (res.status === 404) throw new SyncError("outdated", "HTTP 404");
      if (res.status !== 200) throw new SyncError("server", `HTTP ${res.status}`);
      let reply: Reply;
      try {
        const opened = openAnswer(key, deviceId, path, JSON.parse(text), sealed.nonce, requireBound);
        reply = opened.reply;
        if (opened.bound && !requireBound) {
          // This computer speaks 1.2 now: never take an unbound answer again.
          requireBound = true;
          opts.onBound?.();
        }
      } catch (e) {
        throw new SyncError("server", e instanceof EnvelopeError ? e.message : "bad response");
      }
      if (reply.ok) return reply.body;
      if (reply.error === "demo") throw new SyncError("demo");
      if (reply.error === "clock") throw new SyncError("clock");
      if (reply.error === "pending") throw new SyncError("pending");
      if (reply.error === "busy") throw new SyncError("busy");
      if (reply.error === "read only") throw new SyncError("read-only");
      if (reply.error === "bad request") throw new SyncError("outdated", reply.error);
      if (/^(too many changes|note too long)/.test(reply.error)) throw new SyncError("too-big", reply.error);
      throw new SyncError("server", reply.error.slice(0, 200));
    }
    throw new SyncError(refused ? "off" : "offline");
  }

  return call;
}
