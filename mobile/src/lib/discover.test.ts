import { describe, expect, it } from "vitest";
import { toB64url } from "./bytes";
import { CancelledError, createClient, type Transport } from "./client";
import { candidates, lookAgain, networksOf, rediscover, withFound, type LookPhase, type LookProgress } from "./discover";

const net = (h: string) => h.split(".").slice(0, 3).join(".");

describe("candidates", () => {
  it("lists the old /24 nearest first, without the saved hosts, and only private networks", () => {
    const c = candidates(["192.168.1.20", "8.8.8.8"]);
    expect(c).toHaveLength(253);
    expect(c.slice(0, 3)).toEqual(["192.168.1.19", "192.168.1.21", "192.168.1.18"]);
    expect(c).not.toContain("192.168.1.20");
    expect(c.every((h) => h.startsWith("192.168.1."))).toBe(true);
  });

  it("covers at most two networks", () => {
    expect(new Set(candidates(["10.0.0.5", "10.0.1.5", "10.0.2.5"]).map(net)).size).toBe(2);
    expect(networksOf(["10.0.0.5", "8.8.8.8", "10.0.0.9", "192.168.1.2"])).toEqual(["10.0.0", "192.168.1"]);
  });

  it("scans only the phone's own network when the phone knows it (review #3)", () => {
    // The computer was at 192.168.1.20; the phone is now on 10.0.2.x (another Wi-Fi).
    const c = candidates(["192.168.1.20"], ["10.0.2.16"]);
    expect(c).toHaveLength(253);
    expect(c.every((h) => net(h) === "10.0.2")).toBe(true);
    expect(c).not.toContain("10.0.2.16");
    // Same network as before: nearest to the old address, never the phone itself.
    const same = candidates(["192.168.1.20"], ["192.168.1.21"]);
    expect(same.slice(0, 3)).toEqual(["192.168.1.19", "192.168.1.18", "192.168.1.22"]);
    expect(same).not.toContain("192.168.1.21");
    // A phone address that isn't private (mobile data) doesn't count: the old networks then.
    expect(candidates(["192.168.1.20"], ["100.64.3.4"]).every((h) => net(h) === "192.168.1")).toBe(true);
  });

  it("puts the found host first and keeps at most 4", () => {
    expect(withFound(["a", "b", "c", "d"], "e")).toEqual(["e", "a", "b", "c"]);
    expect(withFound(["a", "b"], "b")).toEqual(["b", "a"]);
  });
});

describe("rediscover", () => {
  it("returns the host whose sealed hello opened, and stops asking the others", async () => {
    const asked: string[] = [];
    const found = await rediscover(candidates(["192.168.1.20"]), async (h, signal) => {
      asked.push(h);
      await new Promise((r) => setTimeout(r, 1));
      return !signal.aborted && h === "192.168.1.40";
    }, { concurrency: 4 });
    expect(found).toBe("192.168.1.40");
    expect(asked.length).toBeLessThan(60);
  });

  it("null when nobody answers (or a probe throws), and stops when cancelled", async () => {
    expect(await rediscover(candidates(["10.1.2.3"]), async () => { throw new Error("x"); })).toBeNull();
    let n = 0;
    expect(await rediscover(candidates(["10.1.2.3"]), async () => (n++, false), { concurrency: 1, cancelled: () => n >= 3 })).toBeNull();
    expect(n).toBe(3);
    expect(await rediscover([], async () => true)).toBeNull();
  });

  it("reports its progress", async () => {
    const seen: number[] = [];
    await rediscover(["10.0.0.1", "10.0.0.2", "10.0.0.3"], async () => false, { concurrency: 1, onProgress: (d, t) => seen.push(d * 10 + t) });
    expect(seen).toEqual([13, 23, 33]);
  });
});

describe("look for my computer again (review #3, #19)", () => {
  const saved = ["192.168.1.20", "192.168.1.30"];
  type Io = Parameters<typeof lookAgain>[1];
  const io = (over: Partial<Io> & { answers?: (h: string, p: LookPhase) => boolean; phone?: string[] }): { io: Io; asked: [string, LookPhase][]; progress: LookProgress[] } => {
    const asked: [string, LookPhase][] = [];
    const progress: LookProgress[] = [];
    return {
      asked,
      progress,
      io: {
        hello: async (h, _s, p) => (asked.push([h, p]), over.answers?.(h, p) ?? false),
        phoneAddresses: async () => over.phone ?? [],
        cancelled: () => false,
        onProgress: (p) => progress.push(p),
        concurrency: 8,
        ...over,
      },
    };
  };

  it("says it's at its usual address when a saved one answers, and scans nothing", async () => {
    const t = io({ answers: (h) => h === "192.168.1.30" });
    expect(await lookAgain(saved, t.io)).toEqual({ kind: "usual", host: "192.168.1.30" });
    expect(t.asked.every(([, p]) => p === "usual")).toBe(true);
    expect(t.asked.map(([h]) => h).sort()).toEqual(saved);
  });

  it("then scans the phone's network, with progress", async () => {
    const t = io({ phone: ["10.0.2.16"], answers: (h, p) => p === "scan" && h === "10.0.2.2" });
    expect(await lookAgain(saved, t.io)).toEqual({ kind: "found", host: "10.0.2.2" });
    expect(t.asked.filter(([, p]) => p === "scan").every(([h]) => net(h) === "10.0.2")).toBe(true);
    expect(t.progress[0]).toEqual({ phase: "usual", done: 0, total: 2 });
    expect(t.progress.some((p) => p.phase === "scan" && p.total === 253)).toBe(true);
  });

  it("without the phone's address, the saved hosts' network", async () => {
    const t = io({ phoneAddresses: async () => { throw new Error("no module"); } });
    expect(await lookAgain(saved, t.io)).toEqual({ kind: "not-found" });
    expect(t.asked.filter(([, p]) => p === "scan").every(([h]) => net(h) === "192.168.1")).toBe(true);
    expect(t.asked.filter(([, p]) => p === "scan")).toHaveLength(252);
  });

  it("Cancel stops it", async () => {
    let n = 0;
    const t = io({ hello: async () => (n++, false), cancelled: () => n >= 5 });
    expect(await lookAgain(saved, t.io)).toEqual({ kind: "cancelled" });
    expect(n).toBeLessThan(5 + 8);
  });
});

describe("client cancellation (F9, B3)", () => {
  const pairing = { deviceId: "dev0000000000000000000", key: toB64url(new Uint8Array(32).fill(1)), hosts: ["192.168.1.20", "192.168.1.21"], port: 1 };

  it("a cancelled sync aborts the request in flight and refuses later ones", async () => {
    const ctrl = new AbortController();
    let seen = 0;
    const transport: Transport = (_url, init) =>
      new Promise((_res, rej) => {
        seen++;
        init.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    const call = createClient({ pairing: { ...pairing, desktopName: "D" }, transport, random: (n) => new Uint8Array(n), now: Date.now, signal: ctrl.signal });
    const p = call("/v1/snapshot", {});
    setTimeout(() => ctrl.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    // The second host was never tried.
    expect(seen).toBe(1);
    await expect(call("/v1/hello", {})).rejects.toBeInstanceOf(CancelledError);
  });
});
