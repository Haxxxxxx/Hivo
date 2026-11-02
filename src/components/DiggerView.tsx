import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Check, FolderPlus, NotebookPen, Pause, Play, RefreshCw, Search, Shovel, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { MAX_PICKS, filterBeats, useDigger } from "../store/useDigger";
import * as api from "../lib/tauri";
import { audioSrc } from "../lib/tauri";
import { formatBytes, formatRelative } from "../lib/format";
import { matchBeat, sortBeats, type BeatSort } from "../lib/digger";
import { isFileDrag } from "../lib/dropGuard";
import { dict, tr } from "../i18n";
import type { BeatFile, YoutubeStatus } from "../types";
import { DigPanel } from "./DigPanel";
import { DigResults } from "./DigResults";
import { SavedLeads } from "./SavedLeads";
import { DigNotesPanel, type LocalPlayer, type NotesTarget } from "./DigNotesPanel";

// The Digger: your raw beats (Settings → Beats folders). Pick up to 5 and dig
// the web for similar ones to start a new song on (DigPanel). Once a dig or a
// search exists, the main area splits: beats on top, results below
// (DigResults). Selecting a beat or a saved prod (a click on its row) swaps
// the right column for its notes (DigNotesPanel) until ✕, "Back to dig" or Esc.

const NB = " ";
// A stable empty list: a fresh [] in a store selector re-renders forever.
const NO_FOLDERS: string[] = [];
const tabClass = (on: boolean) =>
  `rounded border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.14em] ${on ? "border-cream bg-cream text-chassis" : "border-rule-strong text-engrave hover:text-cream"}`;

const T = dict(
  {
    title: "Digger",
    sub: "Your raw beats. Pick up to 5 and dig for similar ones to start a new song.",
    noFolder: "No beats folder yet. Add the folder where you keep your downloaded beats.",
    addFolder: "Add a beats folder",
    empty: "No beats found in your beats folders (mp3, wav, ogg, flac or m4a).",
    shownOf: (n: number, total: number, more: boolean) => `${n} of ${total}${more ? "+" : ""} beats shown`,
    ignored: (n: number) => `${n} audio file${n > 1 ? "s" : ""} in other formats (opus, aac…) can't be read`,
    sort: "Sort",
    sortNewest: "Newest",
    sortName: "Name",
    sortBpm: "BPM",
    sortKey: "Key",
    analysing: "Measuring tempo and key…",
    estimated: "Estimated from the audio (may be half or double)",
    filter: "Search beats",
    rescan: "Look again",
    picked: (n: number) => `${n}/${MAX_PICKS} picked`,
    clear: "Clear",
    full: `${MAX_PICKS} beats max: unpick one first.`,
    play: (name: string) => `Play ${name}`,
    pause: (name: string) => `Pause ${name}`,
    pick: (name: string) => `Pick ${name}`,
    loading: "Looking for beats…",
    dropped: "Dropping files doesn't add them. Put the beat in one of your beats folders (Settings), tick it here, then tick \"Let Gemini listen\" and Dig.",
    dismiss: "Dismiss",
    tabBeats: "Your beats",
    tabSaved: (n: number) => `Saved prods · ${n}`,
    hasNotes: "Has notes",
    openNotes: (name: string) => `Notes on ${name}`,
  },
  {
    title: "Digger",
    sub: "Tes prods brutes. Choisis-en jusqu'à 5 et pars à la recherche de prods dans le même esprit pour un nouveau son.",
    noFolder: "Pas encore de dossier de prods. Ajoute le dossier où tu ranges les prods que tu télécharges.",
    addFolder: "Ajouter un dossier de prods",
    empty: "Aucune prod trouvée dans tes dossiers de prods (mp3, wav, ogg, flac ou m4a).",
    shownOf: (n: number, total: number, more: boolean) => `${n} prods affichées sur ${total}${more ? "+" : ""}`,
    ignored: (n: number) => `${n} fichier${n > 1 ? "s" : ""} audio dans d'autres formats (opus, aac…) illisible${n > 1 ? "s" : ""}`,
    sort: "Trier",
    sortNewest: "Récentes",
    sortName: "Nom",
    sortBpm: "BPM",
    sortKey: "Tonalité",
    analysing: "Mesure du tempo et de la tonalité…",
    estimated: "Estimé à partir de l'audio (peut être la moitié ou le double)",
    filter: "Chercher une prod",
    rescan: "Relancer",
    picked: (n: number) => `${n}/${MAX_PICKS} choisies`,
    clear: "Vider",
    full: `${MAX_PICKS} prods max${NB}: retires-en une d'abord.`,
    play: (name: string) => `Écouter ${name}`,
    pause: (name: string) => `Pause ${name}`,
    pick: (name: string) => `Choisir ${name}`,
    loading: "Recherche des prods…",
    dropped: `Glisser un fichier ne l'ajoute pas. Mets la prod dans un de tes dossiers de prods (Réglages), coche-la ici, puis coche «${NB}Faire écouter à Gemini${NB}» et Creuse.`,
    dismiss: "Fermer",
    tabBeats: "Tes prods",
    tabSaved: (n: number) => `Prods enregistrées · ${n}`,
    hasNotes: "A des notes",
    openNotes: (name: string) => `Notes sur ${name}`,
  },
);

/** The row whose notes are open: a beat (its path) or a saved prod (its url hash). */
type Selection = { kind: "beat"; path: string } | { kind: "lead"; hash: string };

export function DiggerView() {
  const t = tr(T);
  const folders = useAppStore((s) => s.settings.beatFolders ?? NO_FOLDERS);
  const addBeatFolder = useAppStore((s) => s.addBeatFolder);
  const { beats, loading, error, picked, query, load, loadLeads, toggle, clearPicks, setQuery, dig, webQuery, searchedFor, searching, clearUnseen, shownRound, setShownRound, restoreLastDig, scanInfo, facts, analysing } = useDigger();
  const leadBeats = useAppStore((s) => s.workspace.leadBeats);
  const [sort, setSort] = useState<BeatSort>("newest");
  const [playing, setPlaying] = useState<string | null>(null);
  // The beat in the <audio> element (playing or paused) and where it is.
  const [loaded, setLoaded] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const beatNotes = useAppStore((s) => s.workspace.beatNotes);
  const leads = useDigger((s) => s.leads);
  // The row whose notes are open in the right column (null: the dig panel).
  const [selected, setSelected] = useState<Selection | null>(null);
  const [yt, setYt] = useState<YoutubeStatus | null>(null);
  // The top block shows the beats to pick from, or the saved prods.
  const [tab, setTab] = useState<"beats" | "saved">("beats");
  const leadCount = useDigger((s) => s.leads.length);
  // The results section is always there (its search box is the only way to
  // search YouTube); it takes its share of the height once it has something.
  const showResults = !!dig || searchedFor !== null || searching || webQuery.trim() !== "";
  const audio = useRef<HTMLAudioElement>(null);
  const shown = useMemo(() => sortBeats(filterBeats(beats, query), facts, sort), [beats, query, facts, sort]);
  const full = picked.length >= MAX_PICKS;
  const folderKey = folders.join("|");
  const [dropHint, setDropHint] = useState(false);

  // dropGuard.ts refuses the drop itself; here we say what to do instead.
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      if (isFileDrag(e.dataTransfer?.types)) setDropHint(true);
    };
    window.addEventListener("drop", onDrop);
    return () => window.removeEventListener("drop", onDrop);
  }, []);

  useEffect(() => {
    if (folderKey) void load();
    // The saved leads (DigResults' "Saved" chips) live in the same folders.
    void loadLeads();
  }, [folderKey, load, loadLeads]);

  // A dig that finished while another view was open has been seen now.
  useEffect(() => {
    clearUnseen();
  }, [clearUnseen]);

  // The last dig, kept across restarts.
  useEffect(() => {
    void restoreLastDig();
  }, [restoreLastDig]);

  useEffect(() => {
    let live = true;
    api.youtubeStatus().then((s) => live && setYt(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Esc closes the notes panel (not while a text field handles its own Esc).
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof HTMLInputElement && e.target.type !== "checkbox") return;
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const target = useMemo<NotesTarget | null>(() => {
    if (!selected) return null;
    if (selected.kind === "beat") {
      const beat = beats.find((b) => b.path === selected.path);
      return beat ? { kind: "beat", beat } : null;
    }
    const lead = leads.find((l) => l.hash === selected.hash);
    return lead ? { kind: "lead", lead, beat: matchBeat(lead, beats, leadBeats?.[lead.hash]) } : null;
  }, [selected, beats, leads, leadBeats]);

  const playToggle = (b: BeatFile) => {
    const el = audio.current;
    if (!el) return;
    if (playing === b.path) {
      el.pause();
      setPlaying(null);
      return;
    }
    // The same beat paused: carry on from where it stopped.
    if (loaded !== b.path) {
      el.src = audioSrc(b.path);
      setLoaded(b.path);
      setTime(0);
      setDuration(0);
    }
    void el.play().catch(() => setPlaying(null));
    setPlaying(b.path);
  };

  const player: LocalPlayer = {
    loaded,
    playing,
    time,
    duration,
    toggle: playToggle,
    seek: (sec) => {
      const el = audio.current;
      if (!el || !loaded) return;
      el.currentTime = sec;
      setTime(sec);
    },
  };

  /** A click on a row selects it, unless it lands on one of its controls. */
  const selectRow = (e: MouseEvent, sel: Selection) => {
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, label")) return;
    setSelected(sel);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <audio
        ref={audio}
        onEnded={() => setPlaying(null)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        className="hidden"
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-6 py-3">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 font-display text-3xl uppercase leading-none tracking-tight text-cream">
            <Shovel size={22} aria-hidden /> {t.title}
          </h1>
          <p className="mt-1 text-xs text-engrave">{t.sub}</p>
        </div>
        {folders.length > 0 && (
          <>
            <label className="flex items-center gap-1.5 rounded-md border border-rule bg-chassis px-2 py-1 text-xs focus-within:border-hot">
              <Search size={12} className="text-engrave" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                placeholder={t.filter}
                aria-label={t.filter}
                className="w-44 bg-transparent text-cream placeholder:text-engrave focus:outline-none"
              />
            </label>
            <button onClick={() => void load()} disabled={loading} title={t.rescan} aria-label={t.rescan} className="rounded p-1.5 text-engrave hover:bg-rule hover:text-cream disabled:opacity-40">
              <RefreshCw size={14} className={loading ? "motion-safe:animate-spin" : ""} />
            </button>
          </>
        )}
      </div>

      {dropHint && (
        <div role="status" className="mx-6 mt-3 flex items-start gap-3 rounded-md border border-rule-strong bg-raised px-3 py-2 text-xs text-cream">
          <span className="flex-1">{t.dropped}</span>
          <button onClick={() => setDropHint(false)} aria-label={t.dismiss} className="shrink-0 text-engrave hover:text-cream">
            <X size={14} />
          </button>
        </div>
      )}

      {folders.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="max-w-md text-sm text-body">{t.noFolder}</p>
          <button onClick={() => void addBeatFolder()} className="flex items-center gap-2 rounded bg-hot px-4 py-2 font-display text-[15px] font-bold uppercase tracking-[0.06em] text-chassis hover:bg-hot-hover">
            <FolderPlus size={15} /> {t.addFolder}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="@container flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className={`flex flex-col overflow-hidden ${showResults ? "min-h-[160px] basis-[40%]" : "min-h-0 flex-1"}`}>
              <div className="flex flex-wrap items-center gap-3 border-b border-rule px-6 py-2 text-xs">
                <div role="tablist" className="flex items-center gap-1.5">
                  <button role="tab" aria-selected={tab === "beats"} onClick={() => setTab("beats")} className={tabClass(tab === "beats")}>
                    {t.tabBeats}
                  </button>
                  <button role="tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")} className={tabClass(tab === "saved")}>
                    {t.tabSaved(leadCount)}
                  </button>
                </div>
                {tab === "beats" && (
                  <>
                    <span className={picked.length ? "text-cream" : "text-engrave"}>{t.picked(picked.length)}</span>
                    {picked.length > 0 && (
                      <button onClick={clearPicks} className="text-engrave underline hover:text-cream">
                        {t.clear}
                      </button>
                    )}
                    {full && <span className="text-engrave">{t.full}</span>}
                    {scanInfo?.capped && <span className="text-warn">{t.shownOf(beats.length, scanInfo.total, scanInfo.capped)}</span>}
                    {!!scanInfo?.ignored && <span className="text-engrave">{t.ignored(scanInfo.ignored)}</span>}
                    {analysing && <span className="text-engrave">{t.analysing}</span>}
                    <label className="ml-auto flex items-center gap-1 text-engrave">
                      {t.sort}
                      <select value={sort} onChange={(e) => setSort(e.target.value as BeatSort)} className="rounded border border-rule bg-chassis px-1 py-0.5 text-cream">
                        <option value="newest">{t.sortNewest}</option>
                        <option value="name">{t.sortName}</option>
                        <option value="bpm">{t.sortBpm}</option>
                        <option value="key">{t.sortKey}</option>
                      </select>
                    </label>
                  </>
                )}
              </div>
              {error && <div role="alert" className="mx-6 mt-3 rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">{error}</div>}
              <div className="flex-1 overflow-y-auto px-4 py-2">
                {tab === "saved" ? (
                  <SavedLeads
                    beats={beats}
                    playingBeat={playing}
                    onPlayBeat={playToggle}
                    selected={selected?.kind === "lead" ? selected.hash : null}
                    onSelect={(hash, e) => (e ? selectRow(e, { kind: "lead", hash }) : setSelected({ kind: "lead", hash }))}
                  />
                ) : loading && beats.length === 0 ? (
                  <p className="p-4 text-sm text-engrave">{t.loading}</p>
                ) : shown.length === 0 ? (
                  <p className="p-4 text-sm text-engrave">{t.empty}</p>
                ) : (
                  <ul className="flex flex-col gap-px" aria-label={t.title}>
                    {shown.map((b) => {
                      const on = picked.includes(b.path);
                      const disabled = !on && full;
                      const sel = selected?.kind === "beat" && selected.path === b.path;
                      const hasNote = !!beatNotes?.[b.path];
                      const f = facts[b.path];
                      return (
                        <li
                          key={b.path}
                          onClick={(e) => selectRow(e, { kind: "beat", path: b.path })}
                          className={`flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 ${sel ? "bg-raised ring-1 ring-cream" : on ? "bg-raised ring-1 ring-hot/40" : "hover:bg-raised"}`}
                        >
                          <button
                            onClick={() => playToggle(b)}
                            aria-label={playing === b.path ? t.pause(b.name) : t.play(b.name)}
                            className="shrink-0 rounded-full border border-rule-strong p-1.5 text-cream hover:border-hot"
                          >
                            {playing === b.path ? <Pause size={12} /> : <Play size={12} />}
                          </button>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={disabled}
                            onChange={() => toggle(b.path)}
                            aria-label={t.pick(b.name)}
                            className={`accent-orange-500 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                          />
                          <button
                            type="button"
                            onClick={() => setSelected({ kind: "beat", path: b.path })}
                            aria-label={t.openNotes(b.name)}
                            aria-pressed={sel}
                            className={`min-w-0 flex-1 text-left ${disabled ? "opacity-50" : ""}`}
                          >
                            <span title={b.name} className="block truncate text-sm text-cream">{b.name}</span>
                            <span className="block truncate font-mono text-[10.5px] text-engrave">{b.folder}</span>
                          </button>
                          {hasNote && (
                            <span title={t.hasNotes} className="shrink-0 text-body">
                              <NotebookPen size={12} aria-label={t.hasNotes} />
                            </span>
                          )}
                          <span className="w-16 shrink-0 text-right font-mono text-[11px] text-body" title={f?.bpmSource === "audio" ? t.estimated : undefined}>
                            {f?.bpm ? `${f.bpmSource === "audio" ? "≈" : ""}${Math.round(f.bpm)} BPM` : ""}
                          </span>
                          <span className="w-10 shrink-0 font-mono text-[11px] text-body">{f?.key ?? ""}</span>
                          <span className="hidden shrink-0 text-xs text-engrave lg:inline">{formatRelative(b.modifiedAtMs)}</span>
                          <span className="w-16 shrink-0 text-right font-mono text-[11px] text-engrave">{formatBytes(b.sizeBytes)}</span>
                          {on && <Check size={14} className="shrink-0 text-hot" aria-hidden />}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
            <DigResults yt={yt} round={shownRound} setRound={setShownRound} fill={showResults} />
          </div>
          {target ? <DigNotesPanel target={target} player={player} onClose={() => setSelected(null)} /> : <DigPanel yt={yt} round={shownRound} />}
        </div>
      )}
    </div>
  );
}
