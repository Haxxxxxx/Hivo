import { describe, expect, it } from "vitest";
import { toB64url } from "./bytes";
import { parsePairingUrl } from "./pairing";

const d = toB64url(new Uint8Array(16).fill(7));
const k = toB64url(new Uint8Array(32).fill(9));
const url = (q: string) => `hivo://pair?${q}`;
const good = `v=1&d=${d}&k=${k}&h=192.168.1.20,10.0.0.5&p=51234&n=${encodeURIComponent("Studio Mac")}`;

describe("parsePairingUrl", () => {
  it("refuses loopback on a phone (127.x is the phone itself), allows it when asked (iOS Simulator)", () => {
    const q = (h: string) => url(`v=1&d=${d}&k=${k}&h=${h}&p=80`);
    expect(parsePairingUrl(q("127.0.0.1"))).toEqual({ ok: false, error: "hosts" });
    expect(parsePairingUrl(q("127.0.0.1"), { loopback: true }).ok).toBe(true);
  });

  it("parses a full pairing URL", () => {
    const r = parsePairingUrl(url(good));
    expect(r).toEqual({ ok: true, pairing: { deviceId: d, key: k, hosts: ["192.168.1.20", "10.0.0.5"], port: 51234, desktopName: "Studio Mac" } });
  });
  it("tolerates whitespace, a missing name and '+' for spaces", () => {
    const r = parsePairingUrl(`  ${url(`v=1&d=${d}&k=${k}&h=172.16.0.2&p=80`)}\n`);
    expect("pairing" in r && r.pairing.desktopName).toBe("Hivo");
    const r2 = parsePairingUrl(url(`v=1&d=${d}&k=${k}&h=172.16.0.2&p=80&n=Studio+Mac`));
    expect("pairing" in r2 && r2.pairing.desktopName).toBe("Studio Mac");
  });
  it("drops public and malformed hosts, keeps order", () => {
    const r = parsePairingUrl(url(`v=1&d=${d}&k=${k}&h=8.8.8.8,10.1.2.3,999.1.1.1,example.com,192.168.0.9&p=80`));
    expect("pairing" in r && r.pairing.hosts).toEqual(["10.1.2.3", "192.168.0.9"]);
  });
  it("keeps at most 4 hosts", () => {
    const r = parsePairingUrl(url(`v=1&d=${d}&k=${k}&h=10.0.0.1,10.0.0.2,10.0.0.3,10.0.0.4,10.0.0.5&p=80`));
    expect("pairing" in r && r.pairing.hosts).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]);
  });
  it.each([
    ["", "not-hivo"],
    ["https://example.com/pair?v=1", "not-hivo"],
    ["hivo://other?v=1", "not-hivo"],
    [url(good.replace("v=1", "v=3")), "version"],
    [url(good.replace("v=1", "v=2")), "key"],
    [url(good.replace(`d=${d}`, "d=short")), "device"],
    [url(good.replace(`k=${k}`, `k=${toB64url(new Uint8Array(31))}`)), "key"],
    [url(good.replace(`k=${k}`, "k=" + k.slice(0, -2) + "+/")), "key"],
    [url(good.replace("h=192.168.1.20,10.0.0.5", "h=8.8.8.8")), "hosts"],
    [url(good.replace("p=51234", "p=70000")), "port"],
    [url(good.replace("p=51234", "p=abc")), "port"],
    [url(good.replace("&p=51234", "")), "port"],
    [url("v=1&n=%E0%A4%A"), "not-hivo"],
  ])("rejects %s", (input, error) => {
    expect(parsePairingUrl(input)).toEqual({ ok: false, error });
  });
});
