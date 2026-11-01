// Ideas written on the phone (docs/PHONE-SYNC.md v1.1, /v1/ideas): titles,
// punchlines, concepts, optionally aimed at a prod, beat or song. They live
// on the phone until the desktop files them into a note. Pure state
// transitions; the store persists them and does the I/O.

import type { Kind } from "./sync";
import { clip } from "./text";

/** Paired with src-tauri/src/phone_inbox.rs. */
export const MAX_IDEAS_PER_PUSH = 200;
export const MAX_TITLE_CHARS = 200;
export const MAX_IDEA_CHARS = 20_000;

export type IdeaTarget = { kind: Kind; id: string; title: string };
export type DesktopStatus = "stored" | "filed" | "dismissed";

export type Idea = {
  id: string;
  title: string;
  text: string;
  target: IdeaTarget | null;
  createdAt: number;
  updatedAt: number;
  /** updatedAt of the copy the desktop has (null: never sent). */
  sentAt: number | null;
  /** Deleted on the phone; kept until the desktop knows. */
  deleted: boolean;
  /** What the desktop did with it; filed/dismissed ideas can't be edited. */
  status: DesktopStatus | null;
  filedTo: string | null;
};

export const isEmptyIdea = (i: Pick<Idea, "title" | "text">): boolean => !i.title.trim() && !i.text.trim();
export const isLocked = (i: Idea): boolean => i.status === "filed" || i.status === "dismissed";

/** A random id the desktop accepts ([A-Za-z0-9_-], ≤ 64). */
export function newId(random: (n: number) => Uint8Array): string {
  return Array.from(random(12), (b) => "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"[b & 63]).join("");
}

export function createIdea(id: string, now: number, init: Partial<Pick<Idea, "title" | "text" | "target">> = {}): Idea {
  return {
    id,
    title: clip(init.title ?? "", MAX_TITLE_CHARS),
    text: clip(init.text ?? "", MAX_IDEA_CHARS),
    target: init.target ?? null,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    deleted: false,
    status: null,
    filedTo: null,
  };
}

/** An edit; a locked idea (filed/dismissed on the desktop) doesn't change. */
export function editIdea(ideas: Idea[], id: string, patch: Partial<Pick<Idea, "title" | "text" | "target">>, now: number): Idea[] {
  return ideas.map((i) => {
    if (i.id !== id || isLocked(i)) return i;
    const next = {
      ...i,
      ...patch,
      title: clip(patch.title ?? i.title, MAX_TITLE_CHARS),
      text: clip(patch.text ?? i.text, MAX_IDEA_CHARS),
    };
    const same = next.title === i.title && next.text === i.text && next.target?.id === i.target?.id && next.target?.kind === i.target?.kind;
    return same ? i : { ...next, updatedAt: Math.max(now, i.updatedAt + 1) };
  });
}

/** Deleting: never sent or empty = gone now; else kept as deleted until the desktop knows. */
export function deleteIdea(ideas: Idea[], id: string, now: number): Idea[] {
  return ideas.flatMap((i) => {
    if (i.id !== id) return [i];
    if (i.sentAt === null) return [];
    return [{ ...i, deleted: true, updatedAt: Math.max(now, i.updatedAt + 1) }];
  });
}

/** What to push: changed since sent, not empty (unless it's a delete), at most MAX_IDEAS_PER_PUSH. */
export function ideasToPush(ideas: Idea[]): Idea[] {
  return ideas
    .filter((i) => !isLocked(i) && (i.sentAt === null || i.updatedAt > i.sentAt) && (i.deleted || !isEmptyIdea(i)))
    .slice(0, MAX_IDEAS_PER_PUSH);
}

export function ideaPayload(i: Idea) {
  return { id: i.id, title: i.title, text: i.text, target: i.target, createdAt: i.createdAt, updatedAt: i.updatedAt, deleted: i.deleted };
}

export type IdeaResult = { id: string; status: DesktopStatus | "deleted"; filedTo: string | null };

export function parseIdeaResults(body: unknown): IdeaResult[] | null {
  const list = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return null;
  const out: IdeaResult[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r.id !== "string") continue;
    if (r.status !== "stored" && r.status !== "filed" && r.status !== "dismissed" && r.status !== "deleted") continue;
    out.push({ id: r.id, status: r.status, filedTo: typeof r.filedTo === "string" ? r.filedTo : null });
  }
  return out;
}

/** The desktop's answer: `sent` is what was pushed (an edit made meanwhile stays to push). */
export function applyIdeaResults(ideas: Idea[], sent: Idea[], results: IdeaResult[]): Idea[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return ideas.flatMap((i) => {
    const r = byId.get(i.id);
    const was = sent.find((s) => s.id === i.id);
    if (!r || !was) return [i];
    if (r.status === "deleted") return i.deleted || isEmptyIdea(i) ? [] : [{ ...i, sentAt: null }];
    return [{ ...i, sentAt: was.updatedAt, status: r.status, filedTo: r.filedTo }];
  });
}

/** Statuses from /v1/inbox (filed/dismissed later on the desktop). */
export function applyIdeaStatuses(ideas: Idea[], statuses: Map<string, { status: string; filedTo: string | null }>): Idea[] {
  return ideas.map((i) => {
    const s = statuses.get(i.id);
    if (!s || i.sentAt === null) return i;
    const status: DesktopStatus = s.status === "filed" ? "filed" : s.status === "dismissed" ? "dismissed" : "stored";
    return status === i.status && s.filedTo === i.filedTo ? i : { ...i, status, filedTo: s.filedTo };
  });
}

/** A new pairing: the other computer has none of them. */
export const resetSent = (ideas: Idea[]): Idea[] =>
  ideas.filter((i) => !i.deleted).map((i) => ({ ...i, sentAt: null, status: null, filedTo: null }));

/** Newest first, deleted hidden. */
export const visibleIdeas = (ideas: Idea[]): Idea[] => ideas.filter((i) => !i.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
