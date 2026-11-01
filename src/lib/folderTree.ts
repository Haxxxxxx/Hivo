import type { ProjectInfo } from "../types";
import { hasProblems } from "./songs";

// The Library's folder tree: the watched roots and, under each, the folders
// that hold songs. A song's own folder (the one FL makes per project,
// `Envy/Envy.flp`) isn't a node: nodes are folders with two or more songs
// below them, so the tree shows the structure the user set up (artist, year,
// era…) and not one node per song. Paths keep their own separators; `norm`
// makes comparisons work for Windows paths read on a Mac and vice versa.

export interface FolderNode {
  /** The folder's path as the scanner gave it. */
  path: string;
  name: string;
  depth: number;
  /** Songs anywhere below (what the pane shows as a count). */
  count: number;
  /** Songs below with a problem (missing plugins or samples, unreadable). */
  issues: number;
  children: FolderNode[];
}

export const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Whether `project` sits in `folder` or anywhere below it. */
export function inFolder(project: Pick<ProjectInfo, "folder">, folder: string): boolean {
  const f = norm(folder);
  const p = norm(project.folder);
  return p === f || p.startsWith(`${f}/`);
}

const lastSegment = (p: string) => {
  const parts = norm(p).split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
};

/** The tree for the songs shown (roots in the order they appear, children
 * by name). Empty when there is nothing to branch into: one root with no
 * folder that holds two or more songs. */
export function buildFolderTree(projects: ProjectInfo[]): FolderNode[] {
  // Every ancestor folder between a song and its root, with the songs below it.
  const below = new Map<string, ProjectInfo[]>();
  const order: string[] = [];
  const note = (path: string, p: ProjectInfo) => {
    if (!below.has(path)) {
      below.set(path, []);
      order.push(path);
    }
    below.get(path)!.push(p);
  };
  for (const p of projects) {
    const root = norm(p.root);
    const folder = norm(p.folder);
    if (!folder.startsWith(root)) {
      note(root, p);
      continue;
    }
    note(root, p);
    const rel = folder.slice(root.length).split("/").filter(Boolean);
    let path = root;
    for (const seg of rel) {
      path = `${path}/${seg}`;
      note(path, p);
    }
  }
  const roots = [...new Set(projects.map((p) => norm(p.root)))];
  const isNode = (path: string) => roots.includes(path) || (below.get(path)?.length ?? 0) >= 2;
  const nodePaths = order.filter(isNode);

  const build = (path: string, depth: number): FolderNode => {
    const songs = below.get(path) ?? [];
    const kids = nodePaths
      .filter((c) => c !== path && c.startsWith(`${path}/`) && !nodePaths.some((m) => m !== path && m !== c && m.startsWith(`${path}/`) && c.startsWith(`${m}/`)))
      .sort((a, b) => lastSegment(a).localeCompare(lastSegment(b), undefined, { numeric: true }))
      .map((c) => build(c, depth + 1));
    return { path, name: lastSegment(path), depth, count: songs.length, issues: songs.filter(hasProblems).length, children: kids };
  };
  const tree = roots.map((r) => build(r, 0));
  const branches = tree.length > 1 || tree.some((r) => r.children.length > 0);
  return branches ? tree : [];
}

/** The nodes from the root down to `folder` (for a breadcrumb), or [] when
 * `folder` isn't in the tree. */
export function folderPath(tree: FolderNode[], folder: string): FolderNode[] {
  const target = norm(folder);
  const walk = (nodes: FolderNode[], trail: FolderNode[]): FolderNode[] | null => {
    for (const n of nodes) {
      if (n.path === target) return [...trail, n];
      if (target.startsWith(`${n.path}/`)) {
        const deeper = walk(n.children, [...trail, n]);
        if (deeper) return deeper;
        return [...trail, n];
      }
    }
    return null;
  };
  return walk(tree, []) ?? [];
}

/** Whether `folder` is a node of the tree. A folder filter whose node is gone
 * (the songs moved, the folder was unlinked, the tree collapsed to nothing)
 * would leave "No songs match" with nothing to click: the Library clears it. */
export function hasFolderNode(tree: FolderNode[], folder: string): boolean {
  const target = norm(folder);
  const walk = (nodes: FolderNode[]): boolean => nodes.some((n) => n.path === target || (target.startsWith(`${n.path}/`) && walk(n.children)));
  return walk(tree);
}
