// The Capture home's list: ideas, memos and exports, grouped by what they
// need (failed → waiting / sending → on the computer), newest first, each
// with a plain status. Pure: the screen turns the statuses into words.
import type { SyncErrorCode } from "./client";
import { isEmptyIdea, type Idea } from "./ideas";
import type { HoldReason, OutItem } from "./outbox";

export type Group = "needs" | "waiting" | "done";
export const GROUPS: Group[] = ["needs", "waiting", "done"];

/** Why something hasn't gone yet. */
export type WaitReason = "unpaired" | "away" | "blocked" | "held" | "next-sync";

export type CaptureStatus =
  | { kind: "failed" }
  /** A stopped take not kept yet (RecordScreen keeps or discards it). */
  | { kind: "draft" }
  | { kind: "sending"; pct: number }
  | { kind: "waiting"; reason: WaitReason }
  | { kind: "filed"; filedTo: string | null }
  | { kind: "dismissed" }
  /** On the computer, not filed yet. `old`: sent to a computer this phone isn't paired with any more. */
  | { kind: "received"; old: boolean };

export type CaptureRow =
  | { kind: "idea"; id: string; at: number; group: Group; status: CaptureStatus; idea: Idea }
  | { kind: "out"; id: string; at: number; group: Group; status: CaptureStatus; out: OutItem };

export type Conn = {
  paired: boolean;
  /** The last sync's error (null: fine). */
  error: SyncErrorCode | null;
  /** Ideas, memos and exports held by the computer (inbox or disk full…). */
  held: HoldReason | "outdated" | "demo" | null;
  /** The outbox item being sent, and how far (0..1). */
  sending: { id: string; progress: number } | null;
};

/** Away from the computer's Wi-Fi, or its sync is off: normal, not a fault. */
export const isAway = (e: SyncErrorCode | null): boolean => e === "offline" || e === "off";

function waitReason(c: Conn): WaitReason {
  if (!c.paired) return "unpaired";
  if (c.held) return "held";
  if (c.error) return isAway(c.error) ? "away" : "blocked";
  return "next-sync";
}

export function ideaStatus(i: Idea, c: Conn): CaptureStatus {
  if (i.status === "filed") return { kind: "filed", filedTo: i.filedTo };
  if (i.status === "dismissed") return { kind: "dismissed" };
  if (i.sentAt !== null && i.updatedAt <= i.sentAt) return { kind: "received", old: !c.paired };
  return { kind: "waiting", reason: waitReason(c) };
}

export function outStatus(o: OutItem, c: Conn): CaptureStatus {
  if (o.state === "draft") return { kind: "draft" };
  if (o.state === "failed") return { kind: "failed" };
  if (o.state === "sent") {
    if (o.status === "filed") return { kind: "filed", filedTo: o.filedTo };
    if (o.status === "dismissed") return { kind: "dismissed" };
    return { kind: "received", old: !c.paired };
  }
  if (c.sending?.id === o.id) return { kind: "sending", pct: Math.round(c.sending.progress * 100) };
  return { kind: "waiting", reason: waitReason(c) };
}

const groupOf = (s: CaptureStatus): Group => (s.kind === "failed" || s.kind === "draft" ? "needs" : s.kind === "waiting" || s.kind === "sending" ? "waiting" : "done");

/** Every capture worth showing (not deleted, not empty), grouped, newest first in each group. */
export function captureRows(ideas: Idea[], outbox: OutItem[], c: Conn): { group: Group; rows: CaptureRow[] }[] {
  const rows: CaptureRow[] = [
    ...ideas
      .filter((i) => !i.deleted && !isEmptyIdea(i))
      .map((idea): CaptureRow => {
        const status = ideaStatus(idea, c);
        return { kind: "idea", id: idea.id, at: idea.updatedAt, group: groupOf(status), status, idea };
      }),
    ...outbox.map((out): CaptureRow => {
      const status = outStatus(out, c);
      return { kind: "out", id: out.id, at: out.createdAt, group: groupOf(status), status, out };
    }),
  ];
  return GROUPS.map((group) => ({ group, rows: rows.filter((r) => r.group === group).sort((a, b) => b.at - a.at) })).filter((g) => g.rows.length > 0);
}

/** The Capture tab's badge: only what needs the user (a failed item, a take not kept yet), not what simply waits. */
export const needsYou = (outbox: OutItem[]): number => outbox.filter((o) => o.state === "failed" || o.state === "draft").length;

/** What's still on the phone for the computer: unsent ideas, waiting memos and exports. */
export function waitingOnPhone(ideas: Idea[], outbox: OutItem[]): number {
  return (
    ideas.filter((i) => !i.deleted && !isEmptyIdea(i) && (i.sentAt === null || i.updatedAt > i.sentAt) && i.status !== "filed" && i.status !== "dismissed").length +
    outbox.filter((o) => o.state === "waiting" || o.state === "sending" || o.state === "failed").length
  );
}

/** "0:42", "1:59", "12:05": whole seconds, rounded once. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  fr: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
};

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today 21:14", "yesterday 08:02", "3 Nov 21:14" ("aujourd'hui 21:14", "hier…", "3 nov. 21:14"), in the phone's time zone. No Intl (Hermes). */
export function when(at: number, now: number, lang: "en" | "fr"): string {
  const d = new Date(at);
  const n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  const day = sameDay(d, n)
    ? lang === "fr" ? "aujourd'hui" : "today"
    : sameDay(d, y)
      ? lang === "fr" ? "hier" : "yesterday"
      : `${d.getDate()} ${MONTHS[lang][d.getMonth()]}${d.getFullYear() !== n.getFullYear() ? ` ${d.getFullYear()}` : ""}`;
  return `${day} ${time}`;
}

/** What a save on a pushed screen kept, for the toast: a memo, an export or an idea made or edited since `since`. */
export function savedSince(
  route: { name: string; id?: string; draftId?: string },
  ideas: Idea[],
  outbox: OutItem[],
  since: number,
): "memo" | "export" | "idea" | null {
  if (route.name === "record" || route.name === "share") {
    // A take reopened from its draft row: kept if it's no longer a draft.
    if (route.draftId) return outbox.some((o) => o.id === route.draftId && o.state !== "draft") ? "memo" : null;
    // A take left as a draft (not kept) says nothing.
    const fresh = outbox.find((o) => o.createdAt >= since && o.state !== "draft");
    if (fresh) return fresh.type === "memo" ? "memo" : "export";
    return null;
  }
  if (route.name === "idea") {
    const i = ideas.find((x) => x.id === route.id);
    return i && !i.deleted && !isEmptyIdea(i) && i.updatedAt >= since ? "idea" : null;
  }
  return null;
}

/** How the header reads the connection: neutral when simply away, red only for a real fault. */
export type SyncTone = "ok" | "idle" | "away" | "warn" | "fault";

const FAULTS: SyncErrorCode[] = ["forgotten", "clock", "read-only", "server", "outdated"];

export function syncTone(s: { paired: boolean; error: SyncErrorCode | null; waiting: number; lastSyncAt: number | null }): SyncTone {
  if (!s.paired) return "idle";
  if (s.error && FAULTS.includes(s.error)) return "fault";
  if (s.error && isAway(s.error)) return "away";
  if (s.error) return "warn";
  if (s.waiting > 0) return "warn";
  return s.lastSyncAt ? "ok" : "idle";
}

/** "Hivo sur l'ordi…" keeps its capital after a colon; "Pas sur le même Wi-Fi" doesn't. */
export function lowerFirst(s: string): string {
  if (/^(Hivo|BandLab|Wi-Fi|OK)\b/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A hivo://pair link whose only address is the phone itself (127.x): it can never reach the computer. */
export const isLoopbackLink = (url: string): boolean => /^hivo:\/\/pair/i.test(url.trim()) && /[?&]h=(?:127\.[\d.]+(?:%2C|,)?)+(?:&|$)/i.test(url.trim());

/** mm:ss left of the pairing code's 5 minutes. */
export function remaining(startedAt: number, now: number, ttlMs: number): string {
  const left = Math.max(0, ttlMs - (now - startedAt));
  return duration(Math.floor(left / 1000) * 1000);
}
