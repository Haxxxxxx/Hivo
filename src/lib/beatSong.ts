// "Start a song from this beat" (Digger, NOVEMBER-PLAN B3 desktop item 1):
// the pure half. The beat file stays where it is, untouched; what moves is
// what Hivo keeps about it: its note goes to the new song, the phone memos
// linked to it are re-filed into the song's `Voice memos/` (Rust copies the
// audio), and a producer credit is offered.

import type { BeatFile, InboxItem, Person, SavedLead, Workspace } from "../types";
import { matchBeat } from "./digger";
import { MAX_NOTE_CHARS } from "./notes";
import { memosFor } from "./phoneInbox";
import { songNameFromFile } from "./sketch";

/** Upload noise in beat names ("[FREE]", "Type Beat", "140 BPM"…). */
const NOISE = /\b(free|for profit|non profit|download|hq|hd|official|audio|instrumental|type beat|beat|\d{2,3}\s?bpm|20\d\d)\b/gi;

/** A song name from a beat's file name: brackets, the producer tag and
 * upload noise dropped. "[FREE] Night Drive - Dark Trap Type Beat (prod. X)"
 * → "Night Drive Dark Trap". Falls back to the plain file name. */
export function beatSongName(beatName: string): string {
  const cleaned = beatName
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:prod|produced)[^)]*\)/gi, " ")
    .replace(/\b(?:prod|produced)\.?\s+by\b.*$/i, " ")
    .replace(/\bprod\.\s+.*$/i, " ")
    .replace(/[()"“”|~*#@]+/g, " ")
    .replace(/\s[-–—]\s|\s[-–—]|[-–—]\s/g, " ")
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return songNameFromFile(cleaned) || songNameFromFile(beatName) || "";
}

/** The producer written in a beat's name ("(prod. X)", "prod. by X"), or null. */
export function producerInName(beatName: string): string | null {
  const m =
    /\((?:prod(?:uced)?\.?)(?:\s+by)?\s+([^)]+)\)/i.exec(beatName) ??
    /\b(?:prod(?:uced)?\.?)\s+by\s+(.+)$/i.exec(beatName) ??
    /\bprod\.\s+(.+)$/i.exec(beatName);
  const name = m?.[1].replace(/[[\]"“”|]+/g, " ").replace(/\s+/g, " ").trim() ?? "";
  return name && name.length <= 60 ? name : null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The person called `name` (or with that alias), if there is one. */
export function personNamed(people: Person[], name: string): Person | null {
  return people.find((p) => same(p.name, name) || p.aliases.some((a) => same(a, name))) ?? null;
}

/**
 * Who produced this beat, when Hivo can tell: the saved prod that is this
 * beat (its producer), else "(prod. X)" in the file name, else the beat's
 * folder when it's named after someone in People. null otherwise.
 */
export function beatProducer(beat: BeatFile, leads: SavedLead[], leadBeats: Workspace["leadBeats"], people: Person[]): string | null {
  const lead = leads.find((l) => l.producer && matchBeat(l, [beat], leadBeats?.[l.hash]) === beat);
  if (lead?.producer) return lead.producer.trim();
  const inName = producerInName(beat.name);
  if (inName) return inName;
  const folder = beat.folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return folder ? (personNamed(people, folder)?.name ?? null) : null;
}

/**
 * The workspace once the beat became the song at `songPath`: the beat's note
 * appended to the song's notes (and gone from the beat), and, with
 * `producerId`, a Producer credit for that person (once). The beat's file
 * and its other data (lead links, size) stay as they are.
 */
export function moveBeatToSong(ws: Workspace, beatPath: string, songPath: string, producerId: string | null): Workspace {
  const song = ws.songs[songPath] ?? {};
  const note = ws.beatNotes?.[beatPath]?.trim() ? ws.beatNotes[beatPath] : "";
  const songNotes = song.notes?.trim() ? song.notes : "";
  const merged = note ? (songNotes ? `${songNotes.replace(/\s+$/, "")}\n\n${note}` : note) : "";
  // Too long together: the beat keeps its note rather than losing its tail
  // to the cut (review 2026-11-10).
  const moves = !!note && merged.length <= MAX_NOTE_CHARS;
  const notes = moves ? merged : song.notes;
  const credits = song.credits ?? [];
  const credit = producerId && !credits.some((c) => c.personId === producerId && c.role === "Producer") ? [...credits, { personId: producerId, role: "Producer" }] : credits;
  const beatNotes = { ...(ws.beatNotes ?? {}) };
  if (moves) delete beatNotes[beatPath];
  return {
    ...ws,
    beatNotes,
    songs: {
      ...ws.songs,
      [songPath]: { ...song, ...(notes !== undefined ? { notes } : {}), ...(credit.length ? { credits: credit } : {}) },
    },
  };
}

/** The phone memos filed onto this beat: they go to the song's `Voice memos/`. */
export const beatMemos = (items: InboxItem[], beatPath: string): InboxItem[] => memosFor(items, "beat", beatPath);
