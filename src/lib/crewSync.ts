import type { Album, AlbumKind, CrewCredit, CrewMemberRow, CrewReleaseRow, CrewSongRow, CrewSummary, ProjectInfo, SongMeta, SongStatus, StageConflict, Workspace } from "../types";
import { cleanTitle } from "./launchKit";
import { datedRelease } from "./releaseDates";
import { isKitAccepted } from "./kitState";
import { lastSaveMs, renderFreshness } from "./songs";
import { dict, plural, tr } from "../i18n";

// Sync between the local workspace and the crew database (docs/ARCHITECTURE.md).
// Pure functions: what to push for a shared song, which remote stage moves to
// apply locally, which local moves to send, and what to delete. Only metadata
// ever leaves the computer.
//
// Rules that keep a crewmate's data safe:
// - A share belongs to one crew and one account (`ShareScope`). Other crews
//   and other sign-ins on this machine never push or delete it.
// - A row is deleted only when this workspace explicitly unshared it
//   (`shared: false` with its shareId kept). A song missing from a scan, from
//   another computer's workspace, or from an empty workspace is never deleted.
// - The stage is never sent in the regular upsert (that could rewind a move
//   a crewmate made on the board). New rows carry it; later local moves go
//   through move_song_stage with the version they were made on, so a move
//   made on an outdated version becomes a conflict, never an overwrite.

export interface ShareScope {
  crewId: string;
  userId: string;
}

/** What gets upserted. `stage` is only used for brand-new rows. */
export type SharedSongPayload = Omit<CrewSongRow, "owner_id" | "stage_updated_by" | "stage_updated_at" | "updated_at">;

const iso = (ms: number) => new Date(ms).toISOString();

/** Shared with this crew by this account (legacy unscoped shares count too). */
export function sharedHere(meta: SongMeta | undefined, scope: ShareScope): boolean {
  return !!meta?.shared && !!meta.shareId && inScope(meta, scope);
}

function inScope(meta: SongMeta, scope: ShareScope): boolean {
  return (meta.shareCrewId ?? scope.crewId) === scope.crewId && (meta.shareUserId ?? scope.userId) === scope.userId;
}

/** The release date the crew should see: the song's release, else its Launch Kit date. */
function releaseDateFor(path: string, meta: SongMeta, ws: Workspace): string | null {
  // The same rule as the Launch Kit and the Calendar (releaseDates.ts).
  const date = datedRelease(path, meta, ws.albums);
  return date && isRealDate(date) ? date : null;
}

/** YYYY-MM-DD that is an actual calendar day (Postgres refuses 2026-02-30). */
function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

// Size caps from the songs table's CHECK constraints. One row that fails them
// fails the whole push, so the payload is cut to fit, with headroom.
const TITLE_MAX = 200;
const TAGS_MAX = 30;
const TAG_CHARS = 40;
/** The database allows pg_column_size(tags) <= 2048. */
const TAGS_BYTES = 1800;
const CREDITS_MAX = 30;
const NAME_CHARS = 60;
const ROLE_CHARS = 40;
/** The database allows pg_column_size(credits) <= 8192. */
const CREDITS_BYTES = 7000;

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s).length;
/** Cut to `n` characters (code points, as Postgres counts them), never mid-emoji. */
const chars = (s: string, n: number) => Array.from(s).slice(0, n).join("");
/** Upper bound of one text element in a Postgres array (4-byte header, 4-byte aligned). */
const tagCost = (t: string) => 4 + Math.ceil(utf8(t) / 4) * 4;
/** Upper bound of one { name, role, split } object in jsonb (headers, keys, numeric). */
const creditCost = (c: { name: string; role: string }) => 64 + utf8(c.name) + utf8(c.role);

/** A title that passes btrim(title) between 1 and 200: the one the user set
 * for the crew, else the cleaned-up project file name. */
export function sharedTitle(projectName: string, override?: string): string {
  const chosen = override?.trim();
  const t = chars(chosen || (cleanTitle(projectName) || projectName).trim(), TITLE_MAX).trim();
  return t || "Untitled";
}

/** Tags cut to the database's count, length and byte caps. */
export function sharedTags(tags: string[]): string[] {
  const out: string[] = [];
  let bytes = 24; // array header
  for (const raw of tags) {
    const t = chars(raw.trim(), TAG_CHARS);
    if (!t) continue;
    if (out.length >= TAGS_MAX || bytes + tagCost(t) > TAGS_BYTES) break;
    bytes += tagCost(t);
    out.push(t);
  }
  return out;
}

/** Credits cut to the database's count, length and byte caps. */
export function sharedCredits(credits: CrewCredit[]): CrewCredit[] {
  const out: CrewCredit[] = [];
  let bytes = 16; // jsonb array header
  for (const c of credits) {
    const credit = {
      name: chars(c.name.trim(), NAME_CHARS),
      role: chars((c.role ?? "").trim(), ROLE_CHARS),
      // The database takes 0-100 or nothing; anything else would fail the whole push.
      split: typeof c.split === "number" && Number.isFinite(c.split) && c.split >= 0 && c.split <= 100 ? c.split : null,
    };
    if (!credit.name) continue;
    if (out.length >= CREDITS_MAX || bytes + creditCost(credit) > CREDITS_BYTES) break;
    bytes += creditCost(credit);
    out.push(credit);
  }
  return out;
}

/** The row to upsert for one shared song, always within the database's checks. */
export function sharedSongPayload(project: ProjectInfo, meta: SongMeta, ws: Workspace, scope: ShareScope): SharedSongPayload | null {
  if (!sharedHere(meta, scope)) return null;
  const name = (id: string) => ws.people.find((p) => p.id === id)?.name;
  const bpm = project.tempoBpm != null && project.tempoBpm >= 10 && project.tempoBpm <= 522 ? Math.round(project.tempoBpm * 100) / 100 : null;
  const key = meta.key ? chars(meta.key.trim(), 8) : "";
  return {
    id: meta.shareId!,
    crew_id: scope.crewId,
    title: sharedTitle(project.name, meta.shareTitle),
    stage: meta.status ?? null,
    bpm,
    musical_key: key || null,
    tags: sharedTags(meta.tags ?? []),
    credits: sharedCredits(
      (meta.credits ?? []).flatMap((c) => {
        const n = name(c.personId);
        return n ? [{ name: n, role: c.role, split: c.split ?? null }] : [];
      }),
    ),
    release_date: releaseDateFor(project.path, meta, ws),
    has_mixdown: project.renders.length > 0,
    mixdown_fresh: project.renders.length > 0 ? renderFreshness(project) === "fresh" : null,
    kit_accepted: isKitAccepted(project, meta, ws.albums),
    last_saved_at: lastSaveMs(project) > 0 ? iso(lastSaveMs(project)) : null,
  };
}

/** Where a song is shared (or waiting to be unshared) other than `scope`, if
 * anywhere. Sharing it here would replace its shareId and strand that row, so
 * it has to be moved explicitly (see useCrewStore.moveShares). */
export function shareElsewhere(meta: SongMeta | undefined, scope: ShareScope): { crewId: string; mine: boolean; shared: boolean } | null {
  if (!meta?.shareId || inScope(meta, scope)) return null;
  // Out of scope means another crew, another account, or both.
  return { crewId: meta.shareCrewId ?? scope.crewId, mine: (meta.shareUserId ?? scope.userId) === scope.userId, shared: !!meta.shared };
}

/** Every shared song's payload, for one push. */
export function sharedPayloads(projects: ProjectInfo[], ws: Workspace, scope: ShareScope): SharedSongPayload[] {
  return projects.flatMap((p) => {
    const row = sharedSongPayload(p, ws.songs[p.path] ?? {}, ws, scope);
    return row ? [row] : [];
  });
}

/** shareId → local .flp path. */
export function pathsByShareId(ws: Workspace): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, meta] of Object.entries(ws.songs)) if (meta.shareId) out.set(meta.shareId, path);
  return out;
}

/** What to do about one of my shared songs' stage. */
export type StageSync =
  /** The crew moved it (on the board, or my other computer): take that.
   * `by`: who made the move (user id), when known. */
  | { kind: "adopt"; path: string; stage: SongStatus | undefined; at: string; by: string | null }
  /** Both sides agree: just remember the row's version (and who moved it). */
  | { kind: "settle"; path: string; at: string; by: string | null }
  /** My move, made on version `base`: send it (the server refuses it if
   * someone moved the song since). */
  | { kind: "push"; path: string; id: string; stage: SongStatus | null; base: string }
  /** Someone moved it while my move was waiting: the owner picks. */
  | { kind: "conflict"; path: string; conflict: StageConflict };

/** Stage sync for my songs shared with this crew, by version, never by
 * comparing clocks (a computer with a wrong clock can't win or lose a move
 * it shouldn't). Songs shared before versions existed fall back to the old
 * timestamp comparison once, then carry a version. */
export function stageSync(rows: CrewSongRow[], ws: Workspace, scope: ShareScope): StageSync[] {
  const byId = pathsByShareId(ws);
  const out: StageSync[] = [];
  for (const row of rows) {
    if (row.owner_id !== scope.userId || row.crew_id !== scope.crewId) continue;
    const path = byId.get(row.id);
    const meta = path ? ws.songs[path] : undefined;
    if (!path || !meta || !sharedHere(meta, scope)) continue;
    const local = meta.status ?? null;
    const remote = row.stage ?? null;
    const at = row.stage_updated_at;
    const by = row.stage_updated_by ?? null;
    const sameVersion = meta.stageBaseAt !== undefined && Date.parse(meta.stageBaseAt) === Date.parse(at);
    if (remote === local) {
      if (!sameVersion || meta.stagePending || meta.stageConflict) out.push({ kind: "settle", path, at, by });
      continue;
    }
    if (meta.stageConflict) {
      // Already waiting for the owner; follow the crew's latest move.
      if (Date.parse(meta.stageConflict.at) !== Date.parse(at)) {
        out.push({ kind: "conflict", path, conflict: { ...meta.stageConflict, theirs: remote, by: row.stage_updated_by ?? null, at } });
      }
      continue;
    }
    if (meta.stageBaseAt === undefined) {
      // Shared before stage versions: one last time, the newer stamp wins.
      if ((meta.stageUpdatedAtMs ?? 0) > (Date.parse(at) || 0)) out.push({ kind: "push", path, id: row.id, stage: local, base: at });
      else out.push({ kind: "adopt", path, stage: remote ?? undefined, at, by });
      continue;
    }
    if (meta.stagePending) {
      if (sameVersion) out.push({ kind: "push", path, id: row.id, stage: local, base: meta.stageBaseAt });
      else out.push({ kind: "conflict", path, conflict: { mine: local, theirs: remote, by: row.stage_updated_by ?? null, at } });
      continue;
    }
    if (!sameVersion) out.push({ kind: "adopt", path, stage: remote ?? undefined, at, by });
  }
  return out;
}

/** My rows in this crew that this workspace explicitly stopped sharing:
 * these get deleted. A row with no local record (another computer, a fresh
 * workspace, an unplugged drive) is left alone. */
export function staleShareIds(rows: CrewSongRow[], ws: Workspace, scope: ShareScope): string[] {
  const unshared = new Set(
    Object.values(ws.songs)
      .filter((m) => m.shared === false && m.shareId && inScope(m, scope))
      .map((m) => m.shareId!),
  );
  return rows.filter((r) => r.owner_id === scope.userId && r.crew_id === scope.crewId && unshared.has(r.id)).map((r) => r.id);
}

/** Paths of songs shared here that aren't in the library right now (renamed,
 * moved, deleted, or on an unplugged drive). Their crew cards are frozen. */
export function orphanedShares(projects: ProjectInfo[], ws: Workspace, scope: ShareScope): string[] {
  const present = new Set(projects.map((p) => p.path));
  return Object.entries(ws.songs)
    .filter(([path, m]) => sharedHere(m, scope) && !present.has(path))
    .map(([path]) => path);
}

export interface SyncFacts {
  demoMode: boolean;
  /** Hivo could read and can save workspace.json. */
  workspaceWritable: boolean;
  hasFolders: boolean;
  /** Songs shared with this crew from this computer. */
  sharedCount: number;
}

/** Why nothing of yours reaches the crew board, in one line (the first
 * blocker), or null when your shared songs sync. */
const T_SYNC = dict(
  {
    demo: "Not syncing: you're looking at sample data, which is never shared. Link your real projects folder.",
    readOnly: "Not syncing: Hivo can't save its data on this computer (see the message at the top of the window).",
    noFolders: "Nothing to share yet: add your projects folder in Settings, then share songs.",
    noneShared: "Nothing shared yet: your songs stay private until you share them (song panel, or select several in the Library).",
  },
  {
    demo: "Pas de synchro\u202f: tu regardes des données d'exemple, qui ne sont jamais partagées. Relie ton vrai dossier de projets.",
    readOnly: "Pas de synchro\u202f: Hivo n'arrive pas à enregistrer ses données sur cet ordi (voir le message en haut de la fenêtre).",
    noFolders: "Rien à partager pour l'instant\u202f: ajoute ton dossier de projets dans les Réglages, puis partage des sons.",
    noneShared: "Rien de partagé pour l'instant\u202f: tes sons restent privés tant que tu ne les partages pas (panneau du son, ou sélectionnes-en plusieurs dans la Bibliothèque).",
  },
);

export function syncNote(f: SyncFacts): string | null {
  const t = tr(T_SYNC);
  if (f.demoMode) return t.demo;
  if (!f.workspaceWritable) return t.readOnly;
  if (!f.hasFolders) return t.noFolders;
  if (f.sharedCount === 0) return t.noneShared;
  return null;
}

// ---- Shared releases ----

export interface SharedReleasePayload {
  id: string;
  crew_id: string;
  title: string;
  kind: AlbumKind;
  color: string | null;
  release_date: string | null;
  /** Shared tracks only, in tracklist order. */
  song_ids: string[];
}

export function releaseSharedHere(a: Album, scope: ShareScope): boolean {
  return !!a.shared && !!a.shareId && (a.shareCrewId ?? scope.crewId) === scope.crewId && (a.shareUserId ?? scope.userId) === scope.userId;
}

const KINDS: AlbumKind[] = ["album", "ep", "single", "mixtape"];

/** What each of my shared releases sends: title, type, colour, date and the
 * tracks I share in this crew (nothing else, never paths or notes). */
export function releasePayloads(ws: Workspace, scope: ShareScope): SharedReleasePayload[] {
  return ws.albums.filter((a) => releaseSharedHere(a, scope)).map((a) => ({
    id: a.shareId!,
    crew_id: scope.crewId,
    title: a.title.trim().slice(0, 200) || "Untitled release",
    kind: KINDS.includes(a.kind) ? a.kind : "album",
    color: /^#[0-9a-fA-F]{6}$/.test(a.color) ? a.color : null,
    release_date: a.releaseDate && isRealDate(a.releaseDate) ? a.releaseDate : null,
    song_ids: [...new Set(a.trackPaths.map((p) => ws.songs[p]).filter((m) => sharedHere(m, scope)).map((m) => m!.shareId!))].slice(0, 100),
  }));
}

/** My release rows to delete: unshared here, or deleted here while shared.
 * Never "not in this workspace" (my other computer may not know it). */
export function staleReleaseIds(rows: CrewReleaseRow[], ws: Workspace, scope: ShareScope): string[] {
  const gone = new Set([
    ...ws.albums.filter((a) => a.shared === false && a.shareId && (a.shareCrewId ?? scope.crewId) === scope.crewId && (a.shareUserId ?? scope.userId) === scope.userId).map((a) => a.shareId!),
    ...releaseTombstones(ws, scope),
  ]);
  return rows.filter((r) => r.owner_id === scope.userId && r.crew_id === scope.crewId && gone.has(r.id)).map((r) => r.id);
}

/** Releases deleted on this computer while shared with this crew (a marker
 * without a crew is from before scoping: it counts for the active one). */
export function releaseTombstones(ws: Workspace, scope: ShareScope): string[] {
  return (ws.deletedReleaseShares ?? []).filter((d) => (d.crewId ?? scope.crewId) === scope.crewId && (d.userId ?? scope.userId) === scope.userId).map((d) => d.id);
}

/** A release's tracks that aren't shared with this crew yet (to offer "share the rest"). */
export function unsharedTracks(a: Album, ws: Workspace, scope: ShareScope): string[] {
  return a.trackPaths.filter((p) => !sharedHere(ws.songs[p], scope));
}

/** The crew's releases in the order to show them: upcoming (soonest first),
 * then undated, then past (latest first). `today` is a local YYYY-MM-DD. */
export function sortCrewReleases(rows: CrewReleaseRow[], today: string): CrewReleaseRow[] {
  const rank = (r: CrewReleaseRow) => (!r.release_date ? 1 : r.release_date >= today ? 0 : 2);
  return [...rows].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return a.release_date!.localeCompare(b.release_date!);
    if (ra === 2) return b.release_date!.localeCompare(a.release_date!);
    return a.title.localeCompare(b.title);
  });
}

/** A release's tracks as crew songs (in tracklist order; songs no longer shared are left out). */
export function releaseTracks(r: CrewReleaseRow, songs: CrewSongRow[]): CrewSongRow[] {
  const byId = new Map(songs.map((s) => [s.id, s]));
  return r.song_ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}


// ---- Push planning: quotas, unchanged rows, removal, my rows on the server ----

/** The server's limits (enforce_quotas): songs per person per crew, releases per crew. */
export const SONGS_PER_CREW = 1000;
export const RELEASES_PER_CREW = 500;
/** Rows per upsert request. */
export const UPSERT_CHUNK = 200;

/** A share or release limit refused a new row (enforce_quotas, P0001). */
export function isQuotaError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return err?.code === "P0001" && /share limit|release limit/i.test(err.message ?? "");
}

export function chunks<T>(rows: T[], size = UPSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const sameTime = (a: string | null, b: string | null) => (a == null || b == null ? a == b : Date.parse(a) === Date.parse(b));
const sameCredits = (a: CrewCredit[], b: CrewCredit[]) =>
  a.length === b.length && a.every((c, i) => c.name === b[i]?.name && (c.role ?? "") === (b[i]?.role ?? "") && (c.split ?? null) === (b[i]?.split ?? null));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The server already has these details (the stage is never compared: it
 * moves through move_song_stage). Unchanged rows aren't sent again, so a
 * restart doesn't rewrite every shared song. */
export function songRowMatches(p: Omit<SharedSongPayload, "stage">, row: CrewSongRow): boolean {
  return (
    p.title === row.title &&
    (p.bpm ?? null) === (row.bpm == null ? null : Number(row.bpm)) &&
    (p.musical_key ?? null) === (row.musical_key ?? null) &&
    sameList(p.tags, row.tags ?? []) &&
    sameCredits(p.credits, row.credits ?? []) &&
    (p.release_date ?? null) === (row.release_date ?? null) &&
    p.has_mixdown === row.has_mixdown &&
    // A server without the column (before its migration) never reports it.
    (!("mixdown_fresh" in row) || (p.mixdown_fresh ?? null) === (row.mixdown_fresh ?? null)) &&
    p.kit_accepted === row.kit_accepted &&
    sameTime(p.last_saved_at, row.last_saved_at)
  );
}

export function releaseRowMatches(p: SharedReleasePayload, row: CrewReleaseRow): boolean {
  return (
    p.title === row.title &&
    p.kind === row.kind &&
    (p.color ?? null) === (row.color ?? null) &&
    (p.release_date ?? null) === (row.release_date ?? null) &&
    sameList(p.song_ids, (row.song_ids ?? []).map((id) => id.toLowerCase()))
  );
}

/** How many more songs I can share with this crew: the limit minus my rows
 * there and my shares here that aren't there yet. */
export function shareRoom(rows: CrewSongRow[], ws: Workspace, scope: ShareScope): number {
  const ids = new Set(rows.filter((r) => r.owner_id === scope.userId && r.crew_id === scope.crewId).map((r) => r.id));
  for (const m of Object.values(ws.songs)) if (sharedHere(m, scope)) ids.add(m.shareId!);
  return Math.max(0, SONGS_PER_CREW - ids.size);
}

/** Crews my shares on this computer point to that I'm no longer in (removed
 * by the owner, or the crew was deleted): the server already dropped my rows
 * there, so these shares are forgotten, never silently republished if I
 * rejoin. Only shares stamped with a crew and this account count. */
export function goneCrewIds(ws: Workspace, userId: string, myCrewIds: string[]): string[] {
  const mine = new Set(myCrewIds);
  const out = new Set<string>();
  const check = (crewId: string | undefined, owner: string | undefined, shareId: string | undefined) => {
    if (shareId && crewId && owner === userId && !mine.has(crewId)) out.add(crewId);
  };
  for (const m of Object.values(ws.songs)) check(m.shareCrewId, m.shareUserId, m.shareId);
  for (const a of ws.albums) check(a.shareCrewId, a.shareUserId, a.shareId);
  for (const d of ws.deletedReleaseShares ?? []) check(d.crewId, d.userId, d.id);
  return [...out];
}

/** One of my rows on the crew server. `local`: this computer knows it (a
 * song here carries its id). `duplicate`: not known here, and another of my
 * rows in this crew that this computer doesn't know either has the same
 * title (the same song shared twice before a reinstall). A row with the
 * same title as a song shared from here is not flagged: my other computer
 * may share a different song under that title. Never removed by itself. */
export interface MyServerShare {
  id: string;
  title: string;
  stage: SongStatus | null;
  local: boolean;
  duplicate: boolean;
}

const titleKey = (t: string) => t.trim().toLocaleLowerCase();

/** My rows in this crew, the ones this computer doesn't know first. */
export function myServerShares(rows: CrewSongRow[], ws: Workspace, scope: ShareScope): MyServerShare[] {
  const known = pathsByShareId(ws);
  const mine = rows.filter((r) => r.owner_id === scope.userId && r.crew_id === scope.crewId);
  const unknownTitles = new Map<string, number>();
  for (const r of mine) if (!known.has(r.id)) unknownTitles.set(titleKey(r.title), (unknownTitles.get(titleKey(r.title)) ?? 0) + 1);
  return mine
    .map((r) => {
      const local = known.has(r.id);
      return { id: r.id, title: r.title, stage: r.stage ?? null, local, duplicate: !local && (unknownTitles.get(titleKey(r.title)) ?? 0) > 1 };
    })
    .sort((a, b) => Number(a.local) - Number(b.local) || a.title.localeCompare(b.title));
}

/** Everything a push depends on, in one string: a local change that leaves
 * it the same (typing a note, a window size) doesn't start a sync. */
export function syncFingerprint(projects: ProjectInfo[], ws: Workspace, scope: ShareScope): string {
  const stages = Object.values(ws.songs)
    .filter((m) => m.shareId && inScope(m, scope))
    .map((m) => [m.shareId, m.shared ?? null, m.status ?? null, m.stagePending ?? null, m.stageBaseAt ?? null, m.stageConflict?.at ?? null]);
  const albums = ws.albums.filter((a) => a.shareId).map((a) => [a.shareId, a.shared ?? null, a.shareCrewId ?? null, a.shareUserId ?? null]);
  return JSON.stringify([sharedPayloads(projects, ws, scope), releasePayloads(ws, scope), stages, albums, ws.deletedReleaseShares ?? []]);
}

const T_LIMIT = dict(
  {
    share: (n: number) =>
      `${n} song${plural(n, " wasn't", "s weren't")} shared: a crew takes up to ${SONGS_PER_CREW} songs from each person. Stop sharing some first (Settings → Crew lists what's on the server).`,
    pushSongs: (n: number) => ` · ${n} new song${plural(n, "", "s")} not shared (share limit reached: stop sharing some to make room)`,
    pushReleases: (n: number) => ` · ${n} release${plural(n, "", "s")} not shared (the crew has ${RELEASES_PER_CREW}, the most allowed)`,
  },
  {
    share: (n: number) =>
      `${n} son${plural(n, " n'a pas été partagé", "s n'ont pas été partagés")} : un crew prend jusqu'à ${SONGS_PER_CREW} sons par personne. Arrête d'en partager d'abord (Réglages → Crew liste ce qui est sur le serveur).`,
    pushSongs: (n: number) => ` · ${n} nouveau${plural(n, " son non partagé", "x sons non partagés")} (limite de partage atteinte : arrête d'en partager pour faire de la place)`,
    pushReleases: (n: number) => ` · ${n} sortie${plural(n, " non partagée", "s non partagées")} (le crew en a ${RELEASES_PER_CREW}, le maximum)`,
  },
);

/** Said after a share that hit the limit (null when nothing was left out). */
export function shareLimitNote(overLimit: number): string | null {
  return overLimit > 0 ? tr(T_LIMIT).share(overLimit) : null;
}

/** Appended to the sync line when the limits left new shares out. */
export function pushLimitNote(songs: number, releases: number): string {
  const t = tr(T_LIMIT);
  return (songs > 0 ? t.pushSongs(songs) : "") + (releases > 0 ? t.pushReleases(releases) : "");
}


// ---- Round 2 (crew review): freshness, moved-by, names, credits, owner, share moves ----

/** What a crew card says about the mixdown. `unknown`: there is one, sent
 * by a Hivo from before freshness was shared. */
export type CrewMixdown = "fresh" | "stale" | "none" | "unknown";

export function crewMixdown(row: Pick<CrewSongRow, "has_mixdown" | "mixdown_fresh">): CrewMixdown {
  if (!row.has_mixdown) return "none";
  if (row.mixdown_fresh === true) return "fresh";
  if (row.mixdown_fresh === false) return "stale";
  return "unknown";
}

/** Crew credits as the crew surfaces show them: names and roles, never splits. */
export function crewCreditsText(credits: CrewCredit[] | null | undefined): string {
  return (credits ?? [])
    .filter((c) => c.name?.trim())
    .map((c) => (c.role?.trim() ? `${c.name.trim()} (${c.role.trim()})` : c.name.trim()))
    .join(" · ");
}

/** Last known display name per user id, kept on this device so a former
 * member's moves and releases still show a name. */
export type KnownNames = Record<string, string>;

/** The cache with these members' current names in it (null: nothing new). */
export function rememberNames(known: KnownNames, members: Pick<CrewMemberRow, "user_id" | "display_name">[]): KnownNames | null {
  let next: KnownNames | null = null;
  for (const m of members) {
    const name = m.display_name?.trim();
    if (!m.user_id || !name || known[m.user_id] === name) continue;
    next ??= { ...known };
    next[m.user_id] = name;
  }
  return next;
}

/** A user's name: the current member's, else the last one seen here. */
export function nameOf(userId: string | null | undefined, members: Pick<CrewMemberRow, "user_id" | "display_name">[], known: KnownNames): string | undefined {
  if (!userId) return undefined;
  return members.find((m) => m.user_id === userId)?.display_name ?? known[userId];
}

/** The crews I just became the owner of (a handover, or the owner left),
 * comparing the crew list before and after. */
export function newlyOwned(before: CrewSummary[], after: CrewSummary[]): CrewSummary[] {
  return after.filter((c) => c.role === "owner" && before.some((b) => b.id === c.id && b.role !== "owner"));
}

/** The crew list with my role in one crew updated from my member row. */
export function withMyRole(crews: CrewSummary[], crewId: string, role: CrewSummary["role"] | undefined): CrewSummary[] {
  if (!role || !crews.some((c) => c.id === crewId && c.role !== role)) return crews;
  return crews.map((c) => (c.id === crewId ? { ...c, role } : c));
}

/** The share fields that move with a crew card. */
const SHARE_FIELDS = ["shared", "shareId", "shareCrewId", "shareUserId", "shareTitle", "stageBaseAt", "stagePending", "stageConflict", "stageMovedBy"] as const;

/** Whether `to` can take over `from`'s share in this crew: `from` is shared
 * here and `to` is another song with no share of its own (any crew). */
export function canMoveShare(ws: Workspace, from: string, to: string, scope: ShareScope): boolean {
  return from !== to && sharedHere(ws.songs[from], scope) && !ws.songs[to]?.shareId;
}

/** Move a crew card to another song (FL "Save As", a new version): the new
 * song takes the share id, so the card keeps its column, order and history;
 * the old song is no longer shared (and nothing is deleted on the server).
 * The stage follows the card. Null when the move isn't allowed. */
export function moveShare(ws: Workspace, from: string, to: string, scope: ShareScope): { from: Partial<SongMeta>; to: Partial<SongMeta> } | null {
  if (!canMoveShare(ws, from, to, scope)) return null;
  const old = ws.songs[from]!;
  const next: Partial<SongMeta> = { status: old.status, stageUpdatedAtMs: old.stageUpdatedAtMs };
  const cleared: Partial<SongMeta> = {};
  for (const k of SHARE_FIELDS) {
    (next as Record<string, unknown>)[k] = old[k];
    (cleared as Record<string, unknown>)[k] = undefined;
  }
  // Explicit, so the store doesn't mark the stage as a new local move.
  next.stagePending = old.stagePending ?? false;
  cleared.stagePending = false;
  return { from: cleared, to: next };
}
