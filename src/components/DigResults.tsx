import { useMemo, useState } from "react";
import { ExternalLink, Play, Search, X } from "lucide-react";
import { useDigger, type Playing } from "../store/useDigger";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { MAX_LIKED, MAX_QUERY_CHARS, canonicalUrl, converterLink, converterNeedsPaste, embedUrl, googleSearchUrl, leadFacts, leadHash, seedList, youtubeId, youtubeSearchUrl } from "../lib/digger";
import { dict, tr } from "../i18n";
import type { Lead, WebLink, YoutubeStatus } from "../types";

// The bottom of the Digger's main area once a dig (or a search) exists: the
// round breadcrumb and the YouTube search in the header, the docked player,
// the shown round's YouTube results as a grid of cards, then its web links.
// Every card and link has a "Use for next dig" toggle: the picks seed the
// next "Go deeper" round. "Save to Prods" writes a small text file (link,
// title, the dig's facts) into the beats folder's `_leads`, never audio.
// YouTube links play in YouTube's own embedded player (one at a time). The
// optional "Convert" button only opens the user's own converter link in the
// browser. Links only: nothing is ever downloaded (docs/GUARDRAILS.md).

const NB = " ";
const T = dict(
  {
    title: "Results",
    rounds: "Rounds",
    dig: "Dig",
    round: (n: number) => `Round ${n}`,
    showRound: (name: string) => `Show ${name}`,
    play: (title: string) => `Play ${title}`,
    playShort: "Play",
    player: "YouTube player",
    closePlayer: "Close the player",
    search: "Search",
    searchLabel: "Search YouTube for beats",
    placeholder: "e.g. dark trap type beat",
    open: "Open on YouTube",
    openVideo: (title: string) => `Open ${title} on YouTube`,
    searching: "Searching…",
    noResults: "No results. Try other words.",
    web: "Found on the web",
    youtubeFor: (q: string) => `YouTube · ${q}`,
    googled: "Google searches behind these links",
    openLink: (site: string) => `Open ${site}`,
    like: "Use for next dig",
    likeFull: `${MAX_LIKED} picks max for the next dig. Unpick one first.`,
    seededFrom: (list: string) => `Seeded from: ${list}`,
    save: "Save to Prods",
    saving: "Saving…",
    saved: "Saved",
    savedTitle: "Saved in your beats folder (_leads). Click to show the file.",
    convert: "Convert",
    convertTitle: "Opens your converter link in the browser with this video's address. Hivo never downloads audio.",
    convertPasteTitle: "Opens your converter page in the browser and copies this video's address: paste it there. Hivo never downloads audio.",
    copied: "Address copied. Paste it on the page.",
    copyFailed: (url: string) => `Couldn't copy. Paste this on the page: ${url}`,
    unresolved: "Google's link couldn't be followed to the page: open it to see where it goes. It can't be saved or converted.",
    hint: "Opens in your browser. Leasing a beat stays between you and the producer: the Digger downloads nothing.",
  },
  {
    title: "Résultats",
    rounds: "Tours",
    dig: "Creuser",
    round: (n: number) => `Tour ${n}`,
    showRound: (name: string) => `Afficher ${name}`,
    play: (title: string) => `Écouter ${title}`,
    playShort: "Écouter",
    player: "Lecteur YouTube",
    closePlayer: "Fermer le lecteur",
    search: "Chercher",
    searchLabel: "Chercher des prods sur YouTube",
    placeholder: "ex. dark trap type beat",
    open: "Ouvrir sur YouTube",
    openVideo: (title: string) => `Ouvrir ${title} sur YouTube`,
    searching: "Recherche…",
    noResults: "Aucun résultat. Essaie d'autres mots.",
    web: "Trouvé sur le web",
    youtubeFor: (q: string) => `YouTube · ${q}`,
    googled: "Recherches Google derrière ces liens",
    openLink: (site: string) => `Ouvrir ${site}`,
    like: "Pour le prochain creusage",
    likeFull: `${MAX_LIKED} sélections max pour le prochain creusage. Retires-en une d'abord.`,
    seededFrom: (list: string) => `À partir de${NB}: ${list}`,
    save: "Enregistrer dans Prods",
    saving: "Enregistrement…",
    saved: "Enregistré",
    savedTitle: "Enregistré dans ton dossier de prods (_leads). Clique pour afficher le fichier.",
    convert: "Convertir",
    convertTitle: "Ouvre ton lien de conversion dans le navigateur avec l'adresse de cette vidéo. Hivo ne télécharge jamais d'audio.",
    convertPasteTitle: `Ouvre ta page de conversion dans le navigateur et copie l'adresse de cette vidéo${NB}: colle-la là-bas. Hivo ne télécharge jamais d'audio.`,
    copied: "Adresse copiée. Colle-la sur la page.",
    copyFailed: (url: string) => `Copie impossible. Colle ça sur la page${NB}: ${url}`,
    unresolved: `Le lien de Google n'a pas pu être suivi jusqu'à la page${NB}: ouvre-le pour voir où il mène. Il ne peut pas être enregistré ni converti.`,
    hint: `S'ouvre dans ton navigateur. La licence d'une prod se règle entre toi et le beatmaker${NB}: le Digger ne télécharge rien.`,
  },
);

export const label = "font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave";
export const chip = (on: boolean) =>
  `rounded border px-2 py-0.5 text-left text-xs ${on ? "border-cream bg-cream text-chassis" : "border-rule-strong text-body hover:border-cream"}`;
export const secondary = "rounded border border-rule-strong px-2.5 py-1.5 text-xs font-semibold text-cream hover:border-cream disabled:opacity-40";
const playBtn = "shrink-0 rounded-full border border-rule-strong p-1.5 text-cream hover:border-hot";

/** "Convert": opens the user's converter link in the browser. With a `{url}`
 * slot the address goes in the link; without one the page opens as is and
 * the address is put on the clipboard to paste there. Nothing is shown when
 * no link is set. Hivo never calls the site and never downloads audio. */
export function ConvertButton({ url, className = "" }: { url: string; className?: string }) {
  const t = tr(T);
  const converter = useAppStore((s) => s.settings.converterUrlTemplate);
  const [note, setNote] = useState<string | null>(null);
  const link = converterLink(converter, url);
  if (!link) return null;
  const paste = converterNeedsPaste(converter);
  const click = async () => {
    if (paste) {
      try {
        await navigator.clipboard.writeText(url);
        setNote(t.copied);
      } catch {
        setNote(t.copyFailed(url));
      }
      window.setTimeout(() => setNote(null), 4000);
    }
    await api.openExternal(link);
  };
  return (
    <>
      <button onClick={() => void click()} title={paste ? t.convertPasteTitle : t.convertTitle} className={`${secondary} flex items-center gap-1 ${className}`}>
        <ExternalLink size={12} aria-hidden /> {t.convert}
      </button>
      {note && (
        <span role="status" className="text-[11px] text-engrave">
          {note}
        </span>
      )}
    </>
  );
}

/** The "Use for next dig" toggle on a card or a link (`id`: video id or
 * url). Only with a dig: the picks steer its "Go deeper" rounds. */
export function LikeChip({ id, title }: { id: string; title: string }) {
  const t = tr(T);
  const liked = useDigger((s) => s.liked);
  const toggleLiked = useDigger((s) => s.toggleLiked);
  const hasDig = useDigger((s) => !!s.dig);
  const on = liked.some((l) => l.id === id);
  const full = !on && liked.length >= MAX_LIKED;
  if (!hasDig) return null;
  return (
    <button
      type="button"
      onClick={() => toggleLiked(id, title)}
      aria-pressed={on}
      disabled={full}
      title={full ? t.likeFull : undefined}
      className={`${chip(on)} shrink-0 whitespace-nowrap disabled:opacity-40`}
    >
      {t.like}
    </button>
  );
}

/** The facts a lead saved from this card carries: the dig's summary and
 * traits, and the bpm/key its own title says (never the picked beats'). */
function useLeadFacts() {
  const dig = useDigger((s) => s.dig);
  return useMemo(() => (title: string) => leadFacts(dig, title), [dig]);
}

/** "Save to Prods" on a card or a link; "Saved" (click: show the file) once
 * its url's hash is among the lead files. */
function SaveChip({ lead }: { lead: Lead }) {
  const t = tr(T);
  const hash = leadHash(canonicalUrl(lead.url));
  const path = useDigger((s) => s.savedLeads.get(hash));
  const saveLead = useDigger((s) => s.saveLead);
  const [busy, setBusy] = useState(false);
  const on = !!path;
  const click = async () => {
    if (path) return api.revealInFileManager(path);
    setBusy(true);
    try {
      await saveLead(lead);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={() => void click()} aria-pressed={on} disabled={busy} title={on ? t.savedTitle : undefined} className={`${chip(on)} shrink-0 whitespace-nowrap disabled:opacity-40`}>
      {busy ? t.saving : on ? t.saved : t.save}
    </button>
  );
}

function WebLinks({ links, label: name, onPlay }: { links: WebLink[]; label: string; onPlay: (p: Playing) => void }) {
  const t = tr(T);
  const facts = useLeadFacts();
  return (
    <ul className="flex flex-col gap-1" aria-label={name}>
      {links.map((l) => {
        const id = l.resolved ? youtubeId(l.url) : null;
        const title = l.text || l.site;
        return (
          <li key={l.url} className="flex flex-wrap items-center gap-1" title={l.resolved ? undefined : t.unresolved}>
            {id && (
              <button onClick={() => onPlay({ id, title })} aria-label={t.play(title)} className={playBtn}>
                <Play size={12} />
              </button>
            )}
            <button onClick={() => void api.openExternal(l.url)} aria-label={t.openLink(l.site || l.text)} className="flex min-w-0 flex-1 items-start gap-2 rounded p-1 text-left hover:bg-raised">
              <ExternalLink size={12} className="mt-0.5 shrink-0 text-engrave" aria-hidden />
              <span className="min-w-0 flex-1">
                {l.text && <span className="line-clamp-2 text-xs text-cream">{l.text}</span>}
                <span className="block truncate font-mono text-[10.5px] text-engrave">{l.site}</span>
              </span>
            </button>
            {l.resolved && id && <ConvertButton url={l.url} className="font-normal text-body" />}
            <LikeChip id={id ?? l.url} title={title} />
            {l.resolved && <SaveChip lead={{ url: l.url, title, producer: l.site, year: "", source: id ? "youtube" : "web", ...facts(title) }} />}
          </li>
        );
      })}
    </ul>
  );
}

interface Props {
  yt: YoutubeStatus | null;
  /** The round on screen: 0 is the dig, n is rounds[n - 1]. */
  round: number;
  setRound: (round: number) => void;
  /** Take the free height (there is something to show) or stay compact. */
  fill: boolean;
}

export function DigResults({ yt, round, setRound, fill }: Props) {
  const t = tr(T);
  const { dig, rounds, webQuery, roundResults, searching, searchError, leadError, setWebQuery, searchYoutube } = useDigger();
  const facts = useLeadFacts();
  // Shared with the Saved prods tab (DiggerView), which plays into this dock.
  const playing = useDigger((s) => s.playing);
  const setPlaying = useDigger((s) => s.setPlaying);
  const q = webQuery.trim();
  const run = (query: string) => {
    setWebQuery(query);
    if (yt?.configured && query.trim()) void searchYoutube(query);
  };
  const roundName = (i: number) => (i === 0 ? t.dig : t.round(i + 1));
  const links = dig ? (round === 0 ? dig.web : (rounds[round - 1]?.links ?? [])) : [];
  // The grid follows the breadcrumb: the shown round's search and videos.
  const shown = roundResults[round];
  const videos = shown?.videos ?? [];
  const seedsOf = (i: number) => (i > 0 ? (rounds[i - 1]?.seeds ?? []) : []);

  return (
    <section aria-label={t.title} className={`flex min-h-0 flex-col border-t-[3px] border-rule-strong ${fill ? "flex-1" : "shrink-0"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-6 py-2">
        <h2 className={label}>{t.title}</h2>
        {dig && (
          <nav aria-label={t.rounds} className="flex flex-wrap items-center gap-1.5">
            {Array.from({ length: rounds.length + 1 }, (_, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-engrave" aria-hidden>·</span>}
                <button
                  onClick={() => setRound(i)}
                  aria-current={i === round ? "true" : undefined}
                  aria-label={t.showRound(roundName(i))}
                  title={seedsOf(i).length > 0 ? t.seededFrom(seedList(seedsOf(i))) : undefined}
                  className={chip(i === round)}
                >
                  {roundName(i)}
                </button>
              </span>
            ))}
          </nav>
        )}
        <form
          className="ml-auto flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            run(webQuery);
          }}
        >
          <label className="flex min-w-0 items-center gap-1.5 rounded-md border border-rule bg-chassis px-2 py-1.5 text-xs focus-within:border-hot">
            <Search size={12} className="shrink-0 text-engrave" aria-hidden />
            <input
              value={webQuery}
              onChange={(e) => setWebQuery(e.target.value)}
              maxLength={MAX_QUERY_CHARS}
              placeholder={t.placeholder}
              aria-label={t.searchLabel}
              className="w-56 min-w-0 bg-transparent text-cream placeholder:text-engrave focus:outline-none"
            />
          </label>
          {yt?.configured && (
            <button type="submit" disabled={!q || searching} className={secondary}>
              {t.search}
            </button>
          )}
          <button
            type="button"
            onClick={() => void api.openExternal(youtubeSearchUrl(q))}
            disabled={!q}
            title={t.open}
            aria-label={t.open}
            className="flex items-center gap-1 rounded border border-rule-strong px-2 py-1.5 text-xs text-body hover:border-cream disabled:opacity-40"
          >
            <ExternalLink size={12} aria-hidden /> {yt?.configured ? "" : t.open}
          </button>
        </form>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-3">
        {playing && (
          <div className="flex flex-col gap-1" aria-label={t.player}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-cream" title={playing.title}>
                {playing.title}
              </span>
              <button onClick={() => setPlaying(null)} aria-label={t.closePlayer} className="shrink-0 rounded p-1 text-engrave hover:bg-rule hover:text-cream">
                <X size={14} />
              </button>
            </div>
            {/* The website's wrapper page, not YouTube directly: the webview's
                tauri:// origin sends no referrer and YouTube refuses the embed
                without one (error 153). See web/public/embed.html. */}
            <iframe
              key={playing.id}
              src={embedUrl(playing.id) ?? undefined}
              allow="autoplay; encrypted-media; fullscreen"
              allowFullScreen
              // The wrapper and the YouTube player inside it (sandbox flags
              // carry over) need scripts and their own origin; no popups,
              // forms or top navigation.
              sandbox="allow-scripts allow-same-origin allow-presentation"
              title={playing.title}
              className="aspect-video w-full max-w-2xl rounded bg-chassis"
            />
          </div>
        )}

        {searchError && <div role="alert" className="rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">{searchError}</div>}
        {leadError && <div role="alert" className="rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">{leadError}</div>}
        {searching && <p className="text-xs text-engrave">{t.searching}</p>}
        {!searching && !!shown?.query && shown.query === q && videos.length === 0 && <p className="text-xs text-engrave">{t.noResults}</p>}
        {videos.length > 0 && shown?.query && <h3 className={label}>{t.youtubeFor(shown.query)}</h3>}
        {videos.length > 0 && (
          <ul className="grid grid-cols-1 gap-3 @[900px]:grid-cols-2 @[1200px]:grid-cols-3" aria-label="YouTube">
            {videos.map((v) => {
              return (
                <li key={v.id} className="flex flex-col gap-2 rounded border border-rule bg-panel p-2">
                  <img
                    src={v.thumbnail}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                    className="aspect-video w-full rounded-sm bg-raised object-cover"
                  />
                  <span className="line-clamp-2 min-h-[2lh] text-xs text-cream" title={v.title}>
                    {v.title}
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-engrave">
                    {v.channel}
                    {v.publishedAt ? ` · ${v.publishedAt.slice(0, 4)}` : ""}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button onClick={() => setPlaying({ id: v.id, title: v.title })} aria-label={t.play(v.title)} className={`${secondary} flex items-center gap-1`}>
                      <Play size={12} aria-hidden /> {t.playShort}
                    </button>
                    <button onClick={() => void api.openExternal(v.url)} aria-label={t.openVideo(v.title)} className={`${secondary} flex items-center gap-1 font-normal text-body`}>
                      <ExternalLink size={12} aria-hidden /> {t.open}
                    </button>
                    <ConvertButton url={v.url} className="font-normal text-body" />
                    <LikeChip id={v.id} title={v.title} />
                    <SaveChip lead={{ url: v.url, title: v.title, producer: v.channel, year: v.publishedAt.slice(0, 4), source: "youtube", ...facts(v.title) }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {links.length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className={label}>{round === 0 ? t.web : t.round(round + 1)}</h3>
            <WebLinks links={links} label={round === 0 ? t.web : t.round(round + 1)} onPlay={setPlaying} />
          </div>
        )}
        {dig && round === 0 && dig.webSearches.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label={t.googled}>
            <span className="text-[11px] text-engrave">Google:</span>
            {dig.webSearches.map((s) => (
              <button key={s} onClick={() => void api.openExternal(googleSearchUrl(s))} className={chip(false)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-engrave">{t.hint}</p>
      </div>
    </section>
  );
}
