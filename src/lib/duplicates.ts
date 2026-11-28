// Songs saved several times over the same material: three versions of one
// track that share its stems and vocal takes.
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

/** Samples distinctive enough to be evidence.
 *
 * A kick everyone uses says nothing about two songs being versions of each
 * other; a vocal take shared by exactly two does. Anything used by more
 * than `commonAbove` songs is treated as library furniture and ignored. */
export function distinctiveSamples(songs: ProjectInfo[], commonAbove: number): Set<string> {
  const uses = new Map<string, number>();
  for (const song of songs) {
    for (const key of new Set(song.samples.map((s) => sampleKey(s.path)))) {
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [key, n] of uses) if (n >= 2 && n <= commonAbove) out.add(key);
  return out;
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
  /** Distinctive samples every member uses. */
  sharedSamples: string[];
  /** True when every member has exactly the same plugin set. */
  samePlugins: boolean;
  /** True when every member reports the same tempo. */
  sameTempo: boolean;
}

/** Groups of songs that share enough distinctive material to be versions of
 * one another.
 *
 * `minShared` guards against two songs that happen to share one sample.
 * Grouping is transitive (A~B, B~C puts all three together), because that
 * is how a song saved three times actually looks.
 */
export function duplicateGroups(
  songs: ProjectInfo[],
  { minShared = 3, commonAbove = 5 }: { minShared?: number; commonAbove?: number } = {},
): DuplicateGroup[] {
  const distinctive = distinctiveSamples(songs, commonAbove);
  const keys = new Map<string, Set<string>>();
  for (const song of songs) {
    const own = new Set(song.samples.map((s) => sampleKey(s.path)).filter((k) => distinctive.has(k)));
    if (own.size >= minShared) keys.set(song.path, own);
  }

  // Union-find over "shares at least minShared distinctive samples".
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const paths = [...keys.keys()];
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
    if (shared.length < minShared) continue;

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
      samePlugins: members.every((_, i) => pluginSets[i].size === inAll.length),
      sameTempo: tempos.size === 1,
    });
  }

  // Most shared material first: the clearest cases at the top.
  return groups.sort((a, b) => b.sharedSamples.length - a.sharedSamples.length);
}
