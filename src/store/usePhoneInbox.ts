import { create } from "zustand";
import * as api from "../lib/tauri";
import { appendIdea, ideaBlock, newCount, relinkedFilings, targetKey } from "../lib/phoneInbox";
import { useAppStore } from "./useAppStore";
import type { FiledSketch, IncomingItem, InboxItem, InboxTarget } from "../types";
import { dict, tr } from "../i18n";

// The phone inbox on the desktop (docs/PHONE-SYNC.md v1.1). Rust holds the
// items and files; this mirrors the list, refreshes when Rust says
// something arrived (`phone-inbox-changed`), and files things: ideas into
// notes (through the same store actions as the editors), memos into a song's
// folder or onto a beat/prod, sketches into a new song folder.

interface InboxState {
  items: InboxItem[];
  receiving: number;
  /** Items still arriving, with their progress (Remove frees their space). */
  incoming: IncomingItem[];
  loaded: boolean;
  error: string | null;
  /** Phone sync is on / how many phones are paired (the menu entry shows when either). */
  syncOn: boolean;
  paired: number;
  refresh: () => Promise<void>;
  /** Appends the idea to the target's note, then marks it filed. */
  fileIdea: (item: InboxItem, target: InboxTarget) => Promise<void>;
  /** Song: copied into its folder ("Voice memos", or BandLab/ for a sketch's
   * audio). Beat/prod: linked, and copied into that beats folder's `_memos`. */
  attachMemo: (item: InboxItem, target: InboxTarget) => Promise<void>;
  /** A new sketch song from the item's audio; returns its key and what's in it. */
  fileSketch: (item: InboxItem, parentFolder: string, name: string, bandlabUrl?: string) => Promise<FiledSketch>;
  dismiss: (item: InboxItem) => Promise<void>;
  restore: (item: InboxItem) => Promise<void>;
  remove: (item: InboxItem) => Promise<void>;
  /** Removes an item still arriving (frees its space in the inbox). */
  removeIncoming: (id: string) => Promise<void>;
}

const T = dict(
  {
    sample: "This is sample data: switch to your library first.",
    notLoaded: "Your workspace isn't loaded yet: try again in a moment.",
    gone: "That song isn't in the Library any more: pick another.",
    full: "That note is full (20,000 characters): pick another or make room.",
    empty: "This idea is empty.",
  },
  {
    sample: "Ce sont des données d'exemple : passe d'abord à ta bibliothèque.",
    notLoaded: "Ton espace de travail n'est pas encore chargé : réessaie dans un instant.",
    gone: "Ce son n'est plus dans la bibliothèque : choisis-en un autre.",
    full: "Cette note est pleine (20 000 caractères) : choisis-en une autre ou fais de la place.",
    empty: "Cette idée est vide.",
  },
);

function currentNote(target: InboxTarget): string | null {
  const s = useAppStore.getState();
  if (target.kind === "song") return s.projects.some((p) => p.path === target.id) ? (s.workspace.songs[target.id]?.notes ?? "") : null;
  if (target.kind === "beat") return s.workspace.beatNotes?.[target.id] ?? "";
  return s.workspace.leadNotes?.[target.id] ?? "";
}

export const usePhoneInbox = create<InboxState>((set, get) => {
  async function after<T>(work: Promise<T>): Promise<T> {
    const out = await work;
    await get().refresh();
    return out;
  }

  return {
    items: [],
    receiving: 0,
    incoming: [],
    loaded: false,
    error: null,
    syncOn: false,
    paired: 0,

    refresh: async () => {
      try {
        const [list, status] = await Promise.all([api.phoneInboxList(), api.phoneSyncStatus().catch(() => null)]);
        set({
          items: list.items,
          receiving: list.receiving,
          incoming: list.incoming ?? [],
          loaded: true,
          error: null,
          syncOn: status?.on ?? false,
          paired: status?.devices.filter((d) => d.lastSeenMs !== null).length ?? 0,
        });
      } catch (e) {
        set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
      }
    },

    fileIdea: async (item, target) => {
      const t = tr(T);
      const app = useAppStore.getState();
      if (app.demoMode) throw new Error(t.sample);
      if (!app.workspaceWritable) throw new Error(t.notLoaded);
      const note = currentNote(target);
      if (note === null) throw new Error(t.gone);
      // Already in that note (a retry after a lost answer): only the status is left.
      const already = item.title.trim() || item.text.trim() ? note.includes(ideaBlock(item)) : false;
      const r = already ? null : appendIdea(note, item);
      if (r && !r.ok) throw new Error(r.reason === "full" ? t.full : t.empty);
      // Marked first: if that fails nothing was written, so a retry can't add it twice.
      await api.phoneInboxMark(item.id, "filed", targetKey(target));
      if (r?.ok) {
        try {
          if (target.kind === "song") app.updateSong(target.id, { notes: r.text });
          else if (target.kind === "beat") app.setBeatNote(target.id, r.text);
          else app.setLeadNote(target.id, r.text);
        } catch (e) {
          await api.phoneInboxMark(item.id, "new").catch(() => {});
          await get().refresh();
          throw e;
        }
      }
      await get().refresh();
    },

    attachMemo: async (item, target) => {
      if (useAppStore.getState().demoMode) throw new Error(tr(T).sample);
      if (target.kind === "song") {
        await after(api.phoneInboxAttachSong(item.id, target.id));
        return;
      }
      // Rust copies the memo into the beats folder's `_memos` (never only in the inbox).
      await after(api.phoneInboxLinkMemo(item.id, target.kind, target.id));
    },

    fileSketch: async (item, parentFolder, name, bandlabUrl) => {
      try {
        return await useAppStore.getState().fileInboxSketch({ itemId: item.id, parentFolder, name, bandlabUrl });
      } finally {
        await get().refresh();
      }
    },

    dismiss: (item) => after(api.phoneInboxMark(item.id, "dismissed")),
    restore: (item) => after(api.phoneInboxMark(item.id, "new")),
    remove: (item) => after(api.phoneInboxRemove(item.id)),
    removeIncoming: (id) => after(api.phoneInboxRemove(id)),
  };
});

export const useInboxNewCount = () => usePhoneInbox((s) => newCount(s.items));

/** Loads the list and keeps it fresh; returns the stop function. */
export function startPhoneInbox(): () => void {
  let stopped = false;
  let unlisten: (() => void) | null = null;
  void usePhoneInbox.getState().refresh();
  api
    .onPhoneInboxChanged(() => void usePhoneInbox.getState().refresh())
    .then((u) => {
      if (stopped) u();
      else unlisten = u;
    })
    .catch(() => {});
  // A song renamed or relinked (or continued in FL Studio): what was filed
  // to it (`song:<key>`) follows, so its drawer still lists its memos.
  const unsubRelinks = useAppStore.subscribe((s, prev) => {
    if (s.lastRelinks === prev.lastRelinks || s.lastRelinks.length === 0 || s.demoMode) return;
    const moves = relinkedFilings(usePhoneInbox.getState().items, s.lastRelinks);
    if (moves.length === 0) return;
    void Promise.all(moves.map((m) => api.phoneInboxMark(m.id, "filed", m.filedTo)))
      .catch((e) => console.error("phone inbox: following a relink failed", e))
      .finally(() => void usePhoneInbox.getState().refresh());
  });
  return () => {
    stopped = true;
    unlisten?.();
    unsubRelinks();
  };
}
