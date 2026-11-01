// The outbox's files on the phone: `<documents>/outbox/<item id>/<name>`.
// Shared files and recordings are moved here first, so they survive the
// cache being cleared and the app being killed mid-upload.
import { Directory, File, Paths } from "expo-file-system";
import type { OutFile } from "./lib/outbox";

function itemDir(id: string): Directory {
  const d = new Directory(Paths.document, "outbox", id);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

/** Path separators and control characters out; never empty. */
export function safeName(name: string): string {
  const clean = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim().replace(/^\.+/, "").slice(0, 120);
  return clean || "file";
}

/** Thrown when the phone has no room left for the copy. */
export class SpaceError extends Error {
  constructor() {
    super("space");
    this.name = "SpaceError";
  }
}

/** Moves (or copies, when `copy`) a file into the item's folder. */
export async function adopt(id: string, src: { uri: string; name: string }, copy = false): Promise<OutFile> {
  const from = new File(src.uri);
  const dir = itemDir(id);
  let dest = new File(dir, safeName(src.name));
  for (let n = 2; dest.exists; n++) {
    const m = /^(.*?)(\.[^.]*)?$/.exec(safeName(src.name));
    dest = new File(dir, `${m?.[1] ?? "file"} (${n})${m?.[2] ?? ""}`);
  }
  const size = from.size ?? 0;
  if (Paths.availableDiskSpace > 0 && copy && size > Paths.availableDiskSpace) throw new SpaceError();
  try {
    if (copy) await from.copy(dest);
    else await from.move(dest);
  } catch (e) {
    if (/space|ENOSPC/i.test(String(e))) throw new SpaceError();
    throw e;
  }
  const out = new File(dest.uri);
  return { uri: out.uri, name: out.name, size: out.size ?? size, done: false };
}

/**
 * Adopts every file of one item, or none: on any failure the files already
 * moved go back where they were (so the share can be sent again) and the
 * item's folder is removed. No file is ever left without an item.
 */
export async function adoptAll(id: string, srcs: { uri: string; name: string }[], copy = false): Promise<OutFile[]> {
  const done: { from: string; file: OutFile }[] = [];
  try {
    for (const src of srcs) done.push({ from: src.uri, file: await adopt(id, src, copy) });
    return done.map((d) => d.file);
  } catch (e) {
    if (!copy) {
      for (const d of done) {
        try {
          await new File(d.file.uri).move(new File(d.from));
        } catch (err) {
          console.warn("Hivo: could not put a shared file back", err);
        }
      }
    }
    removeItemFiles(id);
    throw e;
  }
}

/** Removes outbox folders no item points to (an app killed between the copy and the save). */
export function sweepOutbox(keep: Set<string>): void {
  try {
    const root = new Directory(Paths.document, "outbox");
    if (!root.exists) return;
    for (const entry of root.list()) {
      if (entry instanceof Directory && !keep.has(entry.name)) entry.delete();
    }
  } catch (e) {
    console.warn("Hivo: could not sweep the outbox folder", e);
  }
}

/** Up to `length` bytes at `offset`. */
export async function readChunk(uri: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = new File(uri).open();
  try {
    handle.offset = offset;
    return await handle.readBytes(length);
  } finally {
    handle.close();
  }
}

export const fileExists = async (uri: string): Promise<boolean> => new File(uri).exists;

/** Deletes an item's folder (sent sketches, removed items). */
export function removeItemFiles(id: string): void {
  try {
    const d = new Directory(Paths.document, "outbox", id);
    if (d.exists) d.delete();
  } catch (e) {
    console.warn("Hivo: could not delete outbox files", e);
  }
}

export type Picked = { uri: string; name: string; size: number | null; mime: string | null };

/** The system file picker, several at once; [] when cancelled. Audio, zips, and MPEG-4 / untyped files (an M4A is often saved as either): Hivo checks each one after. */
export async function pickFiles(): Promise<Picked[]> {
  const r = await File.pickFileAsync({ multipleFiles: true, mimeTypes: ["audio/*", "video/mp4", "application/zip", "application/x-zip-compressed", "application/octet-stream"] });
  if (r.canceled || !r.result) return [];
  return r.result.map((f) => ({ uri: f.uri, name: f.name, size: f.size ?? null, mime: f.type || null }));
}
