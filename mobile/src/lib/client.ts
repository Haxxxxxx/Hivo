// Talks to the desktop: tries the pairing's hosts in order, seals each
// request, opens each response, and turns failures into a few typed codes.
import { EnvelopeError, keyBytes, openResponse, sealRequest, type RandomBytes } from "./envelope";
import type { Pairing } from "./pairing";

export type SyncErrorCode =
  | "offline" // no host answered: not on the same Wi-Fi
  | "off" // a host refused the connection: phone sync is off (or Hivo is closed)
  | "forgotten" // bare 401: the desktop no longer knows this phone's key (or, from an older desktop, the clock is off)
  | "clock" // sealed "clock": the request opened but its time is more than 2 minutes off the computer's
  | "demo" // the desktop is in demo mode
  | "busy" // 429 / 503 / "busy": scan running, workspace loading, rate limit; retry in a few seconds
  | "too-big" // 413, "too many changes", "note too long": the whole push was refused
  | "outdated" // 404 or "bad request": the two apps don't speak the same version
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
};

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
  const { deviceId, port } = opts.pairing;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const refusedUnderMs = opts.refusedUnderMs ?? 1500;
  let hosts = [...opts.pairing.hosts];

  async function call(path: string, payload: unknown): Promise<unknown> {
    let refused = false;
    for (const host of hosts) {
      const body = JSON.stringify(sealRequest(key, deviceId, path, payload, opts.random, opts.now()));
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
      if (res.status === 401) throw new SyncError("forgotten");
      if (res.status === 429 || res.status === 503) throw new SyncError("busy", `HTTP ${res.status}`);
      if (res.status === 413) throw new SyncError("too-big", "HTTP 413");
      if (res.status === 404) throw new SyncError("outdated", "HTTP 404");
      if (res.status !== 200) throw new SyncError("server", `HTTP ${res.status}`);
      let reply;
      try {
        reply = openResponse(key, deviceId, path, JSON.parse(text));
      } catch (e) {
        throw new SyncError("server", e instanceof EnvelopeError ? e.message : "bad response");
      }
      if (reply.ok) return reply.body;
      if (reply.error === "demo") throw new SyncError("demo");
      if (reply.error === "clock") throw new SyncError("clock");
      if (reply.error === "busy") throw new SyncError("busy");
      if (reply.error === "bad request") throw new SyncError("outdated", reply.error);
      if (/^(too many changes|note too long)/.test(reply.error)) throw new SyncError("too-big", reply.error);
      throw new SyncError("server", reply.error.slice(0, 200));
    }
    throw new SyncError(refused ? "off" : "offline");
  }

  return call;
}
