// The main window's side of the session view (src-tauri/src/session.rs).
// It owns the text: the session window says hello, then gets the target's
// note every time it changes (typing in the drawer or the Digger shows up
// live). The session window can ask to open the notes ("session-open-notes").

import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { currentLang } from "../i18n";
import type { Relink } from "../lib/relink";
import type { SessionPayload, SessionTarget } from "../lib/session";
import { useAppStore } from "./useAppStore";

const WINDOW = "session";
let target: SessionTarget | null = null;
let lastSent = "";

function payload(t: SessionTarget): SessionPayload {
  const s = useAppStore.getState();
  const ws = s.workspace;
  let text = "";
  let gone = false;
  let bpm = t.bpm;
  if (t.kind === "song") {
    const project = s.projects.find((p) => p.path === t.id);
    // A rescan in flight can briefly list nothing: not "gone".
    gone = !project && !s.scanning && s.projects.length > 0;
    text = ws.songs[t.id]?.notes ?? "";
    bpm = project?.tempoBpm ?? bpm;
    // A rename shows its new name.
    if (project) return { ...t, title: project.name, bpm, text, gone, lang: currentLang() };
  } else if (t.kind === "beat") text = ws.beatNotes?.[t.id] ?? "";
  else text = ws.leadNotes?.[t.id] ?? "";
  return { ...t, bpm, text, gone, lang: currentLang() };
}

/** The target after records moved (lib/relink.ts): a song keeps its window. */
export function followRelink(t: SessionTarget, relinks: Relink[]): SessionTarget {
  if (t.kind !== "song") return t;
  const moved = relinks.find((r) => r.from === t.id);
  return moved ? { ...t, id: moved.to } : t;
}

function send(force = false) {
  if (!target) return;
  const p = payload(target);
  const key = JSON.stringify(p);
  if (!force && key === lastSent) return;
  lastSent = key;
  void emitTo(WINDOW, "session-text", p).catch(() => {});
}

/** Opens (or refocuses) the session window on this song / beat / prod. */
export async function openSession(t: SessionTarget): Promise<void> {
  target = t;
  lastSent = "";
  await invoke("open_session_window", { title: t.title });
  // A window already open gets the new text right away; a new one asks (hello).
  send(true);
}

/** Starts answering the session window; returns the stop function (App.tsx). */
export function startSessionBridge(): () => void {
  if (!isTauri()) return () => {};
  const unsubs: UnlistenFn[] = [];
  let stopped = false;
  const keep = (p: Promise<UnlistenFn>) =>
    void p
      .then((u) => (stopped ? u() : unsubs.push(u)))
      .catch(() => {});
  keep(listen("session-hello", () => send(true)));
  keep(
    listen("session-open-notes", () => {
      if (!target) return;
      const s = useAppStore.getState();
      if (target.kind === "song") s.openDetail(target.id);
      else s.setView("digger");
      void getCurrentWindow().setFocus().catch(() => {});
    }),
  );
  const unsubStore = useAppStore.subscribe((s, prev) => {
    // A renamed or relinked song (or "Continue in FL Studio"): follow it.
    if (target && s.lastRelinks !== prev.lastRelinks) target = followRelink(target, s.lastRelinks);
    if (target && (s.workspace !== prev.workspace || s.projects !== prev.projects || s.scanning !== prev.scanning)) send();
  });
  return () => {
    stopped = true;
    unsubStore();
    for (const u of unsubs) u();
  };
}
