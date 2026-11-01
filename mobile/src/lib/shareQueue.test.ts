import { describe, expect, it } from "vitest";
import { filedTitle, parseFiledTo } from "./filedTo";
import { createIdea, pruneIdeas } from "./ideas";
import { dequeue, enqueue, waitingCount } from "./shareQueue";
import type { Item, Kind } from "./sync";

describe("share queue", () => {
  it("keeps every share in order, never one twice", () => {
    let q = enqueue([], { dir: "/c/hivo-share/1", n: 1 });
    q = enqueue(q, { dir: "/c/hivo-share/2", n: 2 });
    // Delivered again (new-intent event, then takeShared): not added twice.
    q = enqueue(q, { dir: "/c/hivo-share/1", n: 1 });
    expect(q.map((s) => s.n)).toEqual([1, 2]);
    const { next, rest } = dequeue(q);
    expect(next?.n).toBe(1);
    expect(rest.map((s) => s.n)).toEqual([2]);
    expect(dequeue([])).toEqual({ next: null, rest: [] });
    // Picked files have no folder: each one is its own share.
    expect(enqueue(enqueue([], { dir: null }), { dir: null })).toHaveLength(2);
  });

  it("counts what waits for a pairing", () => {
    const idea = { ...createIdea("i", 1, { text: "a line" }) };
    const empty = createIdea("e", 1);
    expect(waitingCount([{ state: "waiting" }, { state: "sent" }, { state: "failed" }], [idea, empty])).toBe(2);
  });
});

describe("filedTo", () => {
  const items: Item[] = [{ kind: "song", id: "/music/Night Run/Night Run.flp", title: "Night Run", subtitle: "", bpm: null, key: null, url: null, stage: null, note: "", noteHash: "811c9dc5" }];
  const find = (kind: Kind, id: string) => items.find((i) => i.kind === kind && i.id === id);

  it("says where an idea or a memo was filed", () => {
    expect(parseFiledTo("song:/music/Night Run/Night Run.flp")).toEqual({ kind: "song", id: "/music/Night Run/Night Run.flp" });
    expect(filedTitle("song:/music/Night Run/Night Run.flp", find)).toBe("Night Run");
    // Not in the phone's library (yet): the file's own name.
    expect(filedTitle("beat:/beats/dark loop.wav", find)).toBe("dark loop.wav");
    expect(filedTitle(null, find)).toBeNull();
  });

  it("names the sketch song an export was filed as", () => {
    expect(filedTitle("/music/Night Drive/BandLab", find)).toBe("Night Drive");
    expect(filedTitle("C:\\music\\Night Drive\\BandLab", find)).toBe("Night Drive");
  });
});

describe("pruneIdeas", () => {
  it("lets go of filed or dismissed ideas after the delay, never of one still waiting", () => {
    const keep = 1000;
    const filed = { ...createIdea("f", 0), sentAt: 0, status: "filed" as const };
    const waiting = createIdea("w", 0);
    expect(pruneIdeas([filed, waiting], 5000, keep).map((i) => i.id)).toEqual(["w"]);
    expect(pruneIdeas([filed], 500, keep)).toHaveLength(1);
  });
});
