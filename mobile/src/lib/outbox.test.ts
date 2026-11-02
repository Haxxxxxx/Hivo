import { describe, expect, it } from "vitest";
import { fromB64url } from "./bytes";
import { SyncError } from "./client";
import {
  applyOutStatuses,
  checkShared,
  HoldError,
  KEEP_SENT_MS,
  MAX_CHUNK_BYTES,
  pruneOut,
  sendQueue,
  verdict,
  MAX_FILE_BYTES,
  MAX_ITEM_FILES,
  parseInboxStatuses,
  progress,
  resetOut,
  retry,
  sharedName,
  toSend,
  uploadItem,
  type OutItem,
  type UploadIO,
} from "./outbox";

/** A desktop that behaves like phone_inbox.rs, with switches to break it. */
function fakeDesktop() {
  const parts = new Map<string, Uint8Array>();
  const sizes = new Map<string, number>();
  const done = new Set<string>();
  const starts: Record<string, unknown>[] = [];
  const counts = new Map<string, number>();
  const knobs = { dropAfterChunks: -1, chunks: 0, loseReplyOnce: false, refuse: "" as string, busyOnce: false, forgetOnce: false };
  const err = (m: string) => new SyncError("server", m);
  const call = async (path: string, p: any): Promise<unknown> => {
    if (knobs.busyOnce) {
      knobs.busyOnce = false;
      throw new SyncError("busy");
    }
    if (knobs.refuse) throw err(knobs.refuse);
    const k = `${p.itemId}/${p.fileIndex}`;
    if (path === "/v1/upload/start") {
      starts.push(p);
      // A later file of an item it doesn't know: the phone must start over.
      if (!counts.has(p.itemId) && p.fileIndex > 0) throw err("unknown upload");
      counts.set(p.itemId, p.fileCount);
      if (sizes.get(k) !== p.size) {
        sizes.set(k, p.size);
        parts.set(k, new Uint8Array());
        done.delete(k);
      }
      return { offset: done.has(k) ? p.size : parts.get(k)!.length };
    }
    if (path === "/v1/upload/chunk") {
      if (knobs.forgetOnce) {
        knobs.forgetOnce = false;
        parts.delete(k);
        sizes.delete(k);
        throw err("unknown upload");
      }
      if (!parts.has(k)) throw err("unknown upload");
      const cur = parts.get(k)!;
      if (p.offset !== cur.length) throw err(`offset:${cur.length}`);
      const bytes = fromB64url(p.data)!;
      expect(bytes.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      const next = new Uint8Array(cur.length + bytes.length);
      next.set(cur);
      next.set(bytes, cur.length);
      parts.set(k, next);
      knobs.chunks++;
      if (knobs.chunks === knobs.dropAfterChunks) throw new SyncError("offline");
      if (knobs.loseReplyOnce) {
        knobs.loseReplyOnce = false;
        throw new SyncError("offline");
      }
      return { offset: next.length };
    }
    if (path === "/v1/upload/finish") {
      if (!parts.has(k)) throw err("unknown upload");
      if (parts.get(k)!.length !== sizes.get(k)) {
        parts.set(k, new Uint8Array());
        throw err("size");
      }
      done.add(k);
      const count = counts.get(p.itemId) ?? 0;
      const all = Array.from({ length: count }, (_, i) => done.has(`${p.itemId}/${i}`)).every(Boolean);
      return { status: all ? "stored" : "waiting" };
    }
    throw new Error(path);
  };
  /** "Remove" on the desktop while the item is still arriving. */
  const remove = (itemId: string) => {
    counts.delete(itemId);
    for (const k of [...parts.keys()]) if (k.startsWith(`${itemId}/`)) parts.delete(k);
    for (const k of [...sizes.keys()]) if (k.startsWith(`${itemId}/`)) sizes.delete(k);
    for (const k of [...done]) if (k.startsWith(`${itemId}/`)) done.delete(k);
  };
  return { parts, knobs, call, starts, remove, done };
}

const fileOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

function io(desk: ReturnType<typeof fakeDesktop>, files: Record<string, Uint8Array>): UploadIO {
  return {
    call: desk.call,
    read: async (uri, offset, length) => files[uri].slice(offset, offset + length),
    exists: async (uri) => uri in files,
    sleep: async () => {},
    now: () => 99,
  };
}

const item = (over: Partial<OutItem> = {}): OutItem => ({
  id: "it1",
  type: "sketch",
  title: "Night run",
  target: null,
  createdAt: 1,
  durationMs: null,
  files: [
    { uri: "a", name: "mix.mp3", size: MAX_CHUNK_BYTES * 2 + 10, done: false },
    { uri: "b", name: "stems.zip", size: 5, done: false },
  ],
  state: "waiting",
  error: null,
  sentBytes: 0,
  status: null,
  filedTo: null,
  sentAt: null,
  ...over,
});

describe("uploadItem", () => {
  const data = { a: fileOf(MAX_CHUNK_BYTES * 2 + 10), b: fileOf(5) };

  it("sends every file in chunks", async () => {
    const desk = fakeDesktop();
    const seen: number[] = [];
    const out = await uploadItem(io(desk, data), item(), (i) => seen.push(progress(i)));
    expect(out.state).toBe("sent");
    expect(out.status).toBe("stored");
    expect(desk.parts.get("it1/0")).toEqual(data.a);
    expect(desk.parts.get("it1/1")).toEqual(data.b);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("sends the shared text (BandLab's link) with the start, and nothing when there's none", async () => {
    const desk = fakeDesktop();
    await uploadItem(io(desk, data), item({ text: "Night Run https://www.bandlab.com/post/abc" }), () => {});
    expect(desk.starts[0]).toMatchObject({ title: "Night run", text: "Night Run https://www.bandlab.com/post/abc" });
    const plain = fakeDesktop();
    await uploadItem(io(plain, data), item(), () => {});
    expect(plain.starts[0]).not.toHaveProperty("text");
  });

  it("resumes after the Wi-Fi drops, and survives a lost reply", async () => {
    const desk = fakeDesktop();
    desk.knobs.dropAfterChunks = 2;
    let last = item();
    await expect(uploadItem(io(desk, data), item(), (i) => (last = i))).rejects.toMatchObject({ code: "offline" });
    expect(last.sentBytes).toBe(MAX_CHUNK_BYTES);
    // Next sync: start says how much the desktop has; a lost reply on the way.
    desk.knobs.loseReplyOnce = true;
    await expect(uploadItem(io(desk, data), last, () => {})).rejects.toMatchObject({ code: "offline" });
    const out = await uploadItem(io(desk, data), last, () => {});
    expect(out.state).toBe("sent");
    expect(desk.parts.get("it1/0")).toEqual(data.a);
  });

  it("waits out a busy desktop and restarts a file it forgot", async () => {
    const desk = fakeDesktop();
    desk.knobs.busyOnce = true;
    desk.knobs.forgetOnce = true;
    const out = await uploadItem(io(desk, data), item(), () => {});
    expect(out.state).toBe("sent");
    expect(desk.parts.get("it1/0")).toEqual(data.a);
  });

  it("sends every file again from the first when the computer removed the half-arrived item", async () => {
    const desk = fakeDesktop();
    const three = { ...data, c: fileOf(7) };
    const it3 = item({ files: [...item().files, { uri: "c", name: "vox.wav", size: 7, done: false }] });
    // The first two arrive, then the Wi-Fi drops.
    desk.knobs.dropAfterChunks = 5;
    let last = it3;
    await expect(uploadItem(io(desk, three), it3, (i) => (last = i))).rejects.toMatchObject({ code: "offline" });
    expect(last.files.map((f) => f.done)).toEqual([true, true, false]);
    // Removed on the desktop meanwhile.
    desk.remove("it1");
    const out = await uploadItem(io(desk, three), last, () => {});
    expect(out.state).toBe("sent");
    expect(out.files.every((f) => f.done)).toBe(true);
    for (const [i, uri] of ["a", "b", "c"].entries()) expect(desk.parts.get(`it1/${i}`)).toEqual(three[uri as "a" | "b" | "c"]);
    expect(desk.done.size).toBe(3);
  });

  it("checks with the computer before marking an item sent whose files were all done", async () => {
    const desk = fakeDesktop();
    const allDone = item({ files: item().files.map((f) => ({ ...f, done: true })), state: "sending" });
    // The computer never got it whole (removed there): every file again.
    const out = await uploadItem(io(desk, data), allDone, () => {});
    expect(out.state).toBe("sent");
    expect(desk.parts.get("it1/0")).toEqual(data.a);
    expect(desk.parts.get("it1/1")).toEqual(data.b);
  });

  it("never marks an item sent while the computer says it's still waiting for files", async () => {
    const desk = fakeDesktop();
    // A computer that keeps answering "waiting": gives up as refused, never "sent".
    const call = desk.call;
    const io2 = { ...io(desk, data), call: async (path: string, p: unknown) => (path === "/v1/upload/finish" ? (await call(path, p), { status: "waiting" }) : call(path, p)) };
    const out = await uploadItem(io2, item(), () => {});
    expect(out.state).toBe("failed");
    expect(out.error).toBe("refused");
  });

  it("holds (never fails) an item when the computer couldn't write it", async () => {
    const desk = fakeDesktop();
    desk.knobs.refuse = "could not write the file: permission denied";
    await expect(uploadItem(io(desk, data), item(), () => {})).rejects.toMatchObject({ reason: "desktop-error" });
  });

  it("fails what can't go and holds when the computer is full", async () => {
    const desk = fakeDesktop();
    desk.knobs.refuse = "type";
    expect((await uploadItem(io(desk, data), item(), () => {})).error).toBe("type");
    desk.knobs.refuse = "too big";
    expect((await uploadItem(io(desk, data), item(), () => {})).error).toBe("too-big");
    desk.knobs.refuse = "inbox full";
    await expect(uploadItem(io(desk, data), item(), () => {})).rejects.toBeInstanceOf(HoldError);
    desk.knobs.refuse = "disk full";
    await expect(uploadItem(io(desk, data), item(), () => {})).rejects.toMatchObject({ reason: "disk-full" });
    desk.knobs.refuse = "";
    // The file was removed from the phone.
    expect((await uploadItem(io(desk, { b: data.b }), item(), () => {})).error).toBe("missing-file");
  });
});

describe("verdict (what an error does to the item)", () => {
  it("fails the item for what the computer refused, holds for full, stops for the rest", () => {
    const sealed = (m: string, code: "server" | "outdated" = "server") => new SyncError(code, m);
    expect(verdict(sealed("bad request", "outdated"))).toEqual({ fail: "refused" });
    expect(verdict(sealed("type"))).toEqual({ fail: "type" });
    expect(verdict(sealed("too big"))).toEqual({ fail: "too-big" });
    expect(verdict(sealed("size"))).toEqual({ fail: "size" });
    // The computer's own trouble (an I/O error): held, tried again next sync.
    expect(verdict(sealed("could not write the file: permission denied"))).toEqual({ hold: "desktop-error" });
    expect(verdict(new SyncError("too-big", "HTTP 413"))).toEqual({ fail: "too-big" });
    expect(verdict(sealed("inbox full"))).toEqual({ hold: "inbox-full" });
    expect(verdict(sealed("disk full"))).toEqual({ hold: "disk-full" });
    for (const code of ["offline", "off", "busy", "forgotten", "clock", "demo"] as const) {
      const e = new SyncError(code);
      expect(verdict(e)).toEqual({ stop: e });
    }
    expect(verdict(new SyncError("outdated", "HTTP 404"))).toMatchObject({ stop: expect.any(SyncError) });
  });
});

describe("sendQueue", () => {
  /** A desktop that refuses some items by id, else behaves. */
  function picky(rules: Record<string, string>) {
    const desk = fakeDesktop();
    const call = async (path: string, p: any) => {
      const rule = rules[p.itemId];
      if (rule && path === "/v1/upload/start") throw rule === "offline" ? new SyncError("offline") : new SyncError(rule === "bad request" ? "outdated" : "server", rule);
      return desk.call(path, p);
    };
    return { desk, call };
  }
  const small = (id: string, createdAt: number, size: number): OutItem => item({ id, createdAt, files: [{ uri: `f-${id}`, name: "a.wav", size, done: false }] });
  function run(list: OutItem[], call: UploadIO["call"]) {
    let items = list;
    const files = Object.fromEntries(list.map((i) => [i.files[0].uri, fileOf(i.files[0].size)]));
    const started: string[] = [];
    const io: UploadIO = { call, read: async (uri, o, l) => files[uri].slice(o, o + l), exists: async (uri) => uri in files, sleep: async () => {}, now: () => 99 };
    const put = (i: OutItem) => (items = items.map((x) => (x.id === i.id ? i : x)));
    const done = sendQueue(io, { items: () => items, onStart: (id) => started.push(id), onUpdate: put, onDone: put });
    return { done, get: () => items, started };
  }

  it("one refused item fails on its own with a reason; the others still go", async () => {
    const { call } = picky({ a: "bad request", b: "type" });
    const r = run([small("a", 1, 10), small("b", 2, 10), small("c", 3, 10)], call);
    expect(await r.done).toBeNull();
    const by = Object.fromEntries(r.get().map((i) => [i.id, i]));
    expect(by.a).toMatchObject({ state: "failed", error: "refused" });
    expect(by.b).toMatchObject({ state: "failed", error: "type" });
    expect(by.c).toMatchObject({ state: "sent" });
  });

  it("a full inbox holds that item and bigger ones; smaller ones still go", async () => {
    const { call } = picky({ big: "inbox full" });
    const r = run([small("big", 1, 1000), small("bigger", 2, 2000), small("tiny", 3, 10)], call);
    expect(await r.done).toBe("inbox-full");
    const by = Object.fromEntries(r.get().map((i) => [i.id, i]));
    expect(by.big.state).toBe("waiting");
    expect(by.bigger.state).toBe("waiting");
    expect(r.started).not.toContain("bigger");
    expect(by.tiny.state).toBe("sent");
  });

  it("a full disk holds everything", async () => {
    const { call } = picky({ a: "disk full" });
    const r = run([small("a", 1, 10), small("b", 2, 10)], call);
    expect(await r.done).toBe("disk-full");
    expect(r.get().map((i) => i.state)).toEqual(["waiting", "waiting"]);
  });

  it("offline stops the queue (the sync reports it)", async () => {
    const { call } = picky({ a: "offline" });
    const r = run([small("a", 1, 10), small("b", 2, 10)], call);
    await expect(r.done).rejects.toMatchObject({ code: "offline" });
    expect(r.get().find((i) => i.id === "b")?.state).toBe("waiting");
  });
});

describe("pruning", () => {
  it("drops sent items after 30 days, keeps the rest", () => {
    const now = KEEP_SENT_MS * 3;
    const list = [item({ id: "old", state: "sent", sentAt: now - KEEP_SENT_MS - 1 }), item({ id: "new", state: "sent", sentAt: now - 1000 }), item({ id: "wait" })];
    const r = pruneOut(list, now);
    expect(r.removed).toEqual(["old"]);
    expect(r.keep.map((i) => i.id)).toEqual(["new", "wait"]);
  });
});

describe("sharedName", () => {
  it("keeps names that already say what they are", () => {
    expect(sharedName("Night Run.m4a", "audio/mp4")).toBe("Night Run.m4a");
    expect(sharedName("stems.ZIP", null)).toBe("stems.ZIP");
  });
  it("names an M4A that came without its extension, or as .mp4", () => {
    expect(sharedName("Night Run", "audio/mp4")).toBe("Night Run.m4a");
    expect(sharedName("Night Run", "audio/x-m4a")).toBe("Night Run.m4a");
    expect(sharedName("shared-1", "audio/mpeg; charset=binary")).toBe("shared-1.mp3");
    expect(sharedName("Night Run v1.2", "audio/mp4")).toBe("Night Run v1.2.m4a");
    expect(sharedName("Night Run.mp4", "audio/mp4")).toBe("Night Run.m4a");
    expect(sharedName("Night Run.mp4", "video/mp4")).toBe("Night Run.m4a");
    expect(sharedName("Night Run.mp4", null)).toBe("Night Run.m4a");
  });
  it("leaves what it can't tell, so it's refused with its type", () => {
    expect(sharedName("notes.txt", "text/plain")).toBe("notes.txt");
    expect(sharedName("clip.3gp", "audio/3gpp")).toBe("clip.3gp");
    expect(sharedName("mystery", null)).toBe("mystery");
  });
  it("lets the fixed names through the share check", () => {
    const files = [{ name: "Night Run", size: 10, mime: "audio/mp4" }].map((f) => ({ ...f, name: sharedName(f.name, f.mime) }));
    expect(checkShared(files).ok.map((f) => f.name)).toEqual(["Night Run.m4a"]);
  });
});

describe("outbox rules", () => {
  it("checks what was shared", () => {
    const r = checkShared([
      { name: "mix.MP3", size: 10 },
      { name: "stems.zip", size: null },
      { name: "video.mp4", size: 10 },
      { name: "huge.wav", size: MAX_FILE_BYTES + 1 },
    ]);
    expect(r.ok.map((f) => f.name)).toEqual(["mix.MP3", "stems.zip"]);
    expect(r.refused).toEqual([
      { name: "video.mp4", reason: "type" },
      { name: "huge.wav", reason: "too-big" },
    ]);
    const many = Array.from({ length: MAX_ITEM_FILES + 3 }, (_, i) => ({ name: `${i}.wav`, size: 1 }));
    expect(checkShared(many)).toMatchObject({ dropped: 3 });
    expect(checkShared(many).ok.length).toBe(MAX_ITEM_FILES);
  });

  it("orders, retries, statuses and re-pairing", () => {
    const list = [item({ id: "b", createdAt: 2 }), item({ id: "a", createdAt: 1 }), item({ id: "f", state: "failed", error: "type" }), item({ id: "s", state: "sent", status: "stored" })];
    expect(toSend(list).map((i) => i.id)).toEqual(["a", "b"]);
    expect(retry(list[2])).toMatchObject({ state: "waiting", error: null });
    const st = parseInboxStatuses({ items: [{ id: "s", type: "sketch", status: "filed", filedTo: "/x/BandLab" }, { bad: 1 }] });
    expect(applyOutStatuses(list, st)[3]).toMatchObject({ status: "filed", filedTo: "/x/BandLab" });
    expect(resetOut([list[3]])[0]).toMatchObject({ state: "waiting", status: null, sentBytes: 0 });
  });
});
