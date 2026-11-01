// The phone inbox, the webview's pure half (docs/PHONE-SYNC.md v1.1). Rust
// holds the items and their files (src-tauri/src/phone_inbox.rs); this
// decides what the Inbox page shows and what filing an idea writes.

import type { BeatFile, InboxItem, InboxTarget, ProjectInfo, SavedLead, Workspace } from "../types";
import { MAX_NOTE_CHARS } from "./notes";
import { visibleSongs } from "./phoneSync";
import { songNameFromFile } from "./sketch";

export type InboxFilter = "new" | "filed" | "all";

/** Newest first, filtered; dismissed items only under "all". */
export function filterInbox(items: InboxItem[], filter: InboxFilter): InboxItem[] {
  const keep = (i: InboxItem) => (filter === "all" ? true : filter === "new" ? i.status === "new" : i.status === "filed");
  return items.filter(keep).sort((a, b) => (b.receivedAt ?? b.createdAt) - (a.receivedAt ?? a.createdAt));
}

export const newCount = (items: InboxItem[]): number => items.filter((i) => i.status === "new").length;

/** The block an idea adds to a note. */
export function ideaBlock(item: Pick<InboxItem, "title" | "text" | "phoneName">): string {
  const body = [item.title.trim(), item.text.trim()].filter(Boolean).join("\n");
  return `--- idea from ${item.phoneName || "Phone"} ---\n${body}`;
}

export type AppendResult = { ok: true; text: string } | { ok: false; reason: "empty" | "full" };

/** The note with the idea appended (a blank line between), or why not. */
export function appendIdea(note: string, item: Pick<InboxItem, "title" | "text" | "phoneName">): AppendResult {
  if (!item.title.trim() && !item.text.trim()) return { ok: false, reason: "empty" };
  const block = ideaBlock(item);
  const text = note.trim() ? `${note.replace(/\s+$/, "")}\n\n${block}` : block;
  return text.length > MAX_NOTE_CHARS ? { ok: false, reason: "full" } : { ok: true, text };
}

/** `<kind>:<id>`: what `filedTo` holds for an idea or a memo linked to a beat/prod/song. */
export const targetKey = (t: Pick<InboxTarget, "kind" | "id">): string => `${t.kind}:${t.id}`;

export function parseTargetKey(key: string | null): Pick<InboxTarget, "kind" | "id"> | null {
  const m = key ? /^(prod|beat|song):(.+)$/s.exec(key) : null;
  return m ? { kind: m[1] as InboxTarget["kind"], id: m[2] } : null;
}

export interface TargetOption extends InboxTarget {
  /** What the picker shows under the title. */
  detail: string;
}

/** Everything an idea or a memo can go to: songs, beats, saved prods. */
export function targetOptions(projects: ProjectInfo[], workspace: Workspace, beats: BeatFile[], leads: SavedLead[]): TargetOption[] {
  return [
    ...visibleSongs(projects, workspace).map((p): TargetOption => ({ kind: "song", id: p.path, title: p.name, detail: "" })),
    ...beats.map((b): TargetOption => ({ kind: "beat", id: b.path, title: b.name, detail: "" })),
    ...leads.map((l): TargetOption => ({ kind: "prod", id: l.hash, title: l.title || l.url, detail: l.producer ?? "" })),
  ];
}

/** The phone's target when the desktop still knows it. */
export function knownTarget(item: InboxItem, options: TargetOption[]): TargetOption | null {
  const t = item.target;
  return t ? (options.find((o) => o.kind === t.kind && o.id === t.id) ?? null) : null;
}

/** A file name that's a provider's id, not a name ("msf_1000032969.m4a",
 * "1000032969.m4a", a UUID): older phones sent BandLab exports like that.
 * Same rule as the phone's `isOpaqueName` (mobile/src/lib/shareMeta.ts). */
export function isOpaqueName(name: string): boolean {
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  if (!stem) return true;
  if (/^(msf|document|media|audio|primary|raw|image|video|content|file|shared)[\s:_-]*\d+$/i.test(stem)) return true;
  if (/^\d{3,}$/.test(stem)) return true;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(stem)) return true;
  return /^shared(-\d+)?$/i.test(stem);
}

/** A song name for a sketch: its title (without links or "on BandLab"),
 * else a name from the first real file ("Night_Run (Mixdown).mp3" →
 * "Night Run"), else "BandLab sketch" / "Sketch". Never a link or an id. */
export function sketchName(item: InboxItem): string {
  const fromTitle = item.title
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\s*(?:[-–|:•]\s*|\b(?:on|sur|via)\s+)bandlab\s*[.!:]*\s*$/i, "")
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = isOpaqueName(fromTitle) ? "" : fromTitle;
  const file = item.files.find((f) => !isOpaqueName(f.name));
  const fromFile = file ? songNameFromFile(file.name) : "";
  const fallback = bandlabLink(item) ? "BandLab sketch" : "Sketch";
  return (title || fromFile || fallback).slice(0, 80).trim() || fallback;
}

/** A BandLab link in the item's text, if one was shared with it. */
export function bandlabLink(item: InboxItem): string | null {
  const m = /https:\/\/(?:www\.)?bandlab\.com\/[^\s"'<>]+/i.exec(`${item.title} ${item.text}`);
  return m ? m[0] : null;
}

const sep = (p: string) => (p.includes("\\") && !p.includes("/") ? "\\" : "/");

/** The folder a song's files sit in: the project's folder, or, for a sketch
 * (keyed by its BandLab folder), the song folder above it. */
export function songFolder(songKey: string): string {
  return songKey.replace(/[\\/][^\\/]*$/, "");
}

/** Memos copied into this song's `Voice memos` folder (what the drawer lists). */
export function memosForSong(items: InboxItem[], songKey: string): InboxItem[] {
  const folder = songFolder(songKey);
  const prefix = `${folder}${sep(folder)}Voice memos${sep(folder)}`;
  return items.filter((i) => i.status === "filed" && i.itemType !== "idea" && (i.filedTo ?? "").startsWith(prefix));
}

/** Memos linked to a beat or a prod (the Digger's notes panel lists them). */
export function memosFor(items: InboxItem[], kind: "beat" | "prod", id: string): InboxItem[] {
  const key = targetKey({ kind, id });
  return items.filter((i) => i.status === "filed" && i.itemType === "memo" && i.filedTo === key);
}

/** Where "Show in folder" goes for a filed item: a sketch's BandLab folder,
 * a memo's copy (in a song's folder or a beats folder's `_memos`); null for
 * an idea (it's in a note) or anything not filed. */
export function filedPath(item: InboxItem): string | null {
  if (item.status !== "filed" || item.itemType === "idea") return null;
  if (item.copiedTo) return item.copiedTo;
  return item.filedTo && !parseTargetKey(item.filedTo) ? item.filedTo : null;
}

/** What "Remove" loses: "only" when the inbox holds the only copy (not
 * filed yet, or a memo linked before links were copied), "kept" when what
 * was filed stays where it went. */
export function removeLoses(item: InboxItem): "only" | "kept" {
  if (item.status !== "filed") return "only";
  if (item.itemType === "memo" && parseTargetKey(item.filedTo) && !item.copiedTo) return "only";
  return "kept";
}

/** "File elsewhere" (back to new, what was filed stays) makes sense for an
 * idea or a memo; a sketch filed as a song became that song. */
export const canFileElsewhere = (item: InboxItem): boolean => item.status === "filed" && (item.itemType === "idea" || item.itemType === "memo");

/** "2:05" from milliseconds. */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
