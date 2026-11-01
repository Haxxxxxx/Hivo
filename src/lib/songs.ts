import type { Album, ProjectInfo, RenderFreshness, SongStatus, Workspace } from "../types";
import { dict, tr } from "../i18n";

// The song lifecycle from docs/ROADMAP.md: every track is in exactly one
// stage. Stages are ordinal, so they share one blue stepped dark → light
// (System 02's stage ramp, lit as LEDs on the #161614 panel).
// Songs nobody has triaged yet sit in neutral gray, outside the ramp.
// Names and hints follow the app's language (getters, read when shown).
const STAGE_TEXT = dict(
  {
    creation: "Creation",
    creationHint: "Beat and lyrics exist, still rough",
    production: "Production",
    productionHint: "Recording, mixing, mastering until final",
    prep: "Prep",
    prepHint: "Cover, metadata, release date, distributor",
    release: "Release",
    releaseHint: "Release day",
    promotion: "Promotion",
    promotionHint: "Posts, reels, stories, follow-up",
    unsorted: "Unsorted",
    unsortedHint: "Not placed in a stage yet",
  },
  {
    creation: "Création",
    creationHint: "La prod et les textes existent, encore brut",
    production: "Production",
    productionHint: "Enregistrement, mix, master jusqu'à la version finale",
    prep: "Prépa",
    prepHint: "Cover, métadonnées, date de sortie, distributeur",
    release: "Sortie",
    releaseHint: "Le jour de la sortie",
    promotion: "Promo",
    promotionHint: "Posts, reels, stories, relances",
    unsorted: "Non classé",
    unsortedHint: "Pas encore placé dans une étape",
  },
);

type StageId = SongStatus | "unsorted";

/** A stage's default name in every language (a column still named that way
 * shows in the current language). */
export function stageNames(id: SongStatus | null): string[] {
  const key: StageId = id ?? "unsorted";
  return [STAGE_TEXT.en[key], STAGE_TEXT.fr[key]];
}
/** A stage whose label and hint are read in the current language. Getters,
 * so spread a stage only where it's shown (a spread copies today's words). */
function stage<T extends object>(base: T, id: StageId): T & { label: string; hint: string } {
  return Object.defineProperties(base, {
    label: { enumerable: true, get: () => tr(STAGE_TEXT)[id] },
    hint: { enumerable: true, get: () => tr(STAGE_TEXT)[`${id}Hint` as keyof (typeof STAGE_TEXT)["en"]] },
  }) as T & { label: string; hint: string };
}

export const STATUSES: { id: SongStatus; label: string; color: string; hint: string }[] = [
  stage({ id: "creation" as const, color: "#1C5CAB" }, "creation"),
  stage({ id: "production" as const, color: "#2A78D6" }, "production"),
  stage({ id: "prep" as const, color: "#5598E7" }, "prep"),
  stage({ id: "release" as const, color: "#86B6EF" }, "release"),
  stage({ id: "promotion" as const, color: "#B7D3F6" }, "promotion"),
];
export const UNSORTED: { label: string; color: string; hint: string } = stage({ color: "#5B5B63" }, "unsorted");

export function statusInfo(status: SongStatus | undefined) {
  return STATUSES.find((s) => s.id === status) ?? { id: undefined, ...UNSORTED };
}

/** The music itself is final: Prep, Release or Promotion. */
export function isFinished(status: SongStatus | undefined): boolean {
  return status === "prep" || status === "release" || status === "promotion";
}

/** For "closest to release first" ordering: Promotion 0 … Creation 4, unsorted 5. */
export function stageRank(status: SongStatus | undefined): number {
  const i = STATUSES.findIndex((s) => s.id === status);
  return i < 0 ? STATUSES.length : STATUSES.length - 1 - i;
}

/** The app's first stages (version 1) → the roadmap lifecycle (version 2). */
const LEGACY_STAGES: Record<string, SongStatus> = {
  idea: "creation",
  wip: "creation",
  mixing: "production",
  mastering: "production",
  done: "prep",
};

/** Upgrades a stored workspace to the current version. Each migrated song
 * keeps its old stage in `legacyStatus`, so nothing is lost. */
export function migrateWorkspace(stored: Workspace | { version?: number }): { workspace: Workspace; changed: boolean } {
  const ws = { ...EMPTY_WORKSPACE, ...(stored as Workspace) };
  if (ws.version === 2) return { workspace: ws, changed: false };
  // Saved by a newer Hivo: shown as it is, never re-stamped (the store opens
  // it read-only, see newerWorkspaceVersion).
  if (newerWorkspaceVersion(stored) !== null) return { workspace: ws, changed: false };
  const songs: Workspace["songs"] = {};
  for (const [path, meta] of Object.entries(ws.songs ?? {})) {
    const old = meta.status as string | undefined;
    songs[path] = old && LEGACY_STAGES[old] ? { ...meta, status: LEGACY_STAGES[old], legacyStatus: old } : meta;
  }
  return { workspace: { ...ws, version: 2, songs }, changed: true };
}

// Album cover colors — the dark categorical slots, in fixed order.
// Release swatches avoid blue (the stage ramp) and the hot orange (actions).
export const ALBUM_COLORS = ["#c98500", "#199e70", "#d55181", "#9085e9", "#e66767", "#8a9a5b", "#b8742a"];

export const EMPTY_WORKSPACE: Workspace = { version: 2, songs: {}, albums: [], people: [] };

/** The workspace version this build reads and writes. */
export const WORKSPACE_VERSION = 2;

/** The stored workspace's version when a newer Hivo wrote it (this build
 * must not save over it), else null. */
export function newerWorkspaceVersion(stored: unknown): number | null {
  const v = (stored as { version?: unknown } | null)?.version;
  return typeof v === "number" && v > WORKSPACE_VERSION ? v : null;
}

/** Fresh = the newest mixdown is at least as new as the last save, backups
 * included (an autosave after the render means the mixdown is behind). */
export function renderFreshness(p: ProjectInfo): RenderFreshness {
  const latest = p.renders[0];
  if (!latest) return "none";
  return latest.modifiedAtMs >= lastSaveMs(p) ? "fresh" : "stale";
}

export function backupsBytes(p: ProjectInfo): number {
  return p.backups.reduce((sum, b) => sum + b.sizeBytes, 0);
}

export function rendersBytes(p: ProjectInfo): number {
  return p.renders.reduce((sum, r) => sum + r.sizeBytes, 0);
}

export function albumsOf(workspace: Workspace, path: string): Album[] {
  return workspace.albums.filter((a) => a.trackPaths.includes(path));
}

export function folderLabel(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function formatBpm(bpm: number | null): string {
  return bpm == null ? "—" : `${bpm % 1 === 0 ? bpm : bpm.toFixed(1)}`;
}

/** Every save FL recorded for a song: the current file plus each backup. */
export function saveTimestamps(p: ProjectInfo): number[] {
  return [p.modifiedAtMs, ...(p.backups ?? []).map((b) => b.modifiedAtMs)];
}

/** The latest save, backups included: FL's autosave and save-backups land in
 * the Backup folder, so the project file alone can look weeks old while the
 * song was worked on yesterday. 0 = unknown. */
export function lastSaveMs(p: ProjectInfo): number {
  return Math.max(0, ...saveTimestamps(p).filter((t) => Number.isFinite(t) && t > 0));
}

export function missingPlugins(p: ProjectInfo) {
  return p.plugins.filter((x) => x.installed === false);
}

export function missingSamples(p: ProjectInfo) {
  return p.samples.filter((s) => s.status === "missing");
}

/** A song that won't open cleanly on this machine, or that couldn't be read. */
export function hasProblems(p: ProjectInfo): boolean {
  return !!p.readError || missingPlugins(p).length > 0 || missingSamples(p).length > 0;
}

/** Song name, plus its folder when another song has the same name
 * (e.g. two "Ft Le Q" projects in different folders). */
export function songLabel(p: ProjectInfo, all: ProjectInfo[]): string {
  const clash = all.some((o) => o !== p && o.name.toLowerCase() === p.name.toLowerCase());
  return clash ? `${p.name} (${folderLabel(p.folder)})` : p.name;
}

const NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
/** All 24 keys, majors then minors ("C", …, "Cm", …). */
export const KEYS = [...NOTES, ...NOTES.map((n) => `${n}m`)];

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
