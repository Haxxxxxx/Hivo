import { describe, expect, it } from "vitest";
import { toB64url } from "./bytes";
import { CancelledError, createClient, type Transport } from "./client";
import { candidates, rediscover, withFound } from "./discover";

describe("candidates", () => {
  it("lists the old /24 nearest first, without the saved hosts, and only private networks", () => {
    const c = candidates(["192.168.1.20", "8.8.8.8"]);
    expect(c).toHaveLength(253);
    expect(c.slice(0, 3)).toEqual(["192.168.1.19", "192.168.1.21", "192.168.1.18"]);
    expect(c).not.toContain("192.168.1.20");
    expect(c.every((h) => h.startsWith("192.168.1."))).toBe(true);
  });

  it("covers at most two networks", () => {
    expect(new Set(candidates(["10.0.0.5", "10.0.1.5", "10.0.2.5"]).map((h) => h.split(".").slice(0, 3).join("."))).size).toBe(2);
  });

  it("puts the found host first and keeps at most 4", () => {
    expect(withFound(["a", "b", "c", "d"], "e")).toEqual(["e", "a", "b", "c"]);
    expect(withFound(["a", "b"], "b")).toEqual(["b", "a"]);
  });
});

describe("rediscover", () => {
  it("returns the host whose sealed hello opened, and stops asking the others", async () => {
    const asked: string[] = [];
    const found = await rediscover(["192.168.1.20"], async (h, signal) => {
      asked.push(h);
      await new Promise((r) => setTimeout(r, 1));
      return !signal.aborted && h === "192.168.1.40";
    }, { concurrency: 4 });
    expect(found).toBe("192.168.1.40");
    expect(asked.length).toBeLessThan(60);
  });

  it("null when nobody answers (or a probe throws), and stops when cancelled", async () => {
    expect(await rediscover(["10.1.2.3"], async () => { throw new Error("x"); })).toBeNull();
    let n = 0;
    expect(await rediscover(["10.1.2.3"], async () => (n++, false), { concurrency: 1, cancelled: () => n >= 3 })).toBeNull();
    expect(n).toBe(3);
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
