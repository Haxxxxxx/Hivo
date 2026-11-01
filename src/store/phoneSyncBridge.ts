// Answers the phone sync requests Rust forwards (`phone-sync-request`, see
// src-tauri/src/phone_sync.rs and docs/PHONE-SYNC.md) from the store. Notes
// are written through the same actions as the desktop's own editors, so the
// workspace keeps one writer. Sample data is never synced ("demo").

import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "../lib/tauri";
import { applyNoteChanges, buildSnapshot, noteLookup, parseChanges, type SyncSources } from "../lib/phoneSync";
import type { PhoneSyncRequest } from "../types";
import { useAppStore } from "./useAppStore";
import { startPhoneInbox } from "./usePhoneInbox";

type Reply = { body: unknown } | { error: string };

/** How long a request waits for a running scan (Rust gives up after 10 s). */
export const SCAN_WAIT_MS = 5_000;

/** Resolves when no scan is running, or after `ms` (whichever comes first). */
function scanSettled(ms: number): Promise<void> {
  if (!useAppStore.getState().scanning) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(done, ms);
    const unsub = useAppStore.subscribe((s) => {
      if (!s.scanning) done();
    });
  });
}

async function sources(): Promise<SyncSources | Reply> {
  // Fresh lists: the Digger may never have been opened. No beats folder = none.
  const [leads, beats] = await Promise.all([api.listLeads().catch(() => []), api.scanBeats().catch(() => []), scanSettled(SCAN_WAIT_MS)]);
  const s = useAppStore.getState();
  if (s.demoMode) return { error: "demo" };
  if (!s.workspaceWritable) return { error: "busy" };
  // A scan still running answers from the last one; only the very first
  // scan (nothing listed yet) is worth waiting for, or songs would look deleted.
  if (s.scanning && s.projects.length === 0) return { error: "busy" };
  return { leads, beats, projects: s.projects, workspace: s.workspace };
}

export async function answerPhoneRequest(req: PhoneSyncRequest): Promise<Reply> {
  if (useAppStore.getState().demoMode) return { error: "demo" };
  if (req.path !== "/v1/snapshot" && req.path !== "/v1/notes") return { error: "bad request" };
  const src = await sources();
  if ("error" in src || "body" in src) return src;
  if (req.path === "/v1/snapshot") return { body: buildSnapshot(src, Date.now()) };

  const changes = parseChanges(req.body);
  if (!changes) return { error: "bad request" };
  const { results, writes } = applyNoteChanges(changes, noteLookup(src), req.phoneName);
  const store = useAppStore.getState();
  for (const w of writes) {
    if (w.kind === "prod") store.setLeadNote(w.id, w.text);
    else if (w.kind === "beat") store.setBeatNote(w.id, w.text);
    else store.updateSong(w.id, { notes: w.text });
  }
  return { body: { results } };
}

/** Starts answering; returns the stop function (App.tsx mounts it once).
 * Also tells Rust when sample data is on screen (the phone's uploads and
 * ideas are refused then) and keeps the phone inbox list fresh. */
export function startPhoneSyncBridge(): () => void {
  let unlisten: UnlistenFn | null = null;
  let stopped = false;
  const tellDemo = (on: boolean) => void api.phoneSyncSetDemo(on).catch(() => {});
  tellDemo(useAppStore.getState().demoMode);
  const unsubDemo = useAppStore.subscribe((s, prev) => {
    if (s.demoMode !== prev.demoMode) tellDemo(s.demoMode);
  });
  const stopInbox = startPhoneInbox();
  api
    .onPhoneSyncRequest((req) => {
      void answerPhoneRequest(req)
        .catch((): Reply => ({ error: "busy" }))
        .then((reply) => api.phoneSyncReply(req.id, reply))
        .catch((e) => console.error("phone sync reply failed", e));
    })
    .then((u) => {
      if (stopped) u();
      else unlisten = u;
    })
    .catch(() => {});
  return () => {
    stopped = true;
    unlisten?.();
    unsubDemo();
    stopInbox();
  };
}
