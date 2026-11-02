import { describe, expect, it } from "vitest";
import { SyncError } from "./client";
import { carryOver, CONFIRM_TTL_MS, confirmedPairing, extrasBinding, sameComputer, waitForConfirmation } from "./confirm";
import type { Pairing } from "./pairing";
import { editNote, emptyState, type SyncState } from "./sync";

const hello = { phoneName: "Pixel", appVersion: "0.7.0" };

/** A computer answering hello with `answers` in turn (an Error is thrown), then the last one forever. */
function scripted(answers: (unknown | Error)[]) {
  let i = 0;
  const calls: string[] = [];
  const call = async (path: string) => {
    calls.push(path);
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { call, calls };
}

function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("waiting for the computer's confirmation", () => {
  it("keeps asking while the computer says pending (or the Wi-Fi blips), done once it answers", async () => {
    const c = clock();
    const s = scripted([new SyncError("pending"), new SyncError("offline"), new SyncError("busy"), new SyncError("pending"), { desktopName: "Studio", computerId: "computer-0123456789" }]);
    const r = await waitForConfirmation(s.call, hello, { ...c, startedAt: c.now(), cancelled: () => false });
    expect(r).toEqual({ ok: true, hello: { desktopName: "Studio", computerId: "computer-0123456789" } });
    expect(s.calls).toEqual(Array(5).fill("/v1/hello"));
  });

  it("Not my phone (a bare 401 now) or a restarted computer: not-confirmed", async () => {
    const c = clock();
    const s = scripted([new SyncError("pending"), new SyncError("forgotten")]);
    expect(await waitForConfirmation(s.call, hello, { ...c, startedAt: c.now(), cancelled: () => false })).toEqual({ ok: false, code: "not-confirmed" });
  });

  it("gives up after CONFIRM_TTL_MS (the computer dropped it too)", async () => {
    const c = clock();
    const s = scripted([new SyncError("pending")]);
    const r = await waitForConfirmation(s.call, hello, { ...c, startedAt: c.now(), cancelled: () => false });
    expect(r).toEqual({ ok: false, code: "not-confirmed" });
    expect(s.calls.length).toBe(CONFIRM_TTL_MS / 2000 + 1);
  });

  it("stops on another error, or when the user cancels", async () => {
    const c = clock();
    expect(await waitForConfirmation(scripted([new SyncError("outdated")]).call, hello, { ...c, startedAt: c.now(), cancelled: () => false })).toEqual({ ok: false, code: "outdated" });
    let cancel = false;
    const s = scripted([new SyncError("pending")]);
    const sleep = async (ms: number) => {
      await c.sleep(ms);
      cancel = s.calls.length >= 2;
    };
    expect(await waitForConfirmation(s.call, hello, { now: c.now, sleep, startedAt: c.now(), cancelled: () => cancel })).toEqual({ ok: false, code: null });
    expect(s.calls.length).toBe(2);
  });

  it("the confirmed pairing takes the computer's name and id from its hello", () => {
    const p: Pairing = { deviceId: "d1", key: "k", hosts: ["192.168.1.2"], port: 1, desktopName: "QR name", scheme: "1.2" };
    expect(confirmedPairing(p, { desktopName: " Studio ", computerId: "computer-0123456789" })).toEqual({ ...p, desktopName: "Studio", computerId: "computer-0123456789" });
    expect(confirmedPairing(p, null)).toEqual(p);
    expect(confirmedPairing(p, { computerId: "bad id!" })).toEqual(p);
  });
});

describe("pairing again with the same computer", () => {
  const A = "computer-AAAAAAAAAAAAAAAA";
  const B = "computer-BBBBBBBBBBBBBBBB";
  const old: Pairing = { deviceId: "dev-old", key: "k1", hosts: ["192.168.1.2"], port: 1, desktopName: "Studio", scheme: "1.2", computerId: A };
  const item = { kind: "song" as const, id: "/s/a.flp", title: "A", subtitle: "", bpm: null, key: null, url: null, stage: null, note: "old", noteHash: "x" };
  const state = (): SyncState => editNote({ ...emptyState(), items: [item], lastSyncAt: 5, helloDone: true, conflicts: { "song:/s/a.flp": 3 } }, "song", "/s/a.flp", "new text", 10);

  it("same computer id: the library, the notes waiting to sync and the conflicts stay, nothing to re-base", () => {
    const next = { ...old, deviceId: "dev-new", key: "k2" };
    expect(sameComputer(old, next)).toBe(true);
    const s = state();
    const r = carryOver(old, next, s);
    expect(r.keepCache).toBe(true);
    expect(r.sync.items).toEqual([item]);
    expect(Object.keys(r.sync.pending)).toEqual(["song:/s/a.flp"]);
    expect(r.sync.conflicts).toEqual(s.conflicts);
    expect(r.sync.rebase).toBeFalsy();
  });

  it("another computer (or one without an id): only the phone's own text, re-based on its first snapshot", () => {
    for (const next of [{ ...old, computerId: B }, { ...old, computerId: undefined }]) {
      expect(sameComputer(old, next)).toBe(false);
      const r = carryOver(old, next, state());
      expect(r.keepCache).toBe(false);
      expect(r.sync.items).toEqual([]);
      expect(Object.keys(r.sync.pending)).toEqual(["song:/s/a.flp"]);
      expect(r.sync.rebase).toBe(true);
    }
    expect(carryOver(null, old, state()).keepCache).toBe(false);
  });

  it("ideas and memos: not sent again to the same computer, sent again to another one", () => {
    const next = { ...old, deviceId: "dev-new" };
    expect(extrasBinding(`computer:${A}`, next)).toEqual({ bound: `computer:${A}`, reset: false });
    expect(extrasBinding(`computer:${A}`, { ...next, computerId: B })).toEqual({ bound: `computer:${B}`, reset: true });
    // Bound by device id before this version: moves to the computer id, nothing re-sent.
    expect(extrasBinding("dev-old", old)).toEqual({ bound: `computer:${A}`, reset: false });
    // A computer without an id: by device id, as before.
    const legacy = { ...old, computerId: undefined };
    expect(extrasBinding("dev-old", legacy)).toEqual({ bound: "dev-old", reset: false });
    expect(extrasBinding("dev-other", legacy)).toEqual({ bound: "dev-old", reset: true });
    expect(extrasBinding(null, old)).toEqual({ bound: `computer:${A}`, reset: true });
  });
});
