// Voice memos and shared files (BandLab exports) waiting to go to the
// computer (docs/PHONE-SYNC.md v1.1, /v1/upload/*). Files go in chunks; the
// desktop keeps what arrived, so a dropped Wi-Fi resumes where it stopped.
// Pure rules and the upload loop, with the I/O injected (store.ts wires
// expo-file-system and the sync client).

import { toB64url } from "./bytes";
import { SyncError } from "./client";
import type { DesktopStatus, IdeaTarget } from "./ideas";

// Paired with src-tauri/src/phone_inbox.rs.
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_ITEM_FILES = 20;
export const MAX_CHUNK_BYTES = 393_216;
export const MAX_MEMO_MS = 15 * 60 * 1000;
export const MIN_MEMO_MS = 1000;
export const AUDIO_EXTS = ["wav", "mp3", "m4a", "aac", "flac", "ogg", "aif", "aiff"];

export type OutType = "memo" | "sketch";
/** "draft": a take stopped but not kept yet (Keep or Discard on the Record
 * screen). Already in the outbox folder, so a killed app doesn't lose it;
 * never sent until it's kept. */
export type OutState = "draft" | "waiting" | "sending" | "sent" | "failed";
/** Why an item failed (it stays until the user retries or removes it).
 * "refused": the computer turned this one item down ("bad request" or
 * another error after the request opened); the others still go. */
export type OutError = "too-big" | "type" | "missing-file" | "size" | "refused";
/** Why sending stopped for now (the item stays waiting, retried at the next
 * sync). "inbox-full" holds that item and bigger ones; "disk-full" and
 * "desktop-error" (the computer couldn't write: a folder it can't create, a
 * file it can't save) hold all. */
export type HoldReason = "inbox-full" | "disk-full" | "desktop-error";
/** Sent items and filed/dismissed ideas leave the phone after this long. */
export const KEEP_SENT_MS = 30 * 24 * 60 * 60 * 1000;

export type OutFile = {
  /** A file:// uri in the app's documents (copied there when shared or recorded). */
  uri: string;
  name: string;
  size: number;
  done: boolean;
};

export type OutItem = {
  id: string;
  type: OutType;
  title: string;
  /** What was shared with it (BandLab's words and link), ≤ 2000; absent on older items. */
  text?: string;
  target: IdeaTarget | null;
  createdAt: number;
  durationMs: number | null;
  files: OutFile[];
  state: OutState;
  error: OutError | null;
  /** Bytes the computer has (for the progress bar). */
  sentBytes: number;
  /** What the computer did with it, once sent. */
  status: DesktopStatus | null;
  filedTo: string | null;
  sentAt: number | null;
  /** A sent export's files were deleted from the phone (they're on the computer). */
  purged?: boolean;
};

export const extOf = (name: string): string => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
export const isAudio = (name: string): boolean => AUDIO_EXTS.includes(extOf(name));
export const isZip = (name: string): boolean => extOf(name) === "zip";

export function allowed(type: OutType, name: string): boolean {
  return type === "memo" ? isAudio(name) : isAudio(name) || isZip(name);
}

/** File types apps send with a share, and the extension they mean. */
const MIME_EXT: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/x-aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
};

/**
 * The name to keep for a shared file. Apps don't always name it the way
 * the file is: BandLab's M4A can come without an extension, or as ".mp4"
 * (the same MPEG-4 container). The type sent with the share fills the gap.
 */
export function sharedName(name: string, mime: string | null | undefined): string {
  const ext = extOf(name);
  if (AUDIO_EXTS.includes(ext) || ext === "zip") return name;
  const type = (mime ?? "").toLowerCase().split(";")[0].trim();
  // An MPEG-4 file shared as audio, or named .mp4 (audio-only exports): M4A.
  if (ext === "mp4" && (type === "" || type.startsWith("audio/") || type === "video/mp4" || type === "application/octet-stream")) return name.replace(/\.mp4$/i, ".m4a");
  const fromType = MIME_EXT[type];
  if (!fromType) return name;
  // No extension, or one that isn't one (".Night Run v2"): add the right one.
  return `${name}.${fromType}`;
}

export type Refused ={ name: string; reason: "type" | "too-big" | "unreadable" | "space" };

/** Which shared files can go: audio or zip, ≤ 500 MB each, at most 20. */
export function checkShared<F extends { name: string; size: number | null }>(files: F[]): { ok: F[]; refused: Refused[]; dropped: number } {
  const ok: F[] = [];
  const refused: Refused[] = [];
  for (const f of files) {
    if (!allowed("sketch", f.name)) refused.push({ name: f.name, reason: "type" });
    else if (f.size !== null && f.size > MAX_FILE_BYTES) refused.push({ name: f.name, reason: "too-big" });
    else ok.push(f);
  }
  return { ok: ok.slice(0, MAX_ITEM_FILES), refused, dropped: Math.max(0, ok.length - MAX_ITEM_FILES) };
}

export const totalBytes = (i: OutItem): number => i.files.reduce((n, f) => n + f.size, 0);
export const progress = (i: OutItem): number => {
  const total = totalBytes(i);
  return total === 0 ? 0 : Math.min(1, i.sentBytes / total);
};

/** Items to send now, oldest first (failed ones wait for Retry, drafts for Keep). */
export const toSend = (items: OutItem[]): OutItem[] =>
  items.filter((i) => i.state === "waiting" || i.state === "sending").sort((a, b) => a.createdAt - b.createdAt);

export type UploadIO = {
  call: (path: string, payload: unknown) => Promise<unknown>;
  /** Up to `length` bytes at `offset` (fewer at the end of the file). */
  read: (uri: string, offset: number, length: number) => Promise<Uint8Array>;
  exists: (uri: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/** The upload stopped for a reason that holds every item (inbox/disk full). */
export class HoldError extends Error {
  constructor(public reason: HoldReason) {
    super(reason);
    this.name = "HoldError";
  }
}

const offsetOf = (body: unknown): number | null => {
  const o = (body as { offset?: unknown } | null)?.offset;
  return typeof o === "number" && Number.isFinite(o) && o >= 0 ? o : null;
};

/** The desktop's short error, when that's what a SyncError carries. */
const reason = (e: unknown): string => (e instanceof SyncError ? e.message : "");

/**
 * What an error from the computer means for the item being sent:
 * - `fail`: this item can't go as it is (refused, wrong type, too big…);
 *   it shows the reason and the queue goes on with the next one.
 * - `hold`: the computer is full, or couldn't write (an I/O error on its
 *   side); the item waits for the next sync.
 * - `stop`: the computer can't be reached or doesn't take anything right
 *   now (offline, off, busy, forgotten, clock, demo, outdated): the sync stops.
 * Only what's wrong with the item itself (bad request, type, size, too big)
 * fails it: a failed item stays failed until the user retries.
 */
export type Verdict = { fail: OutError } | { hold: HoldReason } | { stop: unknown };

export function verdict(e: unknown): Verdict {
  const r = reason(e);
  if (r === "too big") return { fail: "too-big" };
  if (r === "type") return { fail: "type" };
  if (r === "size") return { fail: "size" };
  // Sealed after the request opened: the computer read it and said no to this one.
  if (r === "bad request") return { fail: "refused" };
  if (r === "inbox full") return { hold: "inbox-full" };
  if (r === "disk full") return { hold: "disk-full" };
  if (e instanceof SyncError) {
    if (e.code === "too-big") return { fail: "too-big" }; // 413: the body itself
    // Any other sealed error ("could not write the file: …"): the computer's
    // trouble, not this item's. Held, tried again at the next sync.
    if (e.code === "server") return { hold: "desktop-error" };
  }
  return { stop: e };
}

/** The finish answer: is the whole item on the computer? (`waiting`: some
 * of its files aren't, e.g. removed there meanwhile.) Older answers without
 * a status count as stored. */
const itemStored = (body: unknown): boolean => (body as { status?: unknown } | null)?.status !== "waiting";

/** An item-level failure, as `uploadItem`'s file loop hands it back. */
class Failed {
  constructor(public item: OutItem) {}
}

/** "offset:n" answers in a row that don't move the upload forward before
 * the item is held. */
export const MAX_STUCK_OFFSETS = 5;

/** How many times an item is sent again from its first file (the computer
 * forgot it: removed there, or dropped after 7 days) before it fails. */
const MAX_ITEM_RESETS = 2;

/**
 * Sends one item. Returns the item as it ends: "sent", or "failed" with a
 * reason. Throws a SyncError for what stops the whole sync (offline, off,
 * forgotten, clock, demo, outdated) and a HoldError for "inbox full" /
 * "disk full". `onUpdate` sees each step (progress).
 */
export async function uploadItem(io: UploadIO, start: OutItem, onUpdate: (i: OutItem) => void): Promise<OutItem> {
  let item: OutItem = { ...start, state: "sending", error: null };
  const update = (patch: Partial<OutItem>) => {
    item = { ...item, ...patch };
    onUpdate(item);
  };
  const fail = (error: OutError) => {
    update({ state: "failed", error });
    return item;
  };
  /** An item-level failure ends the item; anything else is thrown. */
  const settle = (e: unknown): OutItem => {
    const v = verdict(e);
    if ("fail" in v) return fail(v.fail);
    if ("hold" in v) throw new HoldError(v.hold);
    throw v.stop;
  };
  update({});
  const doneBytes = () => item.files.reduce((n, f) => n + (f.done ? f.size : 0), 0);
  /** The computer forgot the item: every file goes again, from the first. */
  const UNKNOWN = Symbol("unknown upload");
  const isUnknown = (e: unknown) => reason(e) === "unknown upload";
  const finish = (index: number) => withBusyRetry(io, () => io.call("/v1/upload/finish", { itemId: item.id, fileIndex: index }));

  /** Sends what isn't done yet; the last finish answer, null when none was
   * needed, or UNKNOWN. Item-level failures come back as an OutItem. */
  const sendFiles = async (): Promise<unknown> => {
    let last: unknown = null;
    for (let index = 0; index < item.files.length; index++) {
      const file = item.files[index];
      if (file.done) continue;
      if (!(await io.exists(file.uri))) return new Failed(fail("missing-file"));
      let restarts = 0;
      /** "offset:n" answers in a row that didn't move the upload forward. */
      let stuck = 0;
      for (;;) {
        // Start (or resume): the desktop says how much it has.
        let offset: number;
        try {
          offset = offsetOf(
            await withBusyRetry(io, () =>
              io.call("/v1/upload/start", {
                itemId: item.id,
                itemType: item.type,
                title: item.title,
                ...(item.text ? { text: item.text } : {}),
                target: item.target,
                createdAt: item.createdAt,
                durationMs: item.durationMs,
                fileIndex: index,
                fileCount: item.files.length,
                name: file.name,
                size: file.size,
              }),
            ),
          ) ?? 0;
        } catch (e) {
          if (isUnknown(e)) return UNKNOWN;
          return new Failed(settle(e));
        }
        offset = Math.min(offset, file.size);
        while (offset < file.size) {
          const bytes = await io.read(file.uri, offset, Math.min(MAX_CHUNK_BYTES, file.size - offset));
          if (bytes.length === 0) return new Failed(fail("missing-file"));
          try {
            const r = await withBusyRetry(io, () => io.call("/v1/upload/chunk", { itemId: item.id, fileIndex: index, offset, data: toB64url(bytes) }));
            offset = offsetOf(r) ?? offset + bytes.length;
          } catch (e) {
            const m = /^offset:(\d+)$/.exec(reason(e));
            if (m) {
              const next = Math.min(Number(m[1]), file.size);
              // The computer keeps naming an offset that doesn't move the
              // upload on: its side is wrong, not this item's. Held, tried
              // again at the next sync (it used to loop for ever).
              stuck = next > offset ? 0 : stuck + 1;
              if (stuck >= MAX_STUCK_OFFSETS) throw new HoldError("desktop-error");
              offset = next;
              continue;
            }
            if (isUnknown(e)) return UNKNOWN;
            return new Failed(settle(e));
          }
          update({ sentBytes: doneBytes() + offset });
        }
        try {
          last = await finish(index);
        } catch (e) {
          if (isUnknown(e)) return UNKNOWN;
          // Fewer bytes than declared: that file once more from 0.
          if (reason(e) === "size" && restarts < 2) {
            restarts++;
            continue;
          }
          return new Failed(settle(e));
        }
        break;
      }
      const files = item.files.map((f, i) => (i === index ? { ...f, done: true } : f));
      update({ files, sentBytes: files.reduce((n, f) => n + (f.done ? f.size : 0), 0) });
    }
    return last;
  };

  for (let resets = 0; ; resets++) {
    let answer = await sendFiles();
    if (answer instanceof Failed) return answer.item;
    // Every file was done before this run (the app stopped before marking it
    // sent): ask the computer whether it still has the whole item.
    if (answer === null && item.files.length > 0) {
      try {
        answer = await finish(item.files.length - 1);
      } catch (e) {
        if (!isUnknown(e)) return settle(e);
        answer = UNKNOWN;
      }
    }
    // Sent and marked "sent" (and later purged) only once the computer says
    // the whole item is there; else every file goes again, from the first.
    if (answer !== UNKNOWN && itemStored(answer)) break;
    if (resets >= MAX_ITEM_RESETS) return fail("refused");
    update({ files: item.files.map((f) => ({ ...f, done: false })), sentBytes: 0 });
  }
  update({ state: "sent", status: "stored", sentAt: io.now(), sentBytes: totalBytes(item) });
  return item;
}

export type QueueHooks = {
  /** The outbox as it is now (items can be removed while one is sending). */
  items: () => OutItem[];
  onStart: (id: string) => void;
  onUpdate: (i: OutItem) => void;
  /** An item ended (sent or failed). */
  onDone: (i: OutItem) => void;
};

/**
 * Sends every waiting item, oldest first. One item never blocks the others:
 * a refused item fails on its own and the loop goes on. "inbox full" holds
 * that item and every item at least as big (smaller ones may still fit);
 * "disk full" holds everything. Returns why something is held, or null.
 * Throws what stops the sync (offline, forgotten…).
 */
export async function sendQueue(io: UploadIO, hooks: QueueHooks): Promise<HoldReason | null> {
  let held: HoldReason | null = null;
  /** Bytes left of the smallest item the full inbox refused. */
  let fullAt = Infinity;
  for (const queued of toSend(hooks.items())) {
    const cur = hooks.items().find((i) => i.id === queued.id);
    if (!cur || (cur.state !== "waiting" && cur.state !== "sending")) continue;
    const left = totalBytes(cur) - cur.sentBytes;
    if (left >= fullAt) continue;
    hooks.onStart(cur.id);
    try {
      hooks.onDone(await uploadItem(io, cur, hooks.onUpdate));
    } catch (e) {
      if (!(e instanceof HoldError)) throw e;
      const now = hooks.items().find((i) => i.id === cur.id);
      if (now) hooks.onUpdate({ ...now, state: "waiting" });
      if (e.reason !== "inbox-full") return e.reason;
      held = "inbox-full";
      fullAt = Math.min(fullAt, left);
    }
  }
  return held;
}

/** 429/503 or "busy" (a scan running): wait a little and try again, a few times. */
async function withBusyRetry<T>(io: UploadIO, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SyncError && e.code === "busy" && attempt < 5) {
        await io.sleep(1500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

/** Statuses from /v1/inbox, by item id. */
export function parseInboxStatuses(body: unknown): Map<string, { status: string; filedTo: string | null }> {
  const out = new Map<string, { status: string; filedTo: string | null }>();
  const list = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return out;
  for (const r of list as Record<string, unknown>[]) {
    if (r && typeof r.id === "string" && typeof r.status === "string") out.set(r.id, { status: r.status, filedTo: typeof r.filedTo === "string" ? r.filedTo : null });
  }
  return out;
}

/** Sent items get the desktop's later status (filed, dismissed). */
export function applyOutStatuses(items: OutItem[], statuses: Map<string, { status: string; filedTo: string | null }>): OutItem[] {
  return items.map((i) => {
    const s = statuses.get(i.id);
    if (!s || i.state !== "sent") return i;
    const status: DesktopStatus = s.status === "filed" ? "filed" : s.status === "dismissed" ? "dismissed" : "stored";
    return status === i.status && s.filedTo === i.filedTo ? i : { ...i, status, filedTo: s.filedTo };
  });
}

/** Retry after a failure: from where the desktop is (it resumes). */
export const retry = (i: OutItem): OutItem => ({ ...i, state: "waiting", error: null });

/** A new pairing: everything still on the phone goes again to the new computer (a draft stays a draft). */
export const resetOut = (items: OutItem[]): OutItem[] =>
  items
    .filter((i) => i.files.length > 0 && !i.purged)
    .map((i) => ({ ...i, state: i.state === "draft" ? "draft" : "waiting", error: null, sentBytes: 0, status: null, filedTo: null, sentAt: null, files: i.files.map((f) => ({ ...f, done: false })) }));

export const isDraft = (i: OutItem): boolean => i.state === "draft";

/** Keep on a draft take: named (the file's name follows: `fileName`), aimed, and queued. */
export function keepDraft(item: OutItem, init: { title: string; target: IdeaTarget | null; fileName: string }): OutItem {
  if (item.state !== "draft") return item;
  return { ...item, title: init.title.slice(0, 200), target: init.target, state: "waiting", files: item.files.map((f, i) => (i === 0 ? { ...f, name: init.fileName } : f)) };
}

const OUT_STATES: OutState[] = ["draft", "waiting", "sending", "sent", "failed"];
const OUT_ERRORS: OutError[] = ["too-big", "type", "missing-file", "size", "refused"];
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A target read back from storage; null when malformed. */
export function parseTarget(v: unknown): IdeaTarget | null {
  const t = v as Partial<IdeaTarget> | null;
  if (!t || typeof t !== "object") return null;
  if ((t.kind !== "prod" && t.kind !== "beat" && t.kind !== "song") || typeof t.id !== "string" || !t.id) return null;
  return { kind: t.kind, id: t.id, title: typeof t.title === "string" ? t.title : t.id };
}

/** One stored outbox item, checked field by field; null when it can't be
 * used (no id, no type, a file without a path). Never throws. */
export function parseOutItem(raw: unknown): OutItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) return null;
  if (r.type !== "memo" && r.type !== "sketch") return null;
  if (!Array.isArray(r.files)) return null;
  const files: OutFile[] = [];
  for (const f of r.files as Record<string, unknown>[]) {
    if (!f || typeof f !== "object" || typeof f.uri !== "string" || !f.uri || typeof f.name !== "string") return null;
    files.push({ uri: f.uri, name: f.name, size: Math.max(0, num(f.size, 0)), done: f.done === true });
  }
  const state = OUT_STATES.includes(r.state as OutState) ? (r.state as OutState) : "waiting";
  const status = r.status === "stored" || r.status === "filed" || r.status === "dismissed" ? r.status : null;
  return {
    id: r.id,
    type: r.type,
    title: typeof r.title === "string" ? r.title.slice(0, 200) : "",
    ...(typeof r.text === "string" && r.text ? { text: r.text.slice(0, 2000) } : {}),
    target: parseTarget(r.target),
    createdAt: num(r.createdAt, 0),
    durationMs: numOrNull(r.durationMs),
    files,
    state,
    error: state === "failed" ? (OUT_ERRORS.includes(r.error as OutError) ? (r.error as OutError) : "refused") : null,
    sentBytes: Math.max(0, num(r.sentBytes, 0)),
    status,
    filedTo: typeof r.filedTo === "string" ? r.filedTo : null,
    sentAt: numOrNull(r.sentAt),
    ...(r.purged === true ? { purged: true } : {}),
  };
}

/** Sent memos and exports older than KEEP_SENT_MS leave the phone (they're on the computer). */
export function pruneOut(items: OutItem[], now: number): { keep: OutItem[]; removed: string[] } {
  const old = (i: OutItem) => i.state === "sent" && i.sentAt !== null && now - i.sentAt > KEEP_SENT_MS;
  return { keep: items.filter((i) => !old(i)), removed: items.filter(old).map((i) => i.id) };
}
