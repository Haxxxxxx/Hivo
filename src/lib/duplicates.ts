// Songs saved several times over the same material: three versions of one
// track that share its stems and vocal takes, or three folder copies of
// one project.
//
// This reports EVIDENCE and never a verdict. "Safe to delete" about an
// irreplaceable vocal take is a claim this cannot honestly make — a version
// may differ only in automation or mixer settings the .flp reader does not
// expose, and being wrong once is unforgivable. The screen shows what the
// versions share and how they differ; the decision stays with the user, and
// Hivo deletes nothing.

import type { ProjectInfo } from "../types";

/** Case- and spacing-insensitive comparison key. Mirrors the Rust reader's
 * own folding so "Vocal Take 3.wav" and "vocal take 3.wav" are one sample. */
const fold = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** How a sample is identified across copies: its file name, folded.
 *
 * Not its path. The same stem sitting in two song folders, or moved to
 * another drive, is the same recording — matching on path would miss
 * exactly the case this looks for. */
export function sampleKey(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return fold(name);
}

/** Content FL ships with itself, which says nothing about two songs.
 *
 * This is the whole reason the first version of this screen was wrong: it
 * put five unrelated projects in one group because each had dragged in
 * `Basic 808 Kick.wav`, `…Snare`, `…Clap` and `…Hihat` from FL's stock
 * drums. Four shared "samples", zero relationship.
 *
 * FL marks it for us — the stored path begins `%FLStudioFactoryData%`, and
 * once that token is expanded the factory packs still live under
 * `Data/Patches/Packs`. Both forms appear depending on whether FL was
 * found on this machine, so both are checked. */
export function isStockSample(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return p.includes("%flstudiofactorydata%") || p.includes("/data/patches/packs/");
}

/** Samples distinctive enough to be evidence.
 *
 * A kick everyone uses says nothing about two songs being versions of each
 * other; a vocal take shared by exactly two does. Stock content is dropped
 * outright, and anything still used by more than `commonAbove` songs is
 * treated as library furniture and ignored. */
export function distinctiveSamples(songs: ProjectInfo[], commonAbove: number): Set<string> {
  const uses = new Map<string, number>();
  for (const song of songs) {
    const own = song.samples.filter((s) => !isStockSample(s.path)).map((s) => sampleKey(s.path));
    for (const key of new Set(own)) uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [key, n] of uses) if (n >= 2 && n <= commonAbove) out.add(key);
  return out;
}

/** How common a sample has to be before it stops being evidence.
 *
 * A fixed number cannot be right for both a twelve-song folder and a
 * thousand-song one: five songs is nearly half of the first and noise in
 * the second. A quarter of the library, and never below three.
 *
 * Three is the floor because a song saved three times is the case this
 * screen exists for, and in a small folder those three copies ARE most of
 * the library — a stricter floor would write their shared vocal takes off
 * as furniture and find nothing. */
export function commonAbove(libraryCount: number): number {
  return Math.max(3, Math.ceil(libraryCount / 4));
}

/** Two songs that are the same FILE, saved in two places.
 *
 * `Ocean/Ocean.flp`, `Ocean copy/Ocean.flp`, `Ocean copy 2/Ocean.flp` is
 * the shape this catches, and nothing about samples can: those projects
 * have none at all, so there is no overlap to find. Same file name, same
 * byte count — for a format that stores its whole arrangement inline, that
 * is a copy and not a coincidence.
 *
 * Empty files are excluded: a zero-byte project matches every other
 * zero-byte project and means nothing. */
export function fileKey(song: ProjectInfo): string | null {
  if (!song.sizeBytes) return null;
  const name = song.path.split(/[\\/]/).pop() ?? song.name;
  return `${fold(name)}:${song.sizeBytes}`;
}

export interface DuplicateMember {
  path: string;
  name: string;
  savedMs: number;
  tempoBpm: number | null;
  sampleCount: number;
  /** Plugins this version has that at least one sibling does not. */
  pluginsNotInAll: string[];
}

export interface DuplicateGroup {
  /** Stable id for lists and keys: the members' paths, sorted. */
  id: string;
  members: DuplicateMember[];
  /** Distinctive samples every member uses. Empty for a group found by
   * being the same file rather than by shared material. */
  sharedSamples: string[];
  /** Every member is the same file name at the same size: a copy. */
  sameFile: boolean;
  /** True when every member has exactly the same plugin set. */
  samePlugins: boolean;
  /** True when every member reports the same tempo. */
  sameTempo: boolean;
}

/** Groups of songs that are versions or copies of one another.
 *
 * Two signals, either of which is enough. Songs that share `minShared` of
 * their distinctive samples, and songs that are the same file saved twice.
 * Grouping is transitive (A~B, B~C puts all three together), because that
 * is how a song saved three times actually looks.
 */
export function duplicateGroups(
  songs: ProjectInfo[],
  { minShared = 3, common = commonAbove(songs.length) }: { minShared?: number; common?: number } = {},
): DuplicateGroup[] {
  const distinctive = distinctiveSamples(songs, common);
  const keys = new Map<string, Set<string>>();
  for (const song of songs) {
    const own = new Set(song.samples.map((s) => sampleKey(s.path)).filter((k) => distinctive.has(k)));
    keys.set(song.path, own);
  }

  // Union-find over "shares at least minShared distinctive samples, or is
  // the same file".
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const byFile = new Map<string, string[]>();
  for (const song of songs) {
    const f = fileKey(song);
    if (!f) continue;
    const list = byFile.get(f) ?? [];
    list.push(song.path);
    byFile.set(f, list);
  }
  const copies = new Set<string>();
  for (const list of byFile.values()) {
    if (list.length < 2) continue;
    for (const p of list) copies.add(p);
    for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  }

  const paths = songs.map((s) => s.path).filter((p) => (keys.get(p)?.size ?? 0) >= minShared || copies.has(p));
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = keys.get(paths[i])!;
      const b = keys.get(paths[j])!;
      let shared = 0;
      for (const k of a) if (b.has(k) && ++shared >= minShared) break;
      if (shared >= minShared) union(paths[i], paths[j]);
    }
  }

  const byRoot = new Map<string, ProjectInfo[]>();
  const byPath = new Map(songs.map((s) => [s.path, s]));
  for (const path of paths) {
    const root = find(path);
    (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(byPath.get(path)!);
  }

  const groups: DuplicateGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const sets = members.map((m) => keys.get(m.path)!);
    const shared = [...sets[0]].filter((k) => sets.every((s) => s.has(k))).sort();
    const files = new Set(members.map(fileKey));
    const sameFile = files.size === 1 && !files.has(null);
    // Either signal justifies the group; neither, and it was only held
    // together by a chain that no longer means anything.
    if (shared.length < minShared && !sameFile) continue;

    const pluginSets = members.map((m) => new Set(m.plugins.map((p) => fold(p.name))));
    const inAll = [...pluginSets[0]].filter((p) => pluginSets.every((s) => s.has(p)));
    const tempos = new Set(members.map((m) => m.tempoBpm));

    groups.push({
      id: members
        .map((m) => m.path)
        .sort()
        .join("|"),
      // Newest first: the version most likely to be the keeper leads.
      members: [...members]
        .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
        .map((m) => ({
          path: m.path,
          name: m.name,
          savedMs: m.modifiedAtMs,
          tempoBpm: m.tempoBpm,
          sampleCount: m.samples.length,
          pluginsNotInAll: m.plugins.map((p) => p.name).filter((n) => !inAll.includes(fold(n))),
        })),
      sharedSamples: shared,
      sameFile,
      samePlugins: members.every((_, i) => pluginSets[i].size === inAll.length),
      sameTempo: tempos.size === 1,
    });
  }

  // Copies first, then the most shared material: the clearest cases on top.
  return groups.sort((a, b) => Number(b.sameFile) - Number(a.sameFile) || b.sharedSamples.length - a.sharedSamples.length);
}
