// Personal tendencies for the Me dashboard's optional blocks (Tempo & key,
// Working hours, Your sound, Collaborators, Song shape). Everything here is
// read from this computer's projects and workspace: never crew-wide, never
// release stats (docs/GUARDRAILS.md, rules 3 and 6). Pure, so the blocks
// only draw.

import type { ProjectInfo, SongMeta, SongStatus, Workspace } from "../types";
import { STATUSES, isFinished, lastSaveMs, saveTimestamps } from "./songs";

const DAY = 24 * 60 * 60 * 1000;
/** "Last 12 months" for the time-bound reads. */
const YEAR = 365 * DAY;

/** Timestamps that mean something (0 = unknown, see lastSaveMs). */
const realSaves = (p: ProjectInfo) => saveTimestamps(p).filter((t) => Number.isFinite(t) && t > 0);

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const metaOf = (ws: Workspace, p: ProjectInfo): SongMeta | undefined => ws.songs[p.path];

/** Blocks read from file dates (save, backup and render times), which a
 * copy, a sync or FL pruning old backups changes: the UI labels them
 * "approximate". */
export const FILE_DATE_BLOCKS = ["workingHours", "songShape"] as const;
export const isFromFileDates = (id: string): boolean => (FILE_DATE_BLOCKS as readonly string[]).includes(id);

// ---- 1. Tempo & key ----

export const BPM_BIN = 10;
/** FL's tempo range, the clamp flp_metadata.rs and crewSync.ts use. A corrupt
 * tempo from another DAW's file (REAPER, Ableton) is skipped, not binned:
 * one 99999999 BPM song would otherwise make millions of empty bins. */
const BPM_MIN = 10;
const BPM_MAX = 522;

export interface BpmBin {
  /** Inclusive lower edge ("140" for 140–149.9). */
  from: number;
  count: number;
}

export interface TempoKeyTendencies {
  /** Every 10-BPM bin from the lowest used to the highest, empty ones included. */
  bins: BpmBin[];
  /** Songs with a tempo. */
  withBpm: number;
  /** Top 5 keys by songs. */
  keys: { key: string; count: number }[];
  /** The modal bin (lowest one on a tie); null without tempos. */
  typicalBin: BpmBin | null;
  /** The modal key; null without keys. */
  typicalKey: string | null;
}

export function tempoKeyTendencies(songs: ProjectInfo[], ws: Workspace): TempoKeyTendencies {
  const counts = new Map<number, number>();
  for (const p of songs) {
    if (p.tempoBpm == null || !Number.isFinite(p.tempoBpm) || p.tempoBpm < BPM_MIN || p.tempoBpm > BPM_MAX) continue;
    const from = Math.floor(p.tempoBpm / BPM_BIN) * BPM_BIN;
    counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  const bins: BpmBin[] = [];
  if (counts.size) {
    const edges = [...counts.keys()];
    const lo = Math.min(...edges);
    const hi = Math.max(...edges);
    for (let from = lo; from <= hi; from += BPM_BIN) bins.push({ from, count: counts.get(from) ?? 0 });
  }
  const typicalBin = bins.reduce<BpmBin | null>((best, b) => (b.count > (best?.count ?? 0) ? b : best), null);

  const keyCounts = new Map<string, number>();
  for (const p of songs) {
    const key = metaOf(ws, p)?.key?.trim();
    if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const keys = [...keyCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 5);

  return {
    bins,
    withBpm: [...counts.values()].reduce((t, n) => t + n, 0),
    keys,
    typicalBin,
    typicalKey: keys[0]?.key ?? null,
  };
}

/** "Am" → "A minor", "F#" → "F# major", for the headline. */
export function keyName(key: string, minor: string, major: string): string {
  return key.endsWith("m") ? `${key.slice(0, -1)} ${minor}` : `${key} ${major}`;
}

// ---- 2. Working hours ----

/** Hours in the window the summary names ("22:00–02:00"). */
export const HOUR_WINDOW = 4;
export type Chronotype = "nightOwl" | "earlyBird" | "officeHours";

export interface WorkingHours {
  /** [weekday 0 = Monday … 6 = Sunday][hour 0–23] saves, last 12 months. */
  grid: number[][];
  total: number;
  max: number;
  /** The three weekdays with the most saves (Monday = 0), most first. */
  topWeekdays: number[];
  /** Start hour of the HOUR_WINDOW-hour window (wrapping midnight) holding the most saves. */
  peakHour: number;
  chronotype: Chronotype | null;
}

/** Early bird 05–11, office hours 11–18, night owl 18–05: the bucket with the most saves. */
function chronotypeOf(byHour: number[]): Chronotype | null {
  const sum = (from: number, to: number) => byHour.slice(from, to).reduce((t, n) => t + n, 0);
  const early = sum(5, 11);
  const office = sum(11, 18);
  const night = sum(18, 24) + sum(0, 5);
  if (early + office + night === 0) return null;
  if (night >= early && night >= office) return "nightOwl";
  if (early >= office) return "earlyBird";
  return "officeHours";
}

export function workingHours(songs: ProjectInfo[], now = Date.now()): WorkingHours {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const since = now - YEAR;
  let total = 0;
  for (const p of songs) {
    for (const t of realSaves(p)) {
      if (t < since || t > now) continue;
      const d = new Date(t);
      grid[(d.getDay() + 6) % 7][d.getHours()] += 1;
      total += 1;
    }
  }
  const byDay = grid.map((row) => row.reduce((t, n) => t + n, 0));
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((t, row) => t + row[h], 0));
  const topWeekdays = byDay
    .map((n, day) => ({ n, day }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.day - b.day)
    .slice(0, 3)
    .map((x) => x.day);
  let peakHour = 0;
  let peak = -1;
  for (let h = 0; h < 24; h++) {
    let n = 0;
    for (let k = 0; k < HOUR_WINDOW; k++) n += byHour[(h + k) % 24];
    if (n > peak) {
      peak = n;
      peakHour = h;
    }
  }
  return { grid, total, max: Math.max(0, ...grid.flat()), topWeekdays, peakHour, chronotype: chronotypeOf(byHour) };
}

/** The top weekdays as a run ("Tue–Thu") when they're consecutive, else a list ("Tue, Thu, Sat"). */
export function weekdayRun(days: number[]): { from: number; to: number } | null {
  if (days.length < 2) return null;
  const s = [...days].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1] + 1) return null;
  return { from: s[0], to: s[s.length - 1] };
}

// ---- 3. Your sound ----

export interface Counted {
  name: string;
  /** Distinct songs, not instances. */
  songs: number;
}

export interface SoundShift {
  name: string;
  kind: "plugin" | "folder";
  songs: number;
}

export interface YourSound {
  /** Top 8 plugins by the songs they appear in. */
  plugins: Counted[];
  /** Top 5 sample folders (parent folder names, never a path). */
  folders: Counted[];
  /** In at least half of the last RECENT_SONGS saved songs. */
  regulars: SoundShift[];
  /** In 3+ songs overall but in none of the last RECENT_SONGS. */
  dropped: SoundShift[];
  /** How many recent songs the shifts are read from. */
  recentCount: number;
}

export const RECENT_SONGS = 10;
const DROPPED_MIN_SONGS = 3;

/** The folder a sample sits in, by name only: "Kicks" for ".../Drums/Kicks/kick 01.wav".
 * Null when the parent is a drive root ("C:"), the filesystem root or a home
 * directory name (fewer than 3 segments): those say nothing about the sound. */
export function sampleFolder(path: string): string | null {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length < 3) return null;
  const parent = parts[parts.length - 2];
  return /^[A-Za-z]:$/.test(parent) ? null : parent;
}

function distinctPer(songs: ProjectInfo[], items: (p: ProjectInfo) => Iterable<string>): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  for (const p of songs) {
    for (const name of new Set(items(p))) {
      const set = by.get(name) ?? new Set<string>();
      set.add(p.path);
      by.set(name, set);
    }
  }
  return by;
}

const ranked = (by: Map<string, Set<string>>, n: number): Counted[] =>
  [...by.entries()]
    .map(([name, set]) => ({ name, songs: set.size }))
    .sort((a, b) => b.songs - a.songs || a.name.localeCompare(b.name))
    .slice(0, n);

const pluginNames = (p: ProjectInfo) => p.plugins.map((x) => x.name.trim()).filter(Boolean);
const folderNames = (p: ProjectInfo) => p.samples.map((s) => sampleFolder(s.path)).filter((f): f is string => !!f);

export function yourSound(songs: ProjectInfo[]): YourSound {
  const plugins = distinctPer(songs, pluginNames);
  const folders = distinctPer(songs, folderNames);
  const recent = [...songs]
    .filter((p) => lastSaveMs(p) > 0)
    .sort((a, b) => lastSaveMs(b) - lastSaveMs(a))
    .slice(0, RECENT_SONGS);
  const recentPaths = new Set(recent.map((p) => p.path));
  const regulars: SoundShift[] = [];
  const dropped: SoundShift[] = [];
  const shifts = (by: Map<string, Set<string>>, kind: SoundShift["kind"]) => {
    for (const [name, set] of by) {
      const inRecent = [...set].filter((path) => recentPaths.has(path)).length;
      if (recent.length && inRecent * 2 >= recent.length) regulars.push({ name, kind, songs: inRecent });
      else if (inRecent === 0 && set.size >= DROPPED_MIN_SONGS) dropped.push({ name, kind, songs: set.size });
    }
  };
  shifts(plugins, "plugin");
  shifts(folders, "folder");
  const order = (a: SoundShift, b: SoundShift) => b.songs - a.songs || a.name.localeCompare(b.name);
  return {
    plugins: ranked(plugins, 8),
    folders: ranked(folders, 5),
    regulars: regulars.sort(order),
    dropped: dropped.sort(order),
    recentCount: recent.length,
  };
}

// ---- 4. Collaborators ----

export const RECENT_COLLAB_DAYS = 90;
export const NOT_LATELY_DAYS = 180;

export interface Collaborator {
  id: string;
  name: string;
  songs: number;
  /** Their most common credited role, "" when the credits name none. */
  role: string;
  /** Latest save of a song they're credited on; 0 = unknown. */
  lastWorkedMs: number;
}

export interface Collaborators {
  /** Everyone credited, most songs first. */
  top: Collaborator[];
  /** Worked with in the last RECENT_COLLAB_DAYS days. */
  recent: Collaborator[];
  /** Not in the last NOT_LATELY_DAYS days. */
  notLately: Collaborator[];
  hasCredits: boolean;
}

export function collaborators(songs: ProjectInfo[], ws: Workspace, now = Date.now()): Collaborators {
  const names = new Map(ws.people.map((p) => [p.id, p.name]));
  const by = new Map<string, { songs: Set<string>; roles: Map<string, number>; lastWorkedMs: number }>();
  let hasCredits = false;
  for (const p of songs) {
    const credits = metaOf(ws, p)?.credits ?? [];
    if (credits.length) hasCredits = true;
    const saved = lastSaveMs(p);
    for (const c of credits) {
      if (!names.has(c.personId)) continue;
      const e = by.get(c.personId) ?? { songs: new Set<string>(), roles: new Map<string, number>(), lastWorkedMs: 0 };
      e.songs.add(p.path);
      const role = c.role.trim();
      if (role) e.roles.set(role, (e.roles.get(role) ?? 0) + 1);
      e.lastWorkedMs = Math.max(e.lastWorkedMs, saved);
      by.set(c.personId, e);
    }
  }
  const top = [...by.entries()]
    .map(([id, e]) => ({
      id,
      name: names.get(id) ?? "",
      songs: e.songs.size,
      role: [...e.roles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "",
      lastWorkedMs: e.lastWorkedMs,
    }))
    .sort((a, b) => b.songs - a.songs || a.name.localeCompare(b.name));
  const byLast = [...top].sort((a, b) => b.lastWorkedMs - a.lastWorkedMs);
  return {
    top,
    recent: byLast.filter((c) => c.lastWorkedMs >= now - RECENT_COLLAB_DAYS * DAY),
    notLately: byLast.filter((c) => c.lastWorkedMs < now - NOT_LATELY_DAYS * DAY).reverse(),
    hasCredits,
  };
}

// ---- 5. Song shape ----

export interface MonthStarts {
  /** First day of the month, local time. */
  month: Date;
  started: number;
  /** Of those, the ones that are finished now (Prep or later). */
  finished: number;
}

/** Median days a song stays in one stage, from the stage log. */
export interface StageDays {
  stage: SongStatus;
  medianDays: number;
  /** Songs with at least one finished stay in this stage. */
  songs: number;
}

/** Days spent in each stage, from every song's stage log (`SongMeta.stageLog`):
 * a stay runs from entering a stage to entering the next one, so the stage a
 * song is in now isn't counted yet. Pipeline order; stages without a
 * finished stay are left out. Empty until songs have moved through the log. */
export function stageDays(songs: ProjectInfo[], ws: Workspace): StageDays[] {
  const by = new Map<SongStatus, number[]>();
  for (const p of songs) {
    const log = metaOf(ws, p)?.stageLog ?? [];
    for (let i = 0; i + 1 < log.length; i++) {
      const span = log[i + 1].atMs - log[i].atMs;
      if (!Number.isFinite(span) || span < 0) continue;
      const list = by.get(log[i].stage) ?? [];
      list.push(span / DAY);
      by.set(log[i].stage, list);
    }
  }
  return STATUSES.map((st) => st.id).filter((st) => by.has(st)).map((stage) => ({
    stage,
    medianDays: Math.round(median(by.get(stage)!)!),
    songs: by.get(stage)!.length,
  }));
}

export interface SongShape {
  /** Versions = backups + the project itself. */
  medianVersions: number | null;
  /** First save → first mixdown, over the songs that have one. */
  medianDaysToMixdown: number | null;
  /** Days in each stage from the stage log; empty without log data. */
  stageDays: StageDays[];
  /** What the timing line reads: the stage log when it has data (exact,
   * kept by Hivo), else file dates (approximate). */
  timingSource: "stageLog" | "fileDates";
  withMixdown: number;
  total: number;
  /** Songs started per month (first save), the last 12 months ending this one. */
  starts: MonthStarts[];
}

export const START_MONTHS = 12;

/** The song's first known save; 0 when unknown. */
export function firstSaveMs(p: ProjectInfo): number {
  const saves = realSaves(p);
  return saves.length ? Math.min(...saves) : 0;
}

export function songShape(songs: ProjectInfo[], ws: Workspace, now = Date.now()): SongShape {
  const versions = songs.map((p) => (p.backups?.length ?? 0) + 1);
  const toMixdown: number[] = [];
  let withMixdown = 0;
  for (const p of songs) {
    const renders = (p.renders ?? []).map((r) => r.modifiedAtMs).filter((t) => Number.isFinite(t) && t > 0);
    if (!renders.length) continue;
    withMixdown += 1;
    const first = firstSaveMs(p);
    if (first > 0) toMixdown.push(Math.max(0, (Math.min(...renders) - first) / DAY));
  }
  const end = new Date(now);
  const months: MonthStarts[] = Array.from({ length: START_MONTHS }, (_, i) => ({
    month: new Date(end.getFullYear(), end.getMonth() - (START_MONTHS - 1) + i, 1),
    started: 0,
    finished: 0,
  }));
  const index = (d: Date) => (d.getFullYear() - months[0].month.getFullYear()) * 12 + d.getMonth() - months[0].month.getMonth();
  for (const p of songs) {
    const first = firstSaveMs(p);
    if (!first) continue;
    const i = index(new Date(first));
    if (i < 0 || i >= START_MONTHS) continue;
    months[i].started += 1;
    if (isFinished(metaOf(ws, p)?.status)) months[i].finished += 1;
  }
  const medianDays = median(toMixdown);
  const stages = stageDays(songs, ws);
  return {
    medianVersions: median(versions),
    medianDaysToMixdown: medianDays === null ? null : Math.round(medianDays),
    stageDays: stages,
    timingSource: stages.length ? "stageLog" : "fileDates",
    withMixdown,
    total: songs.length,
    starts: months,
  };
}
