// The computer's address changed (DHCP gave it another one, a new router):
// every saved host fails. Only when the user taps Settings → "Look for my
// computer again" (never on its own: review #3), the phone asks the saved
// addresses first, then each address of the /24 network it's on now (else
// of the saved hosts' /24 networks) for a sealed /v1/hello, a few at a
// time. Only the paired computer can answer one (the answer is opened with
// the pairing's key), so a stranger on the network can't pose as it. Pure,
// the requests are injected.
import { isPrivateIPv4, MAX_HOSTS } from "./pairing";

/** Networks scanned, 254 addresses each. */
export const MAX_NETWORKS = 2;
/** Requests in flight at once. */
export const PROBE_CONCURRENCY = 32;
/** How long one address gets to answer (a LAN host answers in a few ms). */
export const PROBE_TIMEOUT_MS = 1500;
/** The saved addresses get longer: a computer just waking up answers slowly. */
export const SAVED_TIMEOUT_MS = 4000;

const netOf = (ip: string): string => ip.split(".").slice(0, 3).join(".");

/** The private /24 networks of these addresses, in order, at most MAX_NETWORKS. */
export function networksOf(addrs: string[]): string[] {
  const nets: string[] = [];
  for (const h of addrs) {
    if (!isPrivateIPv4(h)) continue;
    const net = netOf(h);
    if (!nets.includes(net)) nets.push(net);
  }
  return nets.slice(0, MAX_NETWORKS);
}

/**
 * The addresses to ask, nearest first (an address close to the old one is
 * the likeliest new one). `phone`: the phone's own Wi-Fi addresses, when the
 * phone knows them: only its network(s) are scanned then, never the old
 * ones (another Wi-Fi that happens to share the old range isn't the
 * computer's). Unknown (empty): the saved hosts' networks. The saved hosts
 * and the phone itself are never in the list.
 */
export function candidates(hosts: string[], phone: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set([...hosts, ...phone]);
  const own = networksOf(phone);
  const nets = own.length > 0 ? own : networksOf(hosts);
  for (const net of nets) {
    const near = hosts.find((h) => netOf(h) === net) ?? phone.find((h) => netOf(h) === net);
    const mid = Number(near?.split(".")[3] ?? 1);
    const last = Array.from({ length: 254 }, (_, i) => i + 1).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
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
 * Asks every address of `list`, `concurrency` at a time, and returns the
 * first that answered `hello` (true), or null. `hello(host, signal)`
 * resolves true only for a sealed answer from the paired computer; it
 * should give up when `signal` aborts (once one is found, or
 * `cancelled()`). `onProgress(done, total)` after each answer.
 */
export async function rediscover(
  list: string[],
  hello: (host: string, signal: AbortSignal) => Promise<boolean>,
  opts: { concurrency?: number; cancelled?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<string | null> {
  const ctrl = new AbortController();
  let next = 0;
  let done = 0;
  let found: string | null = null;
  const worker = async () => {
    while (!found && !ctrl.signal.aborted && next < list.length) {
      if (opts.cancelled?.()) {
        ctrl.abort();
        return;
      }
      const host = list[next++];
      const ok = await hello(host, ctrl.signal).catch(() => false);
      done++;
      if (ok && !found) {
        found = host;
        ctrl.abort();
      }
      opts.onProgress?.(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? PROBE_CONCURRENCY, list.length) }, worker));
  return found;
}

export type LookPhase = "usual" | "scan";
export type LookProgress = { phase: LookPhase; done: number; total: number };
/** usual: it answered at a saved address; found: at a new one (`host`). */
export type LookResult = { kind: "usual"; host: string } | { kind: "found"; host: string } | { kind: "not-found" } | { kind: "cancelled" };

/**
 * "Look for my computer again": the saved addresses first (all at once);
 * none answers, the phone's network (`phoneAddresses`, empty when unknown)
 * or else the saved hosts' networks, address by address.
 */
export async function lookAgain(
  saved: string[],
  io: {
    hello: (host: string, signal: AbortSignal, phase: LookPhase) => Promise<boolean>;
    phoneAddresses: () => Promise<string[]>;
    cancelled: () => boolean;
    onProgress?: (p: LookProgress) => void;
    concurrency?: number;
  },
): Promise<LookResult> {
  const progress = (phase: LookPhase) => (done: number, total: number) => io.onProgress?.({ phase, done, total });
  io.onProgress?.({ phase: "usual", done: 0, total: saved.length });
  const usual = await rediscover(saved, (h, s) => io.hello(h, s, "usual"), { concurrency: Math.max(1, saved.length), cancelled: io.cancelled, onProgress: progress("usual") });
  if (usual) return { kind: "usual", host: usual };
  if (io.cancelled()) return { kind: "cancelled" };
  const phone = await io.phoneAddresses().catch(() => [] as string[]);
  const list = candidates(saved, phone);
  io.onProgress?.({ phase: "scan", done: 0, total: list.length });
  const found = await rediscover(list, (h, s) => io.hello(h, s, "scan"), { concurrency: io.concurrency, cancelled: io.cancelled, onProgress: progress("scan") });
  if (found) return { kind: "found", host: found };
  return io.cancelled() ? { kind: "cancelled" } : { kind: "not-found" };
}
