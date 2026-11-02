import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Plus, Search, X } from "lucide-react";
import { addLink, confirmLink, linkVerified, mergeProfile, removeLink } from "../lib/profiles";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { dict, plural, tr } from "../i18n";
import type { LookupCandidate, MatchInfo, Person, PlatformLink, SpotifyStatus } from "../types";
import { btn, btnPrimary, input, sectionLabel } from "./ui";
import { errorText } from "../lib/errors";

// A person's streaming and social profiles, with the IDs distributors ask
// for (Spotify artist ID, Apple Music ID…). "Look up profiles" searches
// MusicBrainz (keyless) and, with credentials in Settings, Spotify; the user
// picks the right artist and the profiles are stored on the person (local
// only, never shared with the crew). All requests run in Rust (lookup.rs).

const T = dict(
  {
    title: "Profiles",
    lookUp: "Look up profiles",
    lookUpAgain: "Look up again",
    none: "No profiles yet. Look them up to get the links and IDs distributors ask for (Spotify artist ID, Apple Music…).",
    searchPlaceholder: "Artist name",
    search: "Search",
    searching: "Searching…",
    noResults: "No artist found with that name. Try another spelling.",
    pick: "Use",
    picking: "Fetching…",
    cancel: "Cancel",
    source: (s: string) => (s === "spotify" ? "Spotify" : "MusicBrainz"),
    followers: (n: number) => `${new Intl.NumberFormat().format(n)} followers`,
    popularity: (n: number) => `popularity ${n}/100`,
    noStats: "Spotify profile found. Follower and popularity numbers aren't shared with this app (Spotify keeps them from newer apps in development mode).",
    spotifyOff: "Spotify search and stats need app credentials:",
    spotifySettings: "add them in Settings",
    spotifyOffShort: "Spotify stats need credentials in Settings.",
    lookedUp: (when: string) => `Looked up ${when}`,
    copyId: "Copy ID",
    copyLink: "Copy link",
    copied: "Copied",
    open: "Open",
    streaming: "Streaming",
    social: "Social",
    other: "Other",
    via: (s: string) => (s === "manual" ? "added by you" : `via ${s === "musicbrainz" ? "MusicBrainz" : s === "deezer" ? "Deezer" : "iTunes"}`),
    unverified: "Unverified",
    unverifiedTitle: "Found by name only: it may be another artist with the same name. Check it, then confirm. Its ID isn't used until then.",
    confirm: "It's them",
    remove: "Remove",
    fans: (n: number) => `${new Intl.NumberFormat().format(n)} fans`,
    albums: (n: number) => `${n} album${plural(n, "", "s")}`,
    top: (s: string) => `top: ${s}`,
    addLink: "Add a link",
    addPlaceholder: "https://… (a profile page)",
    add: "Add",
    aliases: "Also try:",
  },
  {
    title: "Profils",
    lookUp: "Chercher les profils",
    lookUpAgain: "Chercher à nouveau",
    none: "Pas encore de profil. Cherche-les pour avoir les liens et les identifiants que demandent les distributeurs (ID artiste Spotify, Apple Music…).",
    searchPlaceholder: "Nom d'artiste",
    search: "Chercher",
    searching: "Recherche…",
    noResults: "Aucun artiste à ce nom. Essaie une autre orthographe.",
    pick: "Utiliser",
    picking: "Récupération…",
    cancel: "Annuler",
    source: (s: string) => (s === "spotify" ? "Spotify" : "MusicBrainz"),
    followers: (n: number) => `${new Intl.NumberFormat("fr-FR").format(n)} abonnés`,
    popularity: (n: number) => `popularité ${n}/100`,
    noStats: "Profil Spotify trouvé. Les abonnés et la popularité ne sont pas partagés avec cette appli (Spotify les garde pour les applis récentes en mode développement).",
    spotifyOff: "La recherche et les stats Spotify demandent des identifiants d'appli :",
    spotifySettings: "ajoute-les dans Réglages",
    spotifyOffShort: "Les stats Spotify demandent des identifiants dans Réglages.",
    lookedUp: (when: string) => `Cherché le ${when}`,
    copyId: "Copier l'ID",
    copyLink: "Copier le lien",
    copied: "Copié",
    open: "Ouvrir",
    streaming: "Streaming",
    social: "Réseaux",
    other: "Autres",
    via: (s: string) => (s === "manual" ? "ajouté par toi" : `via ${s === "musicbrainz" ? "MusicBrainz" : s === "deezer" ? "Deezer" : "iTunes"}`),
    unverified: "Non vérifié",
    unverifiedTitle: "Trouvé par le nom seulement : ce peut être un autre artiste du même nom. Vérifie, puis confirme. Son ID n'est pas utilisé avant.",
    confirm: "C'est bien lui",
    remove: "Retirer",
    fans: (n: number) => `${new Intl.NumberFormat("fr-FR").format(n)} fans`,
    albums: (n: number) => `${n} album${plural(n, "", "s")}`,
    top: (s: string) => `top : ${s}`,
    addLink: "Ajouter un lien",
    addPlaceholder: "https://… (une page de profil)",
    add: "Ajouter",
    aliases: "Essayer aussi :",
  },
);

/** "1,200 fans · 3 albums · Hip-Hop · top: Night": what tells homonyms apart. */
function matchLine(t: (typeof T)["en"], m: MatchInfo | undefined): string {
  if (!m) return "";
  return [m.fans != null ? t.fans(m.fans) : "", m.albums != null ? t.albums(m.albums) : "", m.genre ?? "", m.topTrack ? t.top(m.topTrack) : ""].filter(Boolean).join(" · ");
}

const CATEGORIES: PlatformLink["category"][] = ["streaming", "social", "other"];

export function Profiles({ person }: { person: Person }) {
  const t = tr(T);
  const updatePerson = useAppStore((s) => s.updatePerson);
  const setView = useAppStore((s) => s.setView);
  const [open, setOpen] = useState(false);
  const [spotify, setSpotify] = useState<SpotifyStatus | null>(null);
  const links = person.links ?? [];

  useEffect(() => {
    let live = true;
    api.spotifyStatus().then((s) => live && setSpotify(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center gap-3">
        <div className={sectionLabel}>{t.title}</div>
        {person.lookedUpAt && <span className="text-[11px] text-engrave">{t.lookedUp(person.lookedUpAt.slice(0, 10))}</span>}
        <button onClick={() => setOpen(!open)} className={`${btn} ml-auto text-xs`}>
          <Search size={12} /> {links.length ? t.lookUpAgain : t.lookUp}
        </button>
      </div>

      {open && (
        <LookupPanel
          name={person.name}
          aliases={person.aliases}
          spotifyConfigured={!!spotify?.configured}
          onSettings={() => setView("settings", "spotify")}
          onPicked={(profile) => {
            // Merged: hand-added and confirmed links, and Spotify numbers the new answer lacks, stay.
            updatePerson(person.id, mergeProfile(person, profile, new Date().toISOString()));
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}

      {links.length === 0 && !open && <p className="text-xs text-engrave">{t.none}</p>}

      {person.spotify && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-rule bg-panel px-3 py-2">
          {person.spotify.imageUrl && <img src={person.spotify.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />}
          <div className="min-w-0 text-xs text-body">
            {person.spotify.followers != null || person.spotify.popularity != null ? (
              <div className="text-cream">
                {[person.spotify.followers != null ? t.followers(person.spotify.followers) : "", person.spotify.popularity != null ? t.popularity(person.spotify.popularity) : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            ) : (
              <div className="text-engrave">{t.noStats}</div>
            )}
            {person.spotify.genres.length > 0 && <div className="truncate text-engrave">{person.spotify.genres.join(" · ")}</div>}
          </div>
        </div>
      )}
      {!person.spotify && links.some((l) => l.platform === "spotify") && !spotify?.configured && (
        <p className="mb-2 text-[11px] text-engrave">
          {t.spotifyOffShort}{" "}
          <button onClick={() => setView("settings", "spotify")} className="text-body underline-offset-2 hover:text-cream hover:underline">
            {t.spotifySettings}
          </button>
        </p>
      )}

      {CATEGORIES.map((cat) => {
        const group = links.filter((l) => l.category === cat);
        if (group.length === 0) return null;
        return (
          <div key={cat} className="mb-3">
            <div className="mb-1 text-[10.5px] uppercase tracking-[0.14em] text-engrave">{t[cat]}</div>
            <div className="overflow-hidden rounded-lg border border-rule">
              {group.map((l) => (
                <LinkRow
                  key={`${l.platform}:${l.id ?? l.url}`}
                  link={l}
                  onConfirm={() => updatePerson(person.id, { links: confirmLink(links, l) })}
                  onRemove={() => updatePerson(person.id, { links: removeLink(links, l) })}
                />
              ))}
            </div>
          </div>
        );
      })}
      <AddLink onAdd={(l) => updatePerson(person.id, { links: addLink(links, l) })} />
    </div>
  );
}

/** A profile link typed by hand; Rust classifies it (known platforms rebuilt from their id). */
function AddLink({ onAdd }: { onAdd: (l: PlatformLink) => void }) {
  const t = tr(T);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      onAdd(await api.classifyProfileLink(url.trim()));
      setUrl("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <form
      className="mt-2 flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="flex items-center gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t.addPlaceholder} aria-label={t.addLink} maxLength={300} className={`${input} py-1.5 text-xs`} />
        <button type="submit" disabled={!url.trim()} className={`${btn} text-xs`}>
          <Plus size={12} /> {t.add}
        </button>
      </div>
      {error && <p role="alert" className="text-[11px] text-missing">{error}</p>}
    </form>
  );
}

function LinkRow({ link, onConfirm, onRemove }: { link: PlatformLink; onConfirm: () => void; onRemove: () => void }) {
  const t = tr(T);
  const verified = linkVerified(link);
  const info = matchLine(t, link.matchInfo);
  const [copied, setCopied] = useState<"id" | "link" | null>(null);
  const copy = async (what: "id" | "link") => {
    try {
      await navigator.clipboard.writeText(what === "id" ? (link.id ?? "") : link.url);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // The address stays readable in the row; nothing else to do.
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule px-3 py-2 text-xs last:border-0">
      <span className="w-36 shrink-0 truncate text-cream" title={`${link.label} · ${link.url}`}>
        {link.label}
      </span>
      <span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${verified ? "text-engrave" : "italic text-engrave"}`} title={link.url}>
        {link.id ?? link.url}
        {info && <span className="ml-2 font-sans text-body">{info}</span>}
      </span>
      {link.source !== "musicbrainz" && <span className="shrink-0 text-[10px] text-engrave">{t.via(link.source)}</span>}
      {!verified && (
        <>
          <span className="shrink-0 rounded border border-warn/60 px-1 text-[10px] uppercase text-warn" title={t.unverifiedTitle}>
            {t.unverified}
          </span>
          <button onClick={onConfirm} className="flex shrink-0 items-center gap-1 text-cream hover:text-hot" title={t.unverifiedTitle}>
            <Check size={11} /> {t.confirm}
          </button>
        </>
      )}
      {link.id && verified && (
        <button onClick={() => void copy("id")} className="flex shrink-0 items-center gap-1 text-body hover:text-cream" title={t.copyId}>
          {copied === "id" ? <Check size={11} /> : <Copy size={11} />} {copied === "id" ? t.copied : t.copyId}
        </button>
      )}
      <button onClick={() => void copy("link")} className="flex shrink-0 items-center gap-1 text-body hover:text-cream" title={t.copyLink}>
        {copied === "link" ? <Check size={11} /> : <Copy size={11} />} {copied === "link" ? t.copied : t.copyLink}
      </button>
      <button onClick={() => void api.openExternal(link.url)} className="flex shrink-0 items-center gap-1 text-body hover:text-cream" title={link.url}>
        <ExternalLink size={11} /> {t.open}
      </button>
      <button onClick={onRemove} aria-label={`${t.remove} ${link.label}`} title={t.remove} className="shrink-0 rounded p-0.5 text-engrave hover:text-missing">
        <X size={12} />
      </button>
    </div>
  );
}

function LookupPanel({
  name,
  aliases,
  spotifyConfigured,
  onSettings,
  onPicked,
  onClose,
}: {
  name: string;
  aliases: string[];
  spotifyConfigured: boolean;
  onSettings: () => void;
  onPicked: (profile: Awaited<ReturnType<typeof api.lookupProfile>>) => void;
  onClose: () => void;
}) {
  const t = tr(T);
  const [query, setQuery] = useState(name);
  const [candidates, setCandidates] = useState<LookupCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async (raw: string = query) => {
    const q = raw.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError(null);
    try {
      setCandidates(await api.lookupArtists(q));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSearching(false);
    }
  };

  // The person's name is the obvious first search.
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (c: LookupCandidate) => {
    setPicking(`${c.source}:${c.id}`);
    setError(null);
    try {
      onPicked(await api.lookupProfile(c.source, c.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPicking(null);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-rule-strong bg-raised p-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.searchPlaceholder} maxLength={120} className={`${input} py-1.5 text-xs`} />
        <button type="submit" disabled={searching || query.trim().length < 2} className={`${btnPrimary} text-xs`}>
          {searching ? t.searching : t.search}
        </button>
        <button type="button" onClick={onClose} aria-label={t.cancel} className="rounded p-1 text-engrave hover:bg-rule hover:text-cream">
          <X size={14} />
        </button>
      </form>
      {aliases.filter((a) => a.trim().length >= 2).length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-engrave">
          <span>{t.aliases}</span>
          {[...new Set(aliases.map((a) => a.trim()).filter((a) => a.length >= 2))].map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => {
                setQuery(a);
                void search(a);
              }}
              className="rounded border border-rule-strong px-1.5 py-px text-body hover:border-cream"
            >
              {a}
            </button>
          ))}
        </div>
      )}
      {!spotifyConfigured && (
        <p className="mt-2 text-[11px] text-engrave">
          {t.spotifyOff}{" "}
          <button type="button" onClick={onSettings} className="text-body underline-offset-2 hover:text-cream hover:underline">
            {t.spotifySettings}
          </button>
        </p>
      )}
      {error && <div role="alert" className="mt-2 rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">{error}</div>}
      {candidates && candidates.length === 0 && !searching && <p className="mt-2 text-xs text-engrave">{t.noResults}</p>}
      {candidates && candidates.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {candidates.map((c) => {
            const key = `${c.source}:${c.id}`;
            const facts = [c.disambiguation, c.country, c.kind, c.followers != null ? t.followers(c.followers) : ""].filter(Boolean).join(" · ");
            return (
              <li key={key} className="flex items-center gap-3 rounded px-2 py-1.5 text-xs hover:bg-panel">
                <span className="w-20 shrink-0 rounded bg-rule px-1.5 py-px text-center text-[10px] text-body">{t.source(c.source)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-cream">{c.name}</span>
                  {facts && <span className="block truncate text-[11px] text-engrave">{facts}</span>}
                </span>
                <button type="button" onClick={() => void pick(c)} disabled={picking !== null} className={`${btn} text-xs`}>
                  {picking === key ? t.picking : t.pick}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
