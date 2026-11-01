import { describe, expect, it } from "vitest";
import { fromB64url } from "./bytes";
import { SyncError } from "./client";
import {
  applyOutStatuses,
  checkShared,
  HoldError,
  MAX_CHUNK_BYTES,
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
      return { status: "stored" };
    }
    throw new Error(path);
  };
  return { parts, knobs, call, starts };
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
