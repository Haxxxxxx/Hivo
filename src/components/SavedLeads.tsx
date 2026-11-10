import { useMemo, useRef, useState, type MouseEvent } from "react";
import { Check, Copy, ExternalLink, FolderOpen, NotebookPen, Pause, Play } from "lucide-react";
import { useDigger } from "../store/useDigger";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { prodMatch, youtubeId } from "../lib/digger";
import { formatRelative } from "../lib/format";
import { dict, tr } from "../i18n";
import type { BeatFile, ProdFile, SavedLead } from "../types";
import { ConfirmButton } from "../ui";
import { ConvertButton, LikeChip, chip, secondary } from "./DigResults";

// The Digger's "Saved prods" tab: every lead saved with "Save to Prods"
// (the text files in the beats folders' `_leads`), newest first, with the
// facts read back from the file. A lead plays again in the docked YouTube
// player; a file in the beats folders whose name matches the title is shown
// as "In your prods" and plays locally. A click on a row opens its notes in
// the Digger's right column (DigNotesPanel). Nothing here downloads anything.

const NB = " ";
const T = dict(
  {
    title: "Saved prods",
    empty: "Nothing saved yet. \"Save to Prods\" on a result keeps its link and facts here, across sessions.",
    downloadedHint: "A beat you downloaded into a beats folder (WAV, MP3, FLAC, OGG, M4A or AIFF) shows up as \"In your prods\" when its file name matches the title. Wrong or missing? Link it by hand.",
    inProds: "In your prods",
    inDownloads: "In your prods (Downloads)",
    foundAt: (path: string) => `Found at ${path}`,
    moveToBeats: "Move to beats folder",
    moveTitle: (name: string) => `Move ${name} from Downloads into your first beats folder`,
    lookInDownloads: "Also look in Downloads",
    lookInDownloadsHint: "Finds prods a converter saved to Downloads, by file name only: nothing is opened. Your computer may ask to allow it once.",
    downloadsUnreadable: "Downloads couldn't be read: allow Hivo in the system settings (Privacy → Files and folders on a Mac).",
    playBeat: (name: string) => `Play ${name}`,
    pauseBeat: (name: string) => `Pause ${name}`,
    play: "Play",
    playTitle: (title: string) => `Play ${title}`,
    open: "Open",
    openTitle: (title: string) => `Open ${title} in the browser`,
    showFile: "Show file",
    remove: "Remove",
    confirmRemove: "Delete the lead file?",
    noLink: "The file has no https link any more.",
    link: "Video link",
    copyLink: "Copy link",
    copied: "Copied",
    copyManual: "Selected: press ⌘C / Ctrl+C",
    savedOn: (when: string) => `Saved ${when}`,
    bpm: (n: number) => `${Math.round(n)} BPM`,
    hasNotes: "Has notes",
    notes: "Notes",
    openNotes: (title: string) => `Notes on ${title}`,
    notThis: "Not this beat",
    notThisTitle: (name: string) => `${name} isn't this prod: stop showing it as "In your prods".`,
    linkedByHand: "Linked by you",
    unlinkedByHand: "Marked as not in your prods",
    resetLink: "Match by name again",
    linkBeat: "This is one of my beats…",
    linkBeatLabel: (title: string) => `Pick the beat file that is ${title}`,
    unrecognised: "Not a lead file Hivo can read (renamed, edited or copied). Show it to fix it, or delete it.",
  },
  {
    title: "Prods enregistrées",
    empty: "Rien d'enregistré pour l'instant. « Garder dans mes prods » sur un résultat garde son lien et ses infos ici, d'une session à l'autre.",
    downloadedHint: `Une prod que tu as téléchargée dans un dossier de prods (WAV, MP3, FLAC, OGG, M4A ou AIFF) apparaît comme « Dans tes prods » quand le nom du fichier correspond au titre. Erreur ou oubli${NB}? Relie-la à la main.`,
    inProds: "Dans tes prods",
    inDownloads: "Dans tes prods (Téléchargements)",
    foundAt: (path: string) => `Trouvée ici${NB}: ${path}`,
    moveToBeats: "Ranger dans le dossier de prods",
    moveTitle: (name: string) => `Déplacer ${name} de Téléchargements vers ton premier dossier de prods`,
    lookInDownloads: "Chercher aussi dans Téléchargements",
    lookInDownloadsHint: `Retrouve les prods qu'un convertisseur a mises dans Téléchargements, par le nom du fichier seulement${NB}: rien n'est ouvert. Ton ordi peut demander l'autorisation une fois.`,
    downloadsUnreadable: `Téléchargements n'a pas pu être lu${NB}: autorise Hivo dans les réglages du système (Confidentialité → Fichiers et dossiers sur Mac).`,
    playBeat: (name: string) => `Écouter ${name}`,
    pauseBeat: (name: string) => `Pause ${name}`,
    play: "Écouter",
    playTitle: (title: string) => `Écouter ${title}`,
    open: "Ouvrir",
    openTitle: (title: string) => `Ouvrir ${title} dans le navigateur`,
    showFile: "Voir le fichier",
    remove: "Retirer",
    confirmRemove: "Supprimer le fichier de la prod ?",
    noLink: "Le fichier n'a plus de lien https.",
    link: "Lien de la vidéo",
    copyLink: "Copier le lien",
    copied: "Copié",
    copyManual: "Sélectionné : fais ⌘C / Ctrl+C",
    savedOn: (when: string) => `Enregistrée ${when}`,
    bpm: (n: number) => `${Math.round(n)} BPM`,
    hasNotes: "A des notes",
    notes: "Notes",
    openNotes: (title: string) => `Notes sur ${title}`,
    notThis: "Pas cette prod",
    notThisTitle: (name: string) => `${name} n'est pas cette prod${NB}: ne plus l'afficher « Dans tes prods ».`,
    linkedByHand: "Reliée par toi",
    unlinkedByHand: "Marquée comme pas dans tes prods",
    resetLink: "Comparer par le nom à nouveau",
    linkBeat: "C'est une de mes prods…",
    linkBeatLabel: (title: string) => `Choisis le fichier de prod qui est ${title}`,
    unrecognised: `Pas un fichier de prod que Hivo sait lire (renommé, modifié ou copié). Affiche-le pour le corriger, ou supprime-le.`,
  },
);

/** Beats offered in the "This is one of my beats…" list, at most. */
const MAX_LINK_OPTIONS = 500;

interface Props {
  beats: BeatFile[];
  /** The beat the Digger's own audio element is playing (its path). */
  playingBeat: string | null;
  onPlayBeat: (beat: BeatFile) => void;
  /** The saved prod whose notes are open (its url hash). */
  selected: string | null;
  /** Open a row's notes: from a click on the row (`e`: DiggerView ignores
   * clicks on its controls) or from its Notes button (no `e`). */
  onSelect: (hash: string, e?: MouseEvent) => void;
}

export function SavedLeads({ beats, playingBeat, onPlayBeat, selected, onSelect }: Props) {
  const t = tr(T);
  const leads = useDigger((s) => s.leads);
  const leadError = useDigger((s) => s.leadError);
  const leadBeats = useAppStore((s) => s.workspace.leadBeats);
  const lookInDownloads = useAppStore((s) => !!s.settings.prodMatchDownloads);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const prodScan = useDigger((s) => s.prodScan);
  const moveError = useDigger((s) => s.moveError);
  const reload = useDigger((s) => s.load);
  const files = prodScan?.files ?? [];
  const byName = useMemo(() => beats.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LINK_OPTIONS), [beats]);

  return (
    <div className="flex flex-col gap-2" aria-label={t.title}>
      {leadError && <div role="alert" className="rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">{leadError}</div>}
      {leads.length === 0 ? (
        <p className="p-4 text-sm text-engrave">{t.empty}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {leads.map((lead) => {
              if (lead.unrecognised) return <UnrecognisedRow key={lead.path} lead={lead} />;
              const found = prodMatch(lead, beats, files, leadBeats?.[lead.hash]);
              return (
              <LeadRow
                key={lead.path}
                lead={lead}
                beat={found?.beat ?? null}
                file={found?.file ?? null}
                manual={leadBeats?.[lead.hash]}
                linkable={byName}
                playingBeat={playingBeat}
                onPlayBeat={onPlayBeat}
                selected={selected === lead.hash}
                onSelect={(e) => onSelect(lead.hash, e)}
              />
              );
            })}
          </ul>
          {moveError && <div role="alert" className="rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">{moveError}</div>}
          <p className="px-1 text-[11px] text-engrave">{t.downloadedHint}</p>
          <label className="flex cursor-pointer items-start gap-2 px-1 text-xs text-body">
            <input
              type="checkbox"
              checked={lookInDownloads}
              onChange={(e) => void updateSettings({ prodMatchDownloads: e.target.checked }).then(() => reload())}
              className="mt-0.5 accent-orange-500"
            />
            <span>
              {t.lookInDownloads}
              <span className="block text-[11px] text-engrave">{t.lookInDownloadsHint}</span>
            </span>
          </label>
          {lookInDownloads && prodScan?.downloadsUnreadable && <p className="px-1 text-[11px] text-warn">{t.downloadsUnreadable}</p>}
        </>
      )}
    </div>
  );
}

/** Copying the raw video address: the button sits in the actions row (left
 * of Convert), the address itself is shown as text; when the clipboard is
 * refused the address is selected, ready for ⌘C. */
function useCopyLink(url: string) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const field = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
      window.setTimeout(() => setState("idle"), 3000);
    } catch {
      setState("manual");
      window.setTimeout(() => field.current?.select(), 0);
    }
  };
  return { state, field, copy };
}

/** The main action's look (orange), same shape as the other row buttons. */
const primary = "rounded bg-hot px-2.5 py-1.5 text-xs font-semibold text-chassis hover:bg-hot-hover";

/** A `.md` in `_leads` that doesn't read as a lead: shown, revealable, deletable. */
function UnrecognisedRow({ lead }: { lead: SavedLead }) {
  const t = tr(T);
  const deleteLead = useDigger((s) => s.deleteLead);
  return (
    <li className="flex flex-col gap-1.5 rounded border border-dashed border-rule bg-panel px-3 py-2">
      <span className="truncate text-sm text-body" title={lead.path}>
        {lead.title}.md
      </span>
      <p className="text-[11px] text-engrave">{t.unrecognised}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => void api.revealInFileManager(lead.path)} className={`${secondary} flex items-center gap-1`}>
          <FolderOpen size={11} aria-hidden /> {t.showFile}
        </button>
        <ConfirmButton label={t.remove} confirmLabel={t.confirmRemove} onConfirm={() => void deleteLead(lead.path)} className="ml-auto text-xs text-engrave hover:text-missing" />
      </div>
    </li>
  );
}

interface RowProps {
  lead: SavedLead;
  beat: BeatFile | null;
  /** No beat in the list, but a file that confirms it (AIFF in a beats folder, or Downloads). */
  file: ProdFile | null;
  /** The user's own link (`Workspace.leadBeats`): a path, null, or none. */
  manual: string | null | undefined;
  linkable: BeatFile[];
  playingBeat: string | null;
  onPlayBeat: (b: BeatFile) => void;
  selected: boolean;
  onSelect: (e?: MouseEvent) => void;
}

function LeadRow({ lead, beat, file, manual, linkable, playingBeat, onPlayBeat, selected, onSelect }: RowProps) {
  const t = tr(T);
  const moveProdToBeats = useDigger((s) => s.moveProdToBeats);
  const [moving, setMoving] = useState(false);
  const setLeadBeat = useAppStore((s) => s.setLeadBeat);
  const setPlaying = useDigger((s) => s.setPlaying);
  const deleteLead = useDigger((s) => s.deleteLead);
  const hasNote = useAppStore((s) => !!s.workspace.leadNotes?.[lead.hash]);
  const id = lead.url ? youtubeId(lead.url) : null;
  const link = useCopyLink(lead.url);
  const facts = [
    lead.producer,
    lead.year,
    lead.bpm != null ? t.bpm(lead.bpm) : "",
    lead.key ?? "",
    t.savedOn(lead.savedOn || formatRelative(lead.modifiedAtMs)),
  ].filter(Boolean);
  const localPlaying = !!beat && playingBeat === beat.path;

  return (
    <li onClick={(e) => onSelect(e)} className={`flex cursor-pointer flex-col gap-1.5 rounded border px-3 py-2 ${selected ? "border-cream bg-raised" : "border-rule bg-panel hover:bg-raised"}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm text-cream" title={lead.title}>
              {lead.title}
            </span>
            {hasNote && (
              <span title={t.hasNotes} className="shrink-0 text-body">
                <NotebookPen size={12} aria-label={t.hasNotes} />
              </span>
            )}
            {beat && (
              <span className={`${chip(true)} shrink-0 whitespace-nowrap`} title={beat.path}>
                {t.inProds}
              </span>
            )}
            {file && (
              <span className={`${chip(true)} shrink-0 whitespace-nowrap`} title={t.foundAt(file.path)}>
                {file.place === "downloads" ? t.inDownloads : t.inProds}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-engrave">
            {beat && manual === undefined && (
              <button type="button" onClick={() => setLeadBeat(lead.hash, null)} title={t.notThisTitle(beat.name)} className="underline hover:text-cream">
                {t.notThis}
              </button>
            )}
            {manual !== undefined && (
              <>
                <span>{manual === null ? t.unlinkedByHand : t.linkedByHand}</span>
                <button type="button" onClick={() => setLeadBeat(lead.hash, undefined)} className="underline hover:text-cream">
                  {t.resetLink}
                </button>
              </>
            )}
            {!beat && !file && linkable.length > 0 && (
              <select
                value=""
                onChange={(e) => e.target.value && setLeadBeat(lead.hash, e.target.value)}
                aria-label={t.linkBeatLabel(lead.title)}
                className="max-w-[16rem] rounded border border-rule bg-chassis px-1 py-0.5 text-body"
              >
                <option value="">{t.linkBeat}</option>
                {linkable.map((b) => (
                  <option key={b.path} value={b.path}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="truncate text-[11px] text-engrave">{facts.join(" · ")}</div>
          {lead.traits.length > 0 && <div className="truncate text-[11px] text-body">{lead.traits.join(" · ")}</div>}
          {lead.summary && <p className="mt-1 line-clamp-2 text-xs text-body">{lead.summary}</p>}
          {lead.url ? (
            <input
              ref={link.field}
              readOnly
              value={lead.url}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={t.link}
              className="mt-1 w-full bg-transparent font-mono text-[11px] text-engrave focus:text-cream focus:outline-none"
            />
          ) : (
            <p className="mt-1 text-[11px] text-engrave">{t.noLink}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {beat && (
          <button
            type="button"
            onClick={() => onPlayBeat(beat)}
            aria-label={localPlaying ? t.pauseBeat(beat.name) : t.playBeat(beat.name)}
            title={beat.name}
            className="shrink-0 rounded-full border border-rule-strong p-1.5 text-cream hover:border-hot"
          >
            {localPlaying ? <Pause size={12} /> : <Play size={12} />}
          </button>
        )}
        {file?.place === "downloads" && (
          <button
            type="button"
            disabled={moving}
            onClick={() => {
              setMoving(true);
              void moveProdToBeats(file.path).finally(() => setMoving(false));
            }}
            title={t.moveTitle(file.name)}
            className={`${secondary} flex items-center gap-1 disabled:opacity-40`}
          >
            <FolderOpen size={11} aria-hidden /> {t.moveToBeats}
          </button>
        )}
        {id && (
          <button type="button" onClick={() => setPlaying({ id, title: lead.title })} aria-label={t.playTitle(lead.title)} className={`${secondary} flex items-center gap-1`}>
            <Play size={11} aria-hidden /> {t.play}
          </button>
        )}
        {lead.url && (
          <button type="button" onClick={() => void api.openExternal(lead.url)} aria-label={t.openTitle(lead.title)} className={`${secondary} flex items-center gap-1`}>
            <ExternalLink size={11} aria-hidden /> {t.open}
          </button>
        )}
        {lead.url && (
          <button type="button" onClick={() => void link.copy()} aria-label={t.copyLink} className={`${primary} flex items-center gap-1`}>
            {link.state === "copied" ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
            {link.state === "copied" ? t.copied : link.state === "manual" ? t.copyManual : t.copyLink}
          </button>
        )}
        {lead.url && <ConvertButton url={lead.url} />}
        {lead.url && <LikeChip id={id ?? lead.url} title={lead.title} />}
        <button type="button" onClick={() => onSelect()} aria-label={t.openNotes(lead.title)} aria-pressed={selected} className={`${secondary} flex items-center gap-1`}>
          <NotebookPen size={11} aria-hidden /> {t.notes}
        </button>
        <button type="button" onClick={() => void api.revealInFileManager(lead.path)} className={`${secondary} flex items-center gap-1`}>
          <FolderOpen size={11} aria-hidden /> {t.showFile}
        </button>
        <ConfirmButton label={t.remove} confirmLabel={t.confirmRemove} onConfirm={() => void deleteLead(lead.path)} className="ml-auto text-xs text-engrave hover:text-missing" />
      </div>
    </li>
  );
}
