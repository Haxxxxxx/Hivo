// Phone sync, the webview's half (docs/PHONE-SYNC.md). Rust decrypts each
// /v1/snapshot and /v1/notes request and forwards it here, because the
// webview is the single writer of workspace.json. These are the pure parts:
// the snapshot (saved prods, beats, visible songs, with their notes) and the
// note merge. The store wiring is src/store/phoneSyncBridge.ts.

import type { BeatFile, ProjectInfo, SavedLead, SongStatus, Workspace } from "../types";
import { fnv1a32 } from "./digger";
import { MAX_NOTE_CHARS } from "./notes";
import { statusInfo } from "./songs";

/** Same as `MAX_CHANGES` in src-tauri/src/phone_sync.rs. */
export const MAX_CHANGES = 500;

export type SyncKind = "prod" | "beat" | "song";

export interface SyncItem {
  kind: SyncKind;
  /** prod: lead hash · beat: file path · song: project path. */
  id: string;
  title: string;
  /** prod: producer · year · beat: folder name · song: stage label. */
  subtitle: string;
  bpm: number | null;
  key: string | null;
  url: string | null;
  stage: SongStatus | null;
  note: string;
  noteHash: string;
}

/** An item that moved to a new id since (docs/PHONE-SYNC.md `renamed`). */
export interface Renamed {
  kind: SyncKind;
  from: string;
  to: string;
}

export interface Snapshot {
  items: SyncItem[];
  generatedAt: number;
  /** Optional (2026-11): ids that changed lately, so a phone re-keys its pending edits. */
  renamed: Renamed[];
}

type PhoneRename = NonNullable<Workspace["phoneRenames"]>[number];

/** How long a rename stays in the snapshot (a phone that syncs within it follows). */
export const RENAMES_KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_RENAMES = 500;

/** The rename list with `moves` added, older than RENAMES_KEEP_MS dropped,
 * chains collapsed (a → b then b → c: a → c too), at most MAX_RENAMES. */
export function addRenames(list: PhoneRename[] | undefined, moves: Renamed[], now: number): PhoneRename[] {
  const kept = (list ?? []).filter((r) => now - r.at <= RENAMES_KEEP_MS).map((r) => ({ ...r }));
  const next: PhoneRename[] = [];
  for (const m of moves) {
    if (m.kind === "prod" || m.from === m.to) continue;
    // Earlier renames that ended where this one starts now end where it ends.
    for (const r of kept) if (r.kind === m.kind && r.to === m.from) r.to = m.to;
    next.push({ kind: m.kind, from: m.from, to: m.to, at: now });
  }
  return [...kept, ...next].filter((r) => r.from !== r.to).slice(-MAX_RENAMES);
}

/** The snapshot's `renamed`: the recent ones, without their time. */
export function recentRenames(list: PhoneRename[] | undefined, now: number): Renamed[] {
  return (list ?? []).filter((r) => now - r.at <= RENAMES_KEEP_MS).map(({ kind, from, to }) => ({ kind, from, to }));
}

export interface NoteChange {
  kind: SyncKind;
  id: string;
  text: string;
  baseHash: string;
}

/** "too long": both sides changed the note and the merge would pass
 * MAX_NOTE_CHARS, so nothing was written; `note` is the desktop's text and
 * the phone keeps its own edit (docs/PHONE-SYNC.md). */
export type NoteStatus = "applied" | "conflict" | "missing" | "too long";

export interface NoteResult {
  kind: SyncKind;
  id: string;
  status: NoteStatus;
  note: string;
  noteHash: string;
}

/** A note to write through the store (setLeadNote / setBeatNote / updateSong). */
export interface NoteWrite {
  kind: SyncKind;
  id: string;
  text: string;
}

export interface SyncSources {
  leads: SavedLead[];
  beats: BeatFile[];
  projects: ProjectInfo[];
  workspace: Workspace;
}

/** fnv1a-32 of the note as stored ("" → 811c9dc5). */
export const noteHash = (note: string): string => fnv1a32(note);

/** What the workspace would hold for this text: capped, blank = "" (as `setNote`). */
export function storedNote(text: string): string {
  const value = text.slice(0, MAX_NOTE_CHARS);
  return value.trim() ? value : "";
}

/** The songs the Library shows by default: not templates, not archived. */
export function visibleSongs(projects: ProjectInfo[], workspace: Workspace): ProjectInfo[] {
  return projects.filter((p) => !p.isTemplate && !workspace.songs[p.path]?.archived);
}

function folderName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function item(kind: SyncKind, id: string, fields: Omit<SyncItem, "kind" | "id" | "note" | "noteHash">, note: string | undefined): SyncItem {
  const text = storedNote(note ?? "");
  return { kind, id, ...fields, note: text, noteHash: noteHash(text) };
}

/** Everything the phone lists: saved prods, beats, then visible songs. */
export function buildSnapshot(src: SyncSources, now: number): Snapshot {
  const ws = src.workspace;
  const items: SyncItem[] = [];
  for (const l of src.leads) {
    items.push(
      item(
        "prod",
        l.hash,
        {
          title: l.title || l.url || l.hash,
          subtitle: [l.producer, l.year].filter(Boolean).join(" · "),
          bpm: l.bpm,
          key: l.key,
          url: l.url || null,
          stage: null,
        },
        ws.leadNotes?.[l.hash],
      ),
    );
  }
  for (const b of src.beats) {
    items.push(item("beat", b.path, { title: b.name, subtitle: folderName(b.folder), bpm: null, key: null, url: null, stage: null }, ws.beatNotes?.[b.path]));
  }
  for (const p of visibleSongs(src.projects, ws)) {
    const meta = ws.songs[p.path] ?? {};
    items.push(
      item(
        "song",
        p.path,
        {
          title: p.name,
          subtitle: statusInfo(meta.status).label,
          bpm: p.tempoBpm == null ? null : Math.round(p.tempoBpm * 100) / 100,
          key: meta.key || null,
          url: null,
          stage: meta.status ?? null,
        },
        meta.notes,
      ),
    );
  }
  return { items, generatedAt: now, renamed: recentRenames(ws.phoneRenames, now) };
}

/** The current note of an item, or null when the desktop doesn't know it. */
export function noteLookup(src: SyncSources): (kind: SyncKind, id: string) => string | null {
  const leads = new Set(src.leads.map((l) => l.hash));
  const beats = new Set(src.beats.map((b) => b.path));
  const songs = new Set(visibleSongs(src.projects, src.workspace).map((p) => p.path));
  const ws = src.workspace;
  return (kind, id) => {
    if (kind === "prod") return leads.has(id) ? storedNote(ws.leadNotes?.[id] ?? "") : null;
    if (kind === "beat") return beats.has(id) ? storedNote(ws.beatNotes?.[id] ?? "") : null;
    return songs.has(id) ? storedNote(ws.songs[id]?.notes ?? "") : null;
  };
}

const KINDS: SyncKind[] = ["prod", "beat", "song"];

/** The changes of a /v1/notes payload, or null when it isn't one. */
export function parseChanges(body: unknown): NoteChange[] | null {
  const raw = (body as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(raw) || raw.length > MAX_CHANGES) return null;
  const out: NoteChange[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") return null;
    const { kind, id, text, baseHash } = c;
    if (!KINDS.includes(kind as SyncKind) || typeof id !== "string" || !id || typeof text !== "string") return null;
    if (text.length > MAX_NOTE_CHARS * 2) return null;
    out.push({ kind: kind as SyncKind, id, text, baseHash: typeof baseHash === "string" ? baseHash : "" });
  }
  return out;
}

/** Why the desktop can't answer a snapshot or a notes push right now, or
 * null. "read only": the workspace is unreadable or from a newer Hivo, so
 * nothing can be saved until the user opens Hivo there (a "busy" would
 * never end); "busy": still loading, or the very first scan running (an
 * empty list would look like every song was deleted). */
export function refusal(s: { demoMode: boolean; workspaceWritable: boolean; hasIssue: boolean; scanning: boolean; projectCount: number }): "demo" | "read only" | "busy" | null {
  if (s.demoMode) return "demo";
  if (!s.workspaceWritable) return s.hasIssue ? "read only" : "busy";
  if (s.scanning && s.projectCount === 0) return "busy";
  return null;
}

/** Above this many line pairs the merge counts lines instead of diffing them (memory). */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Which of the phone's lines (non-blank, by index into `phone`) the
 * desktop's note doesn't hold at that position: a line diff (longest common
 * subsequence, compared trimmed), so a hook repeated on the phone is new
 * even though the desktop has it once. Very long notes fall back to
 * counting: each desktop line covers one phone copy of it.
 */
function newPhoneLines(desk: string[], phone: string[]): Set<number> {
  const a = desk.map((l) => l.trim()).filter(Boolean);
  const idx = phone.map((l, i) => [l.trim(), i] as const).filter(([l]) => l);
  const b = idx.map(([l]) => l);
  // Same start and end: nothing to diff there.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }
  const midA = a.slice(lo, hiA);
  const midB = b.slice(lo, hiB);
  const out = new Set<number>();
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    const left = new Map<string, number>();
    for (const l of midA) left.set(l, (left.get(l) ?? 0) + 1);
    midB.forEach((l, j) => {
      const n = left.get(l) ?? 0;
      if (n > 0) left.set(l, n - 1);
      else out.add(idx[lo + j][1]);
    });
    return out;
  }
  // LCS table, row by row from the end.
  const n = midA.length;
  const m = midB.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && midA[i] === midB[j]) {
      i++;
      j++;
    } else if (i < n && table[i + 1][j] >= table[i][j + 1]) i++;
    else {
      out.add(idx[lo + j][1]);
      j++;
    }
  }
  return out;
}

/**
 * The text kept when the phone and the desktop both changed a note: the
 * desktop's note, then only the phone's lines it doesn't hold at that
 * position (a line diff, so a repeated chorus or `[Hook]` the phone added
 * counts), under a `--- from <phone> ---` marker (the phone's text usually
 * starts from the same note, so appending all of it would double it). Blank
 * lines between kept lines stay, collapsed to one. The desktop's note
 * unchanged when the phone adds nothing new. Never cut: the caller checks
 * the length.
 */
export function mergeConflict(current: string, phoneName: string, text: string): string {
  const phone = text.split("\n");
  const fresh = newPhoneLines(current.split("\n"), phone);
  const kept: string[] = [];
  phone.forEach((line, i) => {
    if (!line.trim()) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
    } else if (fresh.has(i)) kept.push(line);
  });
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  if (kept.length === 0) return current;
  const base = current.replace(/\s+$/, "");
  return base ? `${base}\n\n--- from ${phoneName} ---\n${kept.join("\n")}` : kept.join("\n");
}

/**
 * Applies the phone's note changes, in order. The note becomes `text` when
 * the desktop's current note still hashes to `baseHash`; otherwise both are
 * kept (`mergeConflict`) and the result says "conflict". Two cases count as
 * applied without a merge: the desktop already holds exactly `text` (a retry
 * whose answer was lost), and the desktop's note is empty. Unknown ids are
 * "missing" and nothing is written for them. Nothing is ever cut: a text or
 * a merge longer than MAX_NOTE_CHARS is "too long" and nothing is written
 * (the phone keeps its edit, the desktop its note).
 */
export function applyNoteChanges(
  changes: NoteChange[],
  current: (kind: SyncKind, id: string) => string | null,
  phoneName: string,
): { results: NoteResult[]; writes: NoteWrite[] } {
  const results: NoteResult[] = [];
  const writes: NoteWrite[] = [];
  // Later changes to the same item see the earlier ones.
  const now = new Map<string, string>();
  for (const c of changes) {
    const k = `${c.kind}\u0000${c.id}`;
    const before = now.has(k) ? (now.get(k) as string) : current(c.kind, c.id);
    if (before === null) {
      results.push({ kind: c.kind, id: c.id, status: "missing", note: "", noteHash: noteHash("") });
      continue;
    }
    const clean = noteHash(before) === c.baseHash || before === c.text || before === "";
    const merged = clean ? c.text : mergeConflict(before, phoneName, c.text);
    if (merged.length > MAX_NOTE_CHARS) {
      results.push({ kind: c.kind, id: c.id, status: "too long", note: before, noteHash: noteHash(before) });
      continue;
    }
    const next = storedNote(merged);
    if (next !== before) writes.push({ kind: c.kind, id: c.id, text: next });
    now.set(k, next);
    results.push({ kind: c.kind, id: c.id, status: clean ? "applied" : "conflict", note: next, noteHash: noteHash(next) });
  }
  return { results, writes };
}
