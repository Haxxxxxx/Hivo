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
export type OutState = "waiting" | "sending" | "sent" | "failed";
/** Why an item failed (it stays until the user retries or removes it). */
export type OutError = "too-big" | "type" | "missing-file" | "size";
/** Why sending stopped for now (the item stays waiting, retried at the next sync). */
export type HoldReason = "inbox-full" | "disk-full";

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

/** Items to send now, oldest first (failed ones wait for Retry). */
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
 * Sends one item. Returns the item as it ends: "sent", or "failed" with a
 * reason. Throws a SyncError for what stops the whole sync (offline, off,
 * forgotten, demo, outdated) and a HoldError for "inbox full" / "disk full".
 * `onUpdate` sees each step (progress).
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
  update({});
  const doneBytes = () => item.files.reduce((n, f) => n + (f.done ? f.size : 0), 0);

  for (let index = 0; index < item.files.length; index++) {
    const file = item.files[index];
    if (file.done) continue;
    if (!(await io.exists(file.uri))) return fail("missing-file");
    let restarts = 0;
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
        const r = reason(e);
        if (r === "too big") return fail("too-big");
        if (r === "type") return fail("type");
        if (r === "size") return fail("size");
        throw hold(e);
      }
      offset = Math.min(offset, file.size);
      let restart = false;
      while (offset < file.size) {
        const bytes = await io.read(file.uri, offset, Math.min(MAX_CHUNK_BYTES, file.size - offset));
        if (bytes.length === 0) return fail("missing-file");
        try {
          const r = await withBusyRetry(io, () => io.call("/v1/upload/chunk", { itemId: item.id, fileIndex: index, offset, data: toB64url(bytes) }));
          offset = offsetOf(r) ?? offset + bytes.length;
        } catch (e) {
          const r = reason(e);
          const m = /^offset:(\d+)$/.exec(r);
          if (m) {
            offset = Math.min(Number(m[1]), file.size);
            continue;
          }
          if (r === "unknown upload" && restarts < 2) {
            restarts++;
            restart = true;
            break;
          }
          if (r === "too big") return fail("too-big");
          if (r === "size") return fail("size");
          throw hold(e);
        }
        update({ sentBytes: doneBytes() + offset });
      }
      if (restart) continue;
      try {
        await withBusyRetry(io, () => io.call("/v1/upload/finish", { itemId: item.id, fileIndex: index }));
      } catch (e) {
        const r = reason(e);
        // Fewer bytes than declared (or dropped on the desktop): once more from 0.
        if ((r === "size" || r === "unknown upload") && restarts < 2) {
          restarts++;
          continue;
        }
        if (r === "size") return fail("size");
        throw hold(e);
      }
      break;
    }
    const files = item.files.map((f, i) => (i === index ? { ...f, done: true } : f));
    update({ files, sentBytes: files.reduce((n, f) => n + (f.done ? f.size : 0), 0) });
  }
  update({ state: "sent", status: "stored", sentAt: io.now(), sentBytes: totalBytes(item) });
  return item;
}

function hold(e: unknown): unknown {
  const r = reason(e);
  if (r === "inbox full") return new HoldError("inbox-full");
  if (r === "disk full") return new HoldError("disk-full");
  return e;
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

/** A new pairing: everything still on the phone goes again to the new computer. */
export const resetOut = (items: OutItem[]): OutItem[] =>
  items.filter((i) => i.files.length > 0 && !i.purged).map((i) => ({ ...i, state: "waiting", error: null, sentBytes: 0, status: null, filedTo: null, sentAt: null, files: i.files.map((f) => ({ ...f, done: false })) }));
