import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromB64url, toB64url } from "./bytes";
import { createClient, openAnswer, SyncError, type Transport } from "./client";
import { open, aad, openRequestFull, ReplayGuard, sealCall, sealResponse, type Reply } from "./envelope";
import { completePairing, deriveDeviceKey, phoneDerive } from "./handshake";
import { parsePairingUrl, type PairOffer, type Pairing } from "./pairing";

const rnd = (n: number) => new Uint8Array(randomBytes(n));
const seq = (start: number) => Uint8Array.from({ length: 32 }, (_, i) => i + start);

describe("pairing key derivation", () => {
  it("matches the desktop's test vector (phone_sync.rs key_derivation_test_vector)", () => {
    const desk = seq(1);
    const phone = seq(0x21);
    const deviceId = toB64url(new Uint8Array(16).fill(7));
    const token = toB64url(new Uint8Array(32).fill(0x55));
    const deskPub = x25519.getPublicKey(desk);
    expect(toB64url(deskPub)).toBe("B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw");
    const { key, phonePub } = phoneDerive(phone, { deviceId, token, desktopKey: toB64url(deskPub) });
    expect(toB64url(phonePub)).toBe("WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns");
    expect(toB64url(key)).toBe("nuf6rptKkMpoSSsZ3ooSuRlVMKdcr0uHlFRRwqLz8bQ");
    // The desktop's side gives the same key.
    const deskKey = deriveDeviceKey(x25519.getSharedSecret(desk, phonePub), fromB64url(token)!, deviceId, deskPub, phonePub);
    expect(toB64url(deskKey)).toBe(toB64url(key));
  });

  it("refuses a low-order desktop key", () => {
    expect(() => phoneDerive(seq(1), { deviceId: "d", token: toB64url(new Uint8Array(32)), desktopKey: toB64url(new Uint8Array(32)) })).toThrow();
  });
});

describe("v2 pairing links", () => {
  const d = toB64url(new Uint8Array(16).fill(7));
  const t = toB64url(new Uint8Array(32).fill(1));
  const x = toB64url(new Uint8Array(32).fill(2));
  it("parses an offer (token + desktop key, no device key)", () => {
    expect(parsePairingUrl(`hivo://pair?v=2&d=${d}&t=${t}&x=${x}&h=192.168.1.20&p=51234&n=Studio`)).toEqual({
      ok: true,
      offer: { deviceId: d, token: t, desktopKey: x, hosts: ["192.168.1.20"], port: 51234, desktopName: "Studio" },
    });
  });
  it("refuses a v2 link without its token or desktop key", () => {
    expect(parsePairingUrl(`hivo://pair?v=2&d=${d}&x=${x}&h=192.168.1.20&p=1`)).toEqual({ ok: false, error: "key" });
    expect(parsePairingUrl(`hivo://pair?v=2&d=${d}&t=${t}&h=192.168.1.20&p=1`)).toEqual({ ok: false, error: "key" });
  });
});

/** A 1.2 desktop: one pending QR (`/v1/pair`, single use), then hello. */
function desktop12(now = Date.now) {
  const secret = rnd(32);
  const desktopPub = x25519.getPublicKey(secret);
  const deviceId = toB64url(rnd(16));
  const token = rnd(32);
  let pending = true;
  let deviceKey: Uint8Array | null = null;
  const guard = new ReplayGuard();
  const offer: PairOffer = { deviceId, token: toB64url(token), desktopKey: toB64url(desktopPub), hosts: ["192.168.1.20"], port: 1, desktopName: "QR name" };
  const transport: Transport = async (url, init) => {
    const path = new URL(url).pathname;
    const env = JSON.parse(init.body) as { n: string; c: string; x?: string };
    let key = deviceKey;
    if (path === "/v1/pair" && pending && env.x) {
      const phonePub = fromB64url(env.x)!;
      key = deriveDeviceKey(x25519.getSharedSecret(secret, phonePub), token, deviceId, desktopPub, phonePub);
    }
    if (!key) return { status: 401, text: async () => "" };
    let req;
    try {
      req = openRequestFull(key, deviceId, path, env, now(), guard);
    } catch {
      return { status: 401, text: async () => "" };
    }
    if (path === "/v1/pair" && pending) {
      pending = false;
      deviceKey = key;
    }
    const reply: Reply = { ok: true, body: { desktopName: "Studio", hivoVersion: "0.7.0", protocol: "1.2", phone: req.body } };
    return { status: 200, text: async () => JSON.stringify(sealResponse(key, deviceId, path, reply, rnd, req.nonce)) };
  };
  return { offer, transport, key: () => deviceKey };
}

describe("completePairing (v1.2)", () => {
  const opts = (transport: Transport) => ({ transport, random: rnd, now: Date.now, phoneName: "Pixel", appVersion: "0.7.0" });

  it("pairs once: both sides hold the same derived key, the QR then stops working", async () => {
    const desk = desktop12();
    const r = await completePairing(desk.offer, opts(desk.transport));
    expect(r.pairing).toMatchObject({ deviceId: desk.offer.deviceId, scheme: "1.2", desktopName: "Studio", hosts: ["192.168.1.20"] });
    expect(r.desktopVersion).toBe("0.7.0");
    expect(r.pairing.key).toBe(toB64url(desk.key()!));
    // A photo of the QR, scanned on another phone: refused.
    await expect(completePairing(desk.offer, opts(desk.transport))).rejects.toMatchObject({ code: "expired" });
    // The paired phone syncs.
    const call = createClient({ pairing: r.pairing, transport: desk.transport, random: rnd, now: Date.now });
    expect(await call("/v1/hello", {})).toMatchObject({ protocol: "1.2" });
  });

  it("an answer lost after the QR was burnt: sent again with the same key, answered", async () => {
    const desk = desktop12();
    let calls = 0;
    const lossy: Transport = async (url, init) => {
      const r = await desk.transport(url, init);
      if (++calls === 1) throw new TypeError("Network request failed"); // processed, answer lost
      return r;
    };
    const r = await completePairing(desk.offer, { ...opts(lossy), sleep: async () => {} });
    expect(r.pairing.key).toBe(toB64url(desk.key()!));
    expect(calls).toBe(2);
  });

  it("refuses an answer from someone without the computer's secret", async () => {
    // Someone who saw the QR answers in the computer's place: they can't seal with the derived key.
    const desk = desktop12();
    const mitm: Transport = async () => ({ status: 200, text: async () => JSON.stringify(sealResponse(rnd(32), desk.offer.deviceId, "/v1/pair", { ok: true, body: {} }, rnd, "x")) });
    await expect(completePairing(desk.offer, opts(mitm))).rejects.toMatchObject({ code: "server" });
  });
});

describe("answers bound to their request", () => {
  const key = rnd(32);
  const dev = toB64url(rnd(16));
  const legacy: Pairing = { deviceId: dev, key: toB64url(key), hosts: ["192.168.1.20"], port: 1, desktopName: "D" };

  it("openAnswer takes only the answer to this request when binding is required", () => {
    const { nonce } = sealCall(key, dev, "/v1/upload/finish", {}, rnd, Date.now());
    const mine = sealResponse(key, dev, "/v1/upload/finish", { ok: true, body: { status: "stored" } }, rnd, nonce);
    const older = sealResponse(key, dev, "/v1/upload/finish", { ok: true, body: { status: "stored" } }, rnd, "an-earlier-request");
    const unbound = sealResponse(key, dev, "/v1/upload/finish", { ok: true, body: { status: "stored" } }, rnd);
    expect(openAnswer(key, dev, "/v1/upload/finish", mine, nonce, true)).toMatchObject({ bound: true, reply: { ok: true } });
    expect(() => openAnswer(key, dev, "/v1/upload/finish", older, nonce, true)).toThrow(/unbound/);
    expect(() => openAnswer(key, dev, "/v1/upload/finish", unbound, nonce, true)).toThrow(/unbound/);
    // A pairing from before 1.2 still takes the 1.1 form…
    expect(openAnswer(key, dev, "/v1/upload/finish", unbound, nonce, false)).toMatchObject({ bound: false });
    // …but never another request's bound answer.
    expect(() => openAnswer(key, dev, "/v1/upload/finish", older, nonce, false)).toThrow();
  });

  it("a 1.2 pairing refuses a replayed answer", async () => {
    // Someone on the Wi-Fi answers every request after the first with the first answer.
    const guard = new ReplayGuard();
    let recorded: string | null = null;
    const t: Transport = async (url, init) => {
      if (recorded) {
        const old = recorded;
        return { status: 200, text: async () => old };
      }
      const path = new URL(url).pathname;
      const req = openRequestFull(key, dev, path, JSON.parse(init.body), Date.now(), guard);
      recorded = JSON.stringify(sealResponse(key, dev, path, { ok: true, body: { n: 1 } }, rnd, req.nonce));
      const text = recorded;
      return { status: 200, text: async () => text };
    };
    const call = createClient({ pairing: { ...legacy, scheme: "1.2" }, transport: t, random: rnd, now: Date.now });
    expect(await call("/v1/inbox", {})).toEqual({ n: 1 });
    await expect(call("/v1/inbox", {})).rejects.toBeInstanceOf(SyncError);
  });

  it("hello negotiation: an old pairing upgrades on the first bound answer and stays upgraded", async () => {
    const guard = new ReplayGuard();
    let v11 = false;
    const t: Transport = async (url, init) => {
      const path = new URL(url).pathname;
      const req = openRequestFull(key, dev, path, JSON.parse(init.body), Date.now(), guard);
      expect(req.v).toBe("1.2"); // the phone always says what it speaks
      const reply: Reply = { ok: true, body: { desktopName: "D", hivoVersion: v11 ? "0.6.2" : "0.7.0", ...(v11 ? {} : { protocol: "1.2" }) } };
      return { status: 200, text: async () => JSON.stringify(sealResponse(key, dev, path, reply, rnd, v11 ? undefined : req.nonce)) };
    };
    // A 1.1 desktop: still works.
    v11 = true;
    let upgraded = 0;
    const call = createClient({ pairing: legacy, transport: t, random: rnd, now: Date.now, onBound: () => upgraded++ });
    expect(await call("/v1/hello", {})).toMatchObject({ hivoVersion: "0.6.2" });
    expect(upgraded).toBe(0);
    // The desktop updates: bound answers, the pairing is marked…
    v11 = false;
    expect(await call("/v1/hello", {})).toMatchObject({ protocol: "1.2" });
    expect(upgraded).toBe(1);
    // …and unbound answers are refused from then on (an old one replayed, say).
    v11 = true;
    await expect(call("/v1/hello", {})).rejects.toMatchObject({ code: "server" });
    // A saved `bound: true` does the same from the start.
    const again = createClient({ pairing: { ...legacy, bound: true }, transport: t, random: rnd, now: Date.now });
    await expect(again("/v1/hello", {})).rejects.toMatchObject({ code: "server" });
  });

  it("the request says 1.2 and carries a fresh nonce", () => {
    const a = sealCall(key, dev, "/v1/hello", {}, rnd, 5);
    const b = sealCall(key, dev, "/v1/hello", {}, rnd, 5);
    expect(a.nonce).not.toBe(b.nonce);
    expect(JSON.parse(open(key, aad(dev, "/v1/hello", false), a.envelope))).toMatchObject({ ts: 5, nonce: a.nonce, v: "1.2" });
    expect(new TextDecoder().decode(aad(dev, "/v1/hello", true, a.nonce))).toBe(`hivo-sync-v1|${dev}|/v1/hello|resp|${a.nonce}`);
  });
});
