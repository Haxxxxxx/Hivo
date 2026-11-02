// "Start a song from this beat": what happens once the New song modal has
// created the project (src/lib/beatSong.ts holds the pure rules). Lives
// outside both stores because it needs both (usePhoneInbox imports
// useAppStore).

import * as api from "../lib/tauri";
import { beatMemos, moveBeatToSong, personNamed } from "../lib/beatSong";
import { useAppStore } from "./useAppStore";
import { usePhoneInbox } from "./usePhoneInbox";

export interface FromBeat {
  path: string;
  name: string;
  /** Who produced it, when known (`beatProducer`). */
  producer: string | null;
}

/**
 * The beat's note moves to the song at `songPath`, a Producer credit is
 * added for `producer` (an existing person by name or alias, else a new
 * one), and the phone memos linked to the beat are copied into the song's
 * `Voice memos/` and re-filed there. The beat file is never touched.
 * Returns the memos that couldn't be moved (they stay on the beat).
 */
export async function adoptBeat(songPath: string, beat: FromBeat, producer: string | null): Promise<{ moved: number; failed: string[] }> {
  const app = useAppStore.getState();
  let producerId: string | null = null;
  const name = producer?.trim();
  if (name) producerId = personNamed(app.workspace.people, name)?.id ?? app.createPerson(name);
  useAppStore.getState().applyWorkspace((ws) => moveBeatToSong(ws, beat.path, songPath, producerId));

  const inbox = usePhoneInbox.getState();
  if (!inbox.loaded) await inbox.refresh();
  const memos = beatMemos(usePhoneInbox.getState().items, beat.path);
  const failed: string[] = [];
  let moved = 0;
  for (const memo of memos) {
    try {
      await api.phoneInboxAttachSong(memo.id, songPath);
      moved++;
    } catch {
      failed.push(memo.title || memo.id);
    }
  }
  if (memos.length) await usePhoneInbox.getState().refresh();
  return { moved, failed };
}
