import { ArrowLeft, ExternalLink, MonitorPlay, Pause, Play, Plus, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { useDigger } from "../store/useDigger";
import * as api from "../lib/tauri";
import { youtubeId } from "../lib/digger";
import { dict, tr } from "../i18n";
import type { BeatFile, SavedLead } from "../types";
import { NotesEditor } from "./NotesEditor";
import { PhoneMemos } from "./PhoneMemos";
import { openSession } from "../store/sessionBridge";
import { usePhoneInbox } from "../store/usePhoneInbox";
import { memosFor } from "../lib/phoneInbox";
import { beatProducer, beatSongName } from "../lib/beatSong";
import { label, secondary } from "./DigResults";

// The Digger's right column while a beat or a saved prod is selected: what
// it is, a player, and its notes (Read / Edit). Takes DigPanel's place;
// ✕, "Back to dig" or Esc (DiggerView) bring the dig back. Notes are saved
// as typed (setBeatNote / setLeadNote).

const T = dict(
  {
    title: "Notes",
    close: "Close notes",
    back: "Back to dig",
    beat: "Beat",
    savedProd: "Saved prod",
    play: (name: string) => `Play ${name}`,
    pause: (name: string) => `Pause ${name}`,
    seek: "Position",
    playDock: "Play",
    playDockTitle: (title: string) => `Play ${title} in the player`,
    openLink: "Open link",
    openTitle: (title: string) => `Open ${title} in the browser`,
    local: "Your file",
    bpm: (n: number) => `${Math.round(n)} BPM`,
    session: "Session view",
    sessionTitle: "The notes large, in a window kept on top of FL Studio",
    startSong: "Start a song",
    startSongTitle: "A new song from this beat: its notes and phone memos move to the song; the beat file stays where it is",
  },
  {
    title: "Notes",
    close: "Fermer les notes",
    back: "Retour à la recherche",
    beat: "Prod",
    savedProd: "Prod enregistrée",
    play: (name: string) => `Écouter ${name}`,
    pause: (name: string) => `Pause ${name}`,
    seek: "Position",
    playDock: "Écouter",
    playDockTitle: (title: string) => `Écouter ${title} dans le lecteur`,
    openLink: "Ouvrir le lien",
    openTitle: (title: string) => `Ouvrir ${title} dans le navigateur`,
    local: "Ton fichier",
    bpm: (n: number) => `${Math.round(n)} BPM`,
    session: "Vue session",
    sessionTitle: "Les notes en grand, dans une fenêtre gardée devant FL Studio",
    startSong: "Démarrer un son",
    startSongTitle: "Un nouveau son à partir de cette prod : ses notes et ses mémos du téléphone passent au son ; le fichier de la prod reste où il est",
  },
);

export type NotesTarget = { kind: "beat"; beat: BeatFile } | { kind: "lead"; lead: SavedLead; beat: BeatFile | null };

/** The Digger's one <audio> element, as the panel needs it. */
export interface LocalPlayer {
  /** The beat loaded in the element (playing or paused). */
  loaded: string | null;
  /** The beat playing right now. */
  playing: string | null;
  time: number;
  duration: number;
  toggle: (beat: BeatFile) => void;
  seek: (sec: number) => void;
}

const clock = (sec: number) => {
  if (!Number.isFinite(sec) || sec < 0) return "–:––";
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function DigNotesPanel({ target, player, onClose }: { target: NotesTarget; player: LocalPlayer; onClose: () => void }) {
  const t = tr(T);
  const dig = useDigger((s) => s.dig);
  const setPlaying = useDigger((s) => s.setPlaying);
  const beatNote = useAppStore((s) => (target.kind === "beat" ? s.workspace.beatNotes?.[target.beat.path] : undefined));
  const leadNote = useAppStore((s) => (target.kind === "lead" ? s.workspace.leadNotes?.[target.lead.hash] : undefined));
  const setBeatNote = useAppStore((s) => s.setBeatNote);
  const setLeadNote = useAppStore((s) => s.setLeadNote);
  const inboxItems = usePhoneInbox((s) => s.items);
  const measured = useDigger((s) => (target.kind === "beat" ? s.facts[target.beat.path] : undefined));
  const openNewProject = useAppStore((s) => s.openNewProject);
  const demoMode = useAppStore((s) => s.demoMode);

  /** "Start a song from this beat": the New song modal, prefilled. */
  function startSong(b: BeatFile) {
    const app = useAppStore.getState();
    const producer = beatProducer(b, useDigger.getState().leads, app.workspace.leadBeats, app.workspace.people);
    openNewProject({ status: "creation", name: beatSongName(b.name), fromBeat: { path: b.path, name: b.name, producer } });
  }

  let title: string;
  let facts: string[];
  let key: string;
  if (target.kind === "beat") {
    const b = target.beat;
    // Measured offline (analyze_beats), or by the dig.
    const f = measured ?? dig?.beats.find((x) => x.name === b.name);
    title = b.name;
    facts = [f?.bpm ? `${f.bpmSource === "audio" ? "≈" : ""}${t.bpm(f.bpm)}` : "", f?.key ?? "", b.folder].filter(Boolean);
    key = `beat:${b.path}`;
  } else {
    const l = target.lead;
    title = l.title;
    facts = [l.bpm != null ? t.bpm(l.bpm) : "", l.key ?? "", l.producer, l.year].filter(Boolean);
    key = `lead:${l.hash}`;
  }
  const localBeat = target.beat;
  const lead = target.kind === "lead" ? target.lead : null;
  const videoId = lead?.url ? youtubeId(lead.url) : null;

  return (
    <aside className="flex min-h-0 w-[clamp(320px,38%,460px)] shrink-0 flex-col gap-3 overflow-hidden border-l border-rule p-4" aria-label={t.title}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="flex items-center gap-1 text-xs text-engrave hover:text-cream">
          <ArrowLeft size={12} aria-hidden /> {t.back}
        </button>
        <button type="button" onClick={onClose} aria-label={t.close} title={t.close} className="ml-auto rounded p-1 text-engrave hover:bg-rule hover:text-cream">
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <span className={label}>{target.kind === "beat" ? t.beat : t.savedProd}</span>
        <h2 className="line-clamp-2 break-words font-display text-xl font-semibold uppercase leading-tight tracking-tight text-cream" title={title}>
          {title}
        </h2>
        {facts.length > 0 && <p className="truncate font-mono text-[11px] text-engrave">{facts.join(" · ")}</p>}
      </div>

      {localBeat && <LocalAudio beat={localBeat} player={player} caption={target.kind === "lead" ? t.local : null} />}
      {lead && (videoId || lead.url) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {videoId && (
            <button type="button" onClick={() => setPlaying({ id: videoId, title: lead.title })} aria-label={t.playDockTitle(lead.title)} className={`${secondary} flex items-center gap-1`}>
              <Play size={11} aria-hidden /> {t.playDock}
            </button>
          )}
          {lead.url && (
            <button type="button" onClick={() => void api.openExternal(lead.url)} aria-label={t.openTitle(lead.title)} className={`${secondary} flex items-center gap-1`}>
              <ExternalLink size={11} aria-hidden /> {t.openLink}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {localBeat && !demoMode && (
          <button type="button" title={t.startSongTitle} onClick={() => startSong(localBeat)} className={`${secondary} flex items-center gap-1`}>
            <Plus size={11} aria-hidden /> {t.startSong}
          </button>
        )}
        <button
          type="button"
          title={t.sessionTitle}
          className={`${secondary} flex items-center gap-1`}
          onClick={() =>
            void openSession(
              target.kind === "beat"
                ? { kind: "beat", id: target.beat.path, title, bpm: dig?.beats.find((x) => x.name === target.beat.name)?.bpm ?? null }
                : { kind: "prod", id: target.lead.hash, title, bpm: target.lead.bpm ?? null },
            ).catch(() => {})
          }
        >
          <MonitorPlay size={11} aria-hidden /> {t.session}
        </button>
      </div>

      <PhoneMemos memos={target.kind === "beat" ? memosFor(inboxItems, "beat", target.beat.path) : memosFor(inboxItems, "prod", target.lead.hash)} />

      <div className="flex min-h-0 flex-1 flex-col border-t border-rule pt-3">
        <NotesEditor
          key={key}
          fill
          value={target.kind === "beat" ? beatNote : leadNote}
          onChange={(text) => (target.kind === "beat" ? setBeatNote(target.beat.path, text) : setLeadNote(target.lead.hash, text))}
        />
      </div>
    </aside>
  );
}

function LocalAudio({ beat, player, caption }: { beat: BeatFile; player: LocalPlayer; caption: string | null }) {
  const t = tr(T);
  const isPlaying = player.playing === beat.path;
  const loaded = player.loaded === beat.path;
  const duration = loaded && Number.isFinite(player.duration) ? player.duration : 0;
  const time = loaded ? player.time : 0;
  return (
    <div className="flex flex-col gap-1">
      {caption && <span className={label}>{caption}</span>}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => player.toggle(beat)}
          aria-label={isPlaying ? t.pause(beat.name) : t.play(beat.name)}
          className="shrink-0 rounded-full border border-rule-strong p-2 text-cream hover:border-hot"
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(time, duration || 1)}
          disabled={!duration}
          onChange={(e) => player.seek(Number(e.target.value))}
          aria-label={t.seek}
          className="min-w-0 flex-1 accent-[var(--color-cream)] disabled:opacity-40"
        />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-engrave">
          {clock(time)} / {duration ? clock(duration) : "–:––"}
        </span>
      </div>
    </div>
  );
}
