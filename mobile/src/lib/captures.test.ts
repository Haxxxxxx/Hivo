import { describe, expect, it } from "vitest";
import { captureRows, duration, isLoopbackLink, lowerFirst, needsYou, remaining, savedSince, syncTone, waitingOnPhone, when, type Conn } from "./captures";
import { createIdea, type Idea } from "./ideas";
import type { OutItem } from "./outbox";

const conn: Conn = { paired: true, error: null, held: null, sending: null };

const idea = (id: string, at: number, patch: Partial<Idea> = {}): Idea => ({ ...createIdea(id, at, { text: "a line" }), ...patch });
const out = (id: string, at: number, patch: Partial<OutItem> = {}): OutItem => ({
  id,
  type: "memo",
  title: "",
  target: null,
  createdAt: at,
  durationMs: 42_000,
  files: [{ uri: "file:///x.m4a", name: "x.m4a", size: 10, done: false }],
  state: "waiting",
  error: null,
  sentBytes: 0,
  status: null,
  filedTo: null,
  sentAt: null,
  ...patch,
});

describe("captureRows", () => {
  it("groups failed → waiting → on the computer, newest first", () => {
    const groups = captureRows(
      [idea("i1", 10), idea("i2", 30, { sentAt: 30 }), idea("empty", 40, { text: "" }), idea("del", 50, { deleted: true })],
      [out("o1", 20, { state: "failed", error: "type" }), out("o2", 25), out("o3", 5, { state: "sent", status: "filed", filedTo: "song:s" })],
      conn,
    );
    expect(groups.map((g) => [g.group, g.rows.map((r) => r.id)])).toEqual([
      ["needs", ["o1"]],
      ["waiting", ["o2", "i1"]],
      ["done", ["i2", "o3"]],
    ]);
  });

  it("says why something waits", () => {
    const reason = (c: Conn) => {
      const st = captureRows([idea("i", 1)], [], c)[0].rows[0].status;
      return st.kind === "waiting" ? st.reason : st.kind;
    };
    expect(reason({ ...conn, paired: false })).toBe("unpaired");
    expect(reason({ ...conn, error: "offline" })).toBe("away");
    expect(reason({ ...conn, error: "forgotten" })).toBe("blocked");
    expect(reason({ ...conn, held: "inbox-full" })).toBe("held");
    expect(reason(conn)).toBe("next-sync");
  });

  it("shows the upload's progress, and an old pairing's receipts as old", () => {
    const [w] = captureRows([], [out("o", 1)], { ...conn, sending: { id: "o", progress: 0.456 } });
    expect(w.rows[0].status).toEqual({ kind: "sending", pct: 46 });
    const [d] = captureRows([], [out("o", 1, { state: "sent" })], { ...conn, paired: false });
    expect(d.rows[0].status).toEqual({ kind: "received", old: true });
  });
});

describe("counts", () => {
  it("the badge counts only failures", () => {
    expect(needsYou([out("a", 1), out("b", 1, { state: "failed" }), out("c", 1, { state: "sent" })])).toBe(1);
  });
  it("counts what still waits on the phone", () => {
    expect(waitingOnPhone([idea("a", 1), idea("b", 1, { sentAt: 1 }), idea("c", 1, { text: "" })], [out("o", 1), out("p", 1, { state: "sent" })])).toBe(2);
  });
});

describe("duration", () => {
  it("rounds once, so 1:59.6 is 2:00 and never 1:00", () => {
    expect(duration(119_600)).toBe("2:00");
    expect(duration(119_400)).toBe("1:59");
    expect(duration(42_000)).toBe("0:42");
    expect(duration(0)).toBe("0:00");
  });
});

describe("when", () => {
  const now = new Date(2026, 10, 3, 22, 0).getTime();
  it("today, yesterday, then the date", () => {
    expect(when(new Date(2026, 10, 3, 21, 14).getTime(), now, "en")).toBe("today 21:14");
    expect(when(new Date(2026, 10, 2, 8, 2).getTime(), now, "fr")).toBe("hier 08:02");
    expect(when(new Date(2026, 9, 28, 9, 5).getTime(), now, "en")).toBe("28 Oct 09:05");
    expect(when(new Date(2025, 0, 1, 0, 0).getTime(), now, "fr")).toBe("1 janv. 2025 00:00");
  });
});

describe("savedSince", () => {
  it("finds the memo or export kept on a record or share screen", () => {
    expect(savedSince({ name: "record" }, [], [out("o", 100)], 50)).toBe("memo");
    expect(savedSince({ name: "share" }, [], [out("o", 100, { type: "sketch" })], 50)).toBe("export");
    expect(savedSince({ name: "record" }, [], [out("o", 10)], 50)).toBeNull();
  });
  it("an idea counts only when written or edited during the visit", () => {
    expect(savedSince({ name: "idea", id: "i" }, [idea("i", 100)], [], 50)).toBe("idea");
    expect(savedSince({ name: "idea", id: "i" }, [idea("i", 10)], [], 50)).toBeNull();
    expect(savedSince({ name: "idea", id: "i" }, [idea("i", 100, { text: "" })], [], 50)).toBeNull();
  });
});

describe("syncTone", () => {
  const s = { paired: true, error: null, waiting: 0, lastSyncAt: 1 };
  it("away is neutral, faults are red", () => {
    expect(syncTone({ ...s, error: "offline" })).toBe("away");
    expect(syncTone({ ...s, error: "off" })).toBe("away");
    expect(syncTone({ ...s, error: "forgotten" })).toBe("fault");
    expect(syncTone({ ...s, error: "outdated" })).toBe("fault");
    expect(syncTone({ ...s, error: "busy" })).toBe("warn");
    expect(syncTone(s)).toBe("ok");
    expect(syncTone({ ...s, waiting: 2 })).toBe("warn");
    expect(syncTone({ ...s, paired: false })).toBe("idle");
  });
});

describe("text helpers", () => {
  it("lowers the first letter after a colon, not a name", () => {
    expect(lowerFirst("Pas sur le même Wi-Fi")).toBe("pas sur le même Wi-Fi");
    expect(lowerFirst("Hivo sur l'ordi")).toBe("Hivo sur l'ordi");
  });
  it("spots a pairing link that only points at the phone itself", () => {
    expect(isLoopbackLink("hivo://pair?v=2&d=x&h=127.0.0.1&p=1")).toBe(true);
    expect(isLoopbackLink("hivo://pair?v=2&d=x&h=127.0.0.1,127.0.0.2&p=1")).toBe(true);
    expect(isLoopbackLink("hivo://pair?v=2&d=x&h=192.168.1.2&p=1")).toBe(false);
    expect(isLoopbackLink("https://x?h=127.0.0.1")).toBe(false);
  });
  it("counts the code's minutes down", () => {
    expect(remaining(0, 61_500, 300_000)).toBe("3:58");
    expect(remaining(0, 400_000, 300_000)).toBe("0:00");
  });
});
