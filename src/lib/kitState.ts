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

/** The master as "Accept all" saw it: its file name and time, not its
 * folder, so a song whose folder moved (a relink, a re-pointed linked
 * folder) stays accepted. */
const acceptedMasterKey = (m: FileEntry | undefined) => (m ? `${m.path.split(/[\\/]/).pop()}|${m.modifiedAtMs}` : "");

function fingerprintOf(project: ProjectInfo, meta: SongMeta | undefined, albums: Album[], key: (m: FileEntry | undefined) => string): string {
  const release = releaseOf(albums, project.path);
  return hashString(
    JSON.stringify([
      key(kitMaster(project, meta)),
      (meta?.credits ?? []).map((c) => [c.personId, c.role, c.split ?? null]),
      release ? [release.id, release.title, release.kind, release.releaseDate, release.trackPaths.indexOf(project.path)] : null,
    ]),
  );
}

/** What "Accept all" vouches for that lives outside the kit's edits (edits
 * clear the acceptance on their own): the master file, the credits and the
 * release the song is on (with its date). */
export function acceptFingerprint(project: ProjectInfo, meta: SongMeta | undefined, albums: Album[]): string {
  return fingerprintOf(project, meta, albums, acceptedMasterKey);
}

/** "Accepted", unless the master, credits or release changed since. Kits
 * accepted before the fingerprint existed stay accepted, and so do kits
 * accepted with the older full-path fingerprint. */
export function isKitAccepted(project: ProjectInfo, meta: SongMeta | undefined, albums: Album[]): boolean {
  const kit = meta?.launchKit;
  if (!kit?.acceptedAtMs) return false;
  if (!kit.acceptedFingerprint || kit.acceptedFingerprint === acceptFingerprint(project, meta, albums)) return true;
  return kit.acceptedFingerprint === fingerprintOf(project, meta, albums, masterKey);
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
