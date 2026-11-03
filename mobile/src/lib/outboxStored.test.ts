import { describe, expect, it } from "vitest";
import { SyncError } from "./client";
import { createIdea, dropEmptyIdeas, parseIdea } from "./ideas";
import { HoldError, isDraft, KEEP_SENT_MS, keepDraft, MAX_CHUNK_BYTES, MAX_STUCK_OFFSETS, parseOutItem, pruneOut, resetOut, toSend, uploadItem, type OutItem, type UploadIO } from "./outbox";

const item = (over: Partial<OutItem> = {}): OutItem => ({
  id: "it1",
  type: "sketch",
  title: "Night run",
  target: null,
  createdAt: 1,
  durationMs: null,
  files: [{ uri: "a", name: "a.wav", size: 10, done: false }],
  state: "waiting",
  error: null,
  sentBytes: 0,
  status: null,
  filedTo: null,
  sentAt: null,
  ...over,
});

/** A desktop that takes chunks in order; `chunk` can answer otherwise. */
function desk(size: number, chunk?: (p: { offset: number }, have: number) => unknown) {
  let have = 0;
  let chunkCalls = 0;
  const call = async (path: string, p: any): Promise<unknown> => {
    if (path === "/v1/upload/start") return { offset: have };
    if (path === "/v1/upload/chunk") {
      chunkCalls++;
      const special = chunk?.(p, have);
      if (special instanceof Error) throw special;
      if (p.offset !== have) throw new SyncError("server", `offset:${have}`);
      have += Math.min(MAX_CHUNK_BYTES, size - have);
      return { offset: have };
    }
    if (path === "/v1/upload/finish") return { status: "stored" };
    throw new Error(path);
  };
  const io: UploadIO = { call, read: async (_u, o, l) => new Uint8Array(Math.max(0, Math.min(l, size - o))), exists: async () => true, sleep: async () => {}, now: () => 9 };
  return { io, chunks: () => chunkCalls };
}

describe("stuck offsets (F10)", () => {
  it("a computer that keeps naming the same offset holds the item after a few rounds instead of looping", async () => {
    const d = desk(10, () => new SyncError("server", "offset:0"));
    await expect(uploadItem(d.io, item(), () => {})).rejects.toBeInstanceOf(HoldError);
    expect(d.chunks()).toBe(MAX_STUCK_OFFSETS);
  });

  it("an offset that moves forward resets the count", async () => {
    let n = 0;
    const size = MAX_CHUNK_BYTES * 3;
    // Every other chunk is answered with the offset the desktop really has.
    const d = desk(size, (p, have) => (n++ % 2 === 0 ? new SyncError("server", `offset:${have}`) : null));
    const out = await uploadItem(d.io, item({ files: [{ uri: "a", name: "a.wav", size, done: false }] }), () => {});
    expect(out.state).toBe("sent");
  });
});

describe("drafts (a take not kept yet)", () => {
  it("are never sent, survive a re-pairing as drafts, and become waiting on Keep", () => {
    const d = item({ id: "d1", type: "memo", state: "draft", files: [{ uri: "a", name: "Voice memo.m4a", size: 3, done: false }] });
    expect(toSend([d])).toEqual([]);
    expect(resetOut([d])[0].state).toBe("draft");
    const kept = keepDraft(d, { title: "Hook idea", target: { kind: "beat", id: "b", title: "B" }, fileName: "Hook idea.m4a" });
    expect(kept).toMatchObject({ state: "waiting", title: "Hook idea", target: { id: "b" } });
    expect(kept.files[0].name).toBe("Hook idea.m4a");
    expect(isDraft(d)).toBe(true);
    // Keep on something that isn't a draft changes nothing.
    expect(keepDraft(kept, { title: "x", target: null, fileName: "x.m4a" })).toBe(kept);
  });

  it("are never pruned", () => {
    const d = item({ state: "draft", sentAt: 0 });
    expect(pruneOut([d], KEEP_SENT_MS * 10).keep).toEqual([d]);
  });
});

describe("parseOutItem", () => {
  it("keeps a well-formed item as it is", () => {
    const it1 = item({ text: "link", purged: true, state: "sent", status: "filed", filedTo: "song:x", sentAt: 5 });
    expect(parseOutItem(JSON.parse(JSON.stringify(it1)))).toEqual(it1);
  });

  it("drops what can't be used and repairs what can", () => {
    expect(parseOutItem(null)).toBeNull();
    expect(parseOutItem({ ...item(), id: "../x" })).toBeNull();
    expect(parseOutItem({ ...item(), type: "video" })).toBeNull();
    expect(parseOutItem({ ...item(), files: [{ name: "x" }] })).toBeNull();
    const fixed = parseOutItem({ ...item(), state: "lost", error: "weird", target: { kind: "planet" }, sentBytes: "a" });
    expect(fixed).toMatchObject({ state: "waiting", error: null, target: null, sentBytes: 0 });
    expect(parseOutItem({ ...item(), state: "failed", error: "weird" })?.error).toBe("refused");
  });
});

describe("stored ideas", () => {
  it("parseIdea keeps a good idea and refuses a broken one", () => {
    const i = { ...createIdea("abc", 10, { title: "T", text: "x", target: { kind: "song", id: "s", title: "S" } }), sentAt: 10, status: "stored" as const };
    expect(parseIdea(JSON.parse(JSON.stringify(i)))).toEqual(i);
    expect(parseIdea({ id: 3 })).toBeNull();
    expect(parseIdea("x")).toBeNull();
    expect(parseIdea({ id: "ok", title: 5, target: { kind: "x" }, status: "lost" })).toMatchObject({ title: "", text: "", target: null, status: null, sentAt: null, deleted: false });
  });

  it("dropEmptyIdeas removes the empty ideas a kill left, never a sent or open one", () => {
    const empty = createIdea("e", 1);
    const open = createIdea("o", 1);
    const sentEmpty = { ...createIdea("s", 1), sentAt: 1 };
    const full = createIdea("f", 1, { text: "hook" });
    expect(dropEmptyIdeas([empty, open, sentEmpty, full], "o").map((i) => i.id)).toEqual(["o", "s", "f"]);
  });
});
