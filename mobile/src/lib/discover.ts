// The computer's address changed (DHCP gave it another one, a new router):
// every saved host fails. Before giving up, the phone asks each address of
// the old /24 networks for a sealed /v1/hello, a few at a time. Only the
// paired computer can answer one (the answer is opened with the pairing's
// key), so a stranger on the network can't pose as it. Pure, the requests
// are injected.
import { isPrivateIPv4, MAX_HOSTS } from "./pairing";

/** Networks scanned (the first saved hosts'), 254 addresses each. */
export const MAX_NETWORKS = 2;
/** Requests in flight at once. */
export const PROBE_CONCURRENCY = 32;
/** How long one address gets to answer (a LAN host answers in a few ms). */
export const PROBE_TIMEOUT_MS = 1500;
/** An automatic search runs at most this often (a button can force one). */
export const AUTO_REDISCOVER_MS = 10 * 60 * 1000;

/** Every other address of the saved hosts' /24 networks, nearest first
 * (addresses close to the old one are the likeliest new ones). */
export function candidates(hosts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set(hosts);
  const nets: string[] = [];
  for (const h of hosts) {
    if (!isPrivateIPv4(h)) continue;
    const net = h.split(".").slice(0, 3).join(".");
    if (!nets.includes(net)) nets.push(net);
  }
  for (const net of nets.slice(0, MAX_NETWORKS)) {
    const own = Number(hosts.find((h) => h.startsWith(`${net}.`))?.split(".")[3] ?? 1);
    const last = Array.from({ length: 254 }, (_, i) => i + 1).sort((a, b) => Math.abs(a - own) - Math.abs(b - own) || a - b);
    for (const x of last) {
      const ip = `${net}.${x}`;
      if (seen.has(ip)) continue;
      seen.add(ip);
      out.push(ip);
    }
  }
  return out;
}

/** The hosts to save once the computer answered at `found`: it first, then the old ones (at most MAX_HOSTS). */
export const withFound = (hosts: string[], found: string): string[] => [found, ...hosts.filter((h) => h !== found)].slice(0, MAX_HOSTS);

/**
 * Asks every candidate, `concurrency` at a time, and returns the first that
 * answered `hello` (true), or null. `hello(host, signal)` resolves true only
 * for a sealed answer from the paired computer; it should give up when
 * `signal` aborts (once one is found, or `cancelled()`).
 */
export async function rediscover(
  hosts: string[],
  hello: (host: string, signal: AbortSignal) => Promise<boolean>,
  opts: { concurrency?: number; cancelled?: () => boolean } = {},
): Promise<string | null> {
  const list = candidates(hosts);
  const ctrl = new AbortController();
  let next = 0;
  let found: string | null = null;
  const worker = async () => {
    while (!found && !ctrl.signal.aborted && next < list.length) {
      if (opts.cancelled?.()) {
        ctrl.abort();
        return;
      }
      const host = list[next++];
      const ok = await hello(host, ctrl.signal).catch(() => false);
      if (ok && !found) {
        found = host;
        ctrl.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? PROBE_CONCURRENCY, list.length) }, worker));
  return found;
}
