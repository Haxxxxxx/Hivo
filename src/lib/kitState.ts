import type { Album, FileEntry, KitFieldId, ProjectInfo, Snippet, SongMeta } from "../types";
import { lastSaveMs } from "./songs";
import { releaseOf } from "./releaseDates";

// What the Launch Kit is built from and what it last exported (review B11,
// W9): the master picked among the renders, and fingerprints that tell when
// "Accepted" or the exported files no longer match the song.

/** Formats distributors take without a re-render. */
export const LOSSLESS = ["wav", "aif", "aiff", "flac"];

const extOf = (path: string) => path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";

export function isLossless(path: string): boolean {
  return LOSSLESS.includes(extOf(path));
}

/** The kit's master: the picked render if it's still there, else the
 * newest lossless one (WAV, AIFF, FLAC), else the newest. An MP3 bounced
 * after the WAV never becomes the master on its own. */
export function pickMaster(renders: FileEntry[], picked?: string | null): FileEntry | undefined {
  if (picked) {
    const hit = renders.find((r) => r.path === picked);
    if (hit) return hit;
  }
  const newest = [...renders].sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  return newest.find((r) => isLossless(r.path)) ?? newest[0];
}

/** The master a song's kit uses (see `pickMaster`). */
export function kitMaster(project: Pick<ProjectInfo, "renders">, meta: SongMeta | undefined): FileEntry | undefined {
  return pickMaster(project.renders, meta?.launchKit?.master);
}

/** Whether the master was rendered after the project's last save. */
export function masterFreshness(project: ProjectInfo, master: FileEntry | undefined): "none" | "fresh" | "stale" {
  if (!master) return "none";
  return master.modifiedAtMs >= lastSaveMs(project) ? "fresh" : "stale";
}

/** FNV-1a, 32-bit, as hex: a short, stable fingerprint (not security). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

const masterKey = (m: FileEntry | undefined) => (m ? `${m.path}|${m.modifiedAtMs}` : "");

/** What "Accept all" vouches for that lives outside the kit's edits (edits
 * clear the acceptance on their own), limited to what the kit exports: the
 * master file, the credits and the release date. Renaming the release or
 * reordering its tracks doesn't undo "Accepted". */
export function acceptFingerprint(project: ProjectInfo, meta: SongMeta | undefined, albums: Album[]): string {
  const release = releaseOf(albums, project.path);
  return hashString(
    JSON.stringify([
      "v2",
      masterKey(kitMaster(project, meta)),
      (meta?.credits ?? []).map((c) => [c.personId, c.role, c.split ?? null]),
      release?.releaseDate ?? null,
    ]),
  );
}

/** The first fingerprint (it also covered the release's id, title, type
 * and track index): kits accepted with it stay accepted while it matches. */
function legacyAcceptFingerprint(project: ProjectInfo, meta: SongMeta | undefined, albums: Album[]): string {
  const release = releaseOf(albums, project.path);
  return hashString(
    JSON.stringify([
      masterKey(kitMaster(project, meta)),
      (meta?.credits ?? []).map((c) => [c.personId, c.role, c.split ?? null]),
      release ? [release.id, release.title, release.kind, release.releaseDate, release.trackPaths.indexOf(project.path)] : null,
    ]),
  );
}

/** "Accepted", unless the master, credits or release date changed since.
 * Kits accepted before the fingerprint existed stay accepted. */
export function isKitAccepted(project: ProjectInfo, meta: SongMeta | undefined, albums: Album[]): boolean {
  const kit = meta?.launchKit;
  if (!kit?.acceptedAtMs) return false;
  const fp = kit.acceptedFingerprint;
  return !fp || fp === acceptFingerprint(project, meta, albums) || fp === legacyAcceptFingerprint(project, meta, albums);
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? null;

/** The kit folder the app recorded for this song: where its last export
 * went, else where its cover was saved. Rust uses it to recognise this
 * song's folder (`kits::resolve_kit_dir`), never as a path. */
export function previousKitFolder(meta: SongMeta | undefined): string | null {
  const kit = meta?.launchKit;
  if (kit?.exported?.folder) return kit.exported.folder;
  const cover = kit?.cover?.savedPath;
  if (!cover) return null;
  const parts = cover.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

/** The folder name to record after an export: the folder Rust wrote to
 * (it may be "Title (2)"), from the path it returned. */
export function exportedFolderName(dir: string, title: string): string {
  return baseName(dir) ?? title;
}

/** Where this song's kit is on disk now: its last export's folder, else
 * the title (never exported). */
export function kitFolderName(meta: SongMeta | undefined, title: string): string {
  return meta?.launchKit?.exported?.folder ?? title;
}

/** What an export wrote: every value, the master file (path + time) and the
 * snippet cuts. Same fingerprint = the files on disk are up to date. */
export function exportFingerprint(values: { id: KitFieldId; value: string }[], master: FileEntry | undefined, snippets: Snippet[]): string {
  return hashString(
    JSON.stringify([
      values.map((f) => [f.id, f.value]),
      masterKey(master),
      snippets.map((s) => [s.label, s.startSec, s.lengthSec]),
    ]),
  );
}

/** Where the last export stands: never exported, up to date, or changed. */
export function exportStatus(meta: SongMeta | undefined, fingerprint: string): "never" | "current" | "changed" {
  const exported = meta?.launchKit?.exported;
  if (!exported) return "never";
  return exported.fingerprint === fingerprint ? "current" : "changed";
}

/** The lyrics language typed most often in the other kits, as a hint for
 * this one (never filled in on its own). */
export function lastLyricsLanguage(songs: Record<string, SongMeta>, path: string): string | null {
  const counts = new Map<string, number>();
  for (const [p, m] of Object.entries(songs)) {
    const lang = m.launchKit?.edits?.language?.trim();
    if (p !== path && lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}
