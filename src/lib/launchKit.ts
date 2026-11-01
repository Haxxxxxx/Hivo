import type { AiFieldReview, Album, AudioAnalysis, CaptionLang, KitFieldId, MasterSpec, Person, ProjectInfo, Snippet, SongMeta } from "../types";
import { detectKey, detectedPeople } from "./people";
import { KEYS, renderFreshness } from "./songs";
import { dawOf, isSketch } from "./daws";
import { linkVerified } from "./profiles";
import { applyLang, currentLang, dict, tr } from "../i18n";

// On-screen text only (field labels, provenance notes, check messages).
// Values and the exported files stay in English: kitFiles builds from
// fields made inside `inEnglish`, so distributor files never change with
// the app's language. Captions follow their own caption language.
const T_LABELS = dict(
  {
    title: "Title",
    artists: "Artist(s)",
    producers: "Producer(s)",
    genre: "Genre",
    bpm: "BPM",
    key: "Key",
    duration: "Duration",
    explicit: "Explicit lyrics",
    releaseDate: "Release date",
    coverBrief: "Cover art brief",
    captions: "Captions",
    featuring: "Featuring",
    songwriters: "Songwriters",
    label: "Label",
    copyright: "℗ / © line",
    language: "Lyrics language",
    isrc: "ISRC",
    upc: "UPC / EAN",
    releaseTitle: "Release title",
    releaseType: "Release type",
    trackNumber: "Track number",
  } satisfies Record<KitFieldId, string>,
  {
    title: "Titre",
    artists: "Artiste(s)",
    producers: "Producteur(s)",
    genre: "Genre",
    bpm: "BPM",
    key: "Tonalité",
    duration: "Durée",
    explicit: "Paroles explicites",
    releaseDate: "Date de sortie",
    coverBrief: "Brief de la cover",
    captions: "Textes",
    featuring: "Featuring",
    songwriters: "Auteurs-compositeurs",
    label: "Label",
    copyright: "Ligne ℗ / ©",
    language: "Langue des paroles",
    isrc: "ISRC",
    upc: "UPC / EAN",
    releaseTitle: "Titre de la sortie",
    releaseType: "Type de sortie",
    trackNumber: "Numéro de piste",
  },
);

const T = dict(
  {
    // Where a value came from.
    titleFromProject: (daw: string) => `From the title in the ${daw} project`,
    fromProjectName: "From the project name",
    fromProjectNameTagged: (name: string) => `From the project name "${name}", version tag removed`,
    fromCredits: "From the song's credits",
    artistFromProject: (daw: string) => `From the artist in the ${daw} project`,
    foundInTrackNames: "Found in mixer track names. Confirm who's the main artist",
    creditArtist: "Credit the artist in the song panel, or type it here",
    featCredited: "Credited as feat. in the song panel",
    noFeat: "No featured artist credited. Leave empty if there's none",
    writersFromCredits: "From the song's credits. Distributors want legal names, not artist names",
    whoWrote: "Who wrote it? Legal names, separated by ;  e.g. Jane Doe (lyrics) 50%; John Roe (music) 50%",
    creditProducer: "Credit a producer in the song panel, or type it here",
    genreFromProject: (daw: string) => `From the project info in ${daw}`,
    crewDefault: "Crew default. Change it if this one's different",
    tempoFromProject: (daw: string) => `From the ${daw} project's tempo`,
    closedFormat: (daw: string) => `${daw} projects can't be read from outside. Type the tempo once`,
    noTempoFound: "No tempo found in the project",
    sketchTempo: "A BandLab sketch has no project to read the tempo from. Type it once",
    sure: (pct: number) => `${pct}% sure`,
    keyInPanelAudio: (key: string, sure: string) => `Set in the song panel. The audio sounds more like ${key} (${sure})`,
    keyInPanel: "Set in the song panel",
    keyInTrackName: "Written in a mixer track name",
    keyFromMixdown: (sure: string) => `Estimated from the mixdown (${sure})`,
    keyFromMixdownUnsure: (sure: string) => `Estimated from the mixdown, not sure (${sure}). Check it by ear`,
    keyMissing: "Not in the project. Optional, but playlists and DJs use it",
    durationMeasured: "Measured from the latest mixdown",
    durationMissing: "Render a mixdown so it can be measured",
    explicitMissing: "Can't be detected from audio. Answer once",
    fromRelease: (title: string) => `From the release "${title}"`,
    firstFriday: (days: number, skipped: number) =>
      `First Friday ${days}+ days out: time to deliver to the distributor and pitch to Spotify editorial` +
      (skipped ? `. Skipped ${skipped} Friday${skipped === 1 ? "" : "s"} that already ha${skipped === 1 ? "s" : "ve"} a release (yours or the crew's)` : ""),
    labelCrew: "Your crew's name. Self-releasing? Your artist name works too",
    labelSelf: "Self-released: the artist name is the usual label",
    labelEmpty: "Your label, or your artist name if self-released",
    languageFromSettings: "Your language in Settings → AI. Change it if this song's different",
    languageMissing: "The language of the lyrics (Instrumental if none). Distributors require it",
    isrcNote: "Leave empty: your distributor assigns one for free. Fill it if this song already has one",
    upcNote: "Leave empty: assigned for free with the release. Fill it to reuse an existing one",
    singleNote: "Not part of a release in Releases, so a single",
    trackPlace: (title: string) => `Its place in "${title}"`,
    singleTrack1: "A single is track 1",
    fromReleases: "From Releases",
    singleReleaseTitle: "A single's release title is the song title",
    copyrightNote: "℗ line: release year + label. Edit if someone else owns the master",
    youChanged: "You changed this",
    draftsOutdated: "Written for another title, artist, date or language. Rewrite with AI or edit it",
    aiWritten: (model: string) => `Written by ${model}, then checked`,
    draftedFromFields: "Drafted from the fields above",
    sameAsSongTitle: "Same as the song title (a single)",
    // Field checks.
    needTitle: "A release needs a title",
    looksLikeFile: "Looks like a file name, not a release title",
    whoArtist: "Who's the artist?",
    noProducer: "No producer credited",
    genreRequired: "Distributors require a genre",
    noTempo: "No tempo",
    notNumber: "Not a number",
    unusualTempo: "Unusual tempo. Double or half time?",
    noKey: "No key",
    keyFormat: "Write it like Am, F# or Bb",
    noMixdownToMeasure: "No mixdown to measure",
    durationFormat: "Write it as minutes:seconds, like 2:45",
    under30: "Under 30 s: Spotify only counts a stream after 30 seconds",
    explicitAsk: "Explicit lyrics? Yes or No",
    pickDate: "Pick a release date",
    pastDate: "That date is in the past",
    underWeek: "Under a week away: too late to pitch to Spotify editorial",
    notFriday: "Not a Friday. New music drops worldwide on Fridays",
    placeholders: "Fill in the [placeholders]",
    writersRequired: "Distributors need the songwriters' legal names",
    splitAll: "Give every writer a split, or none",
    splitsSum: (sum: number) => `Splits add up to ${sum}%, not 100%`,
    noLabel: "No label: most distributors use the artist name",
    addYear: "Add the year, like ℗ 2026 Your Label",
    languageAsk: "Language of the lyrics (or Instrumental)",
    isrcFormat: "An ISRC looks like FR-AB1-26-00001",
    upcFormat: "A UPC/EAN is 12 or 13 digits",
    releaseTitleNeeded: "The release needs a title",
    releaseTypeAsk: "Single, EP, Album or Mixtape?",
    trackNumberAsk: "A track number, like 1",
    notAllIn: (lang: CaptionLang, words: string) => `Not all in ${lang === "fr" ? "French" : "English"}: ${words}`,
    // Kit-level checks.
    noMixdown: "No mixdown yet. Render one: it's the file you'll upload",
    staleMixdown: "The project was saved after the latest mixdown. Re-render before exporting",
    defaultExportTip: "In FL Studio: File → Export → Wave file, 44,100 Hz, 24-bit.",
    masterLossy: (name: string, tip: string) => `The master is ${name}: distributors want lossless WAV. ${tip}`,
    masterFlac: (tip: string) => `FLAC master: DistroKid takes it, most others want WAV. ${tip}`,
    master48: (tip: string) => `48 kHz master: most distributors want 44.1 kHz. ${tip}`,
    masterRate: (rate: number, tip: string) => `${(rate / 1000).toFixed(1)} kHz master: distributors want 44.1 kHz. ${tip}`,
    masterBits: (bits: number, tip: string) => `${bits}-bit master: distributors want 16 or 24-bit. ${tip}`,
    mono: "Mono master: distributors expect stereo",
    clipping: (count: number) =>
      `Hits full scale ${count.toLocaleString("en")} times: likely clipping. Leave about 1 dB of headroom (Spotify asks for −1 dB true peak)`,
  },
  {
    titleFromProject: (daw: string) => `D'après le titre dans le projet ${daw}`,
    fromProjectName: "D'après le nom du projet",
    fromProjectNameTagged: (name: string) => `D'après le nom du projet "${name}", sans le tag de version`,
    fromCredits: "D'après les crédits du son",
    artistFromProject: (daw: string) => `D'après l'artiste dans le projet ${daw}`,
    foundInTrackNames: "Trouvé dans les noms de pistes du mixer. Confirme qui est l'artiste principal",
    creditArtist: "Crédite l'artiste dans le panneau du son, ou tape-le ici",
    featCredited: "Crédité en feat. dans le panneau du son",
    noFeat: "Aucun feat. crédité. Laisse vide s'il n'y en a pas",
    writersFromCredits: "D'après les crédits du son. Les distributeurs veulent les noms légaux, pas les noms d'artiste",
    whoWrote: "Qui l'a écrit ? Noms légaux, séparés par ;  ex. Jane Doe (paroles) 50% ; John Roe (musique) 50%",
    creditProducer: "Crédite un producteur dans le panneau du son, ou tape-le ici",
    genreFromProject: (daw: string) => `D'après les infos du projet dans ${daw}`,
    crewDefault: "Par défaut pour le crew. Change-le si ce son est différent",
    tempoFromProject: (daw: string) => `D'après le tempo du projet ${daw}`,
    closedFormat: (daw: string) => `Les projets ${daw} ne se lisent pas de l'extérieur. Tape le tempo une fois`,
    noTempoFound: "Aucun tempo trouvé dans le projet",
    sketchTempo: "Un sketch BandLab n'a pas de projet où lire le tempo. Tape-le une fois",
    sure: (pct: number) => `sûr à ${pct} %`,
    keyInPanelAudio: (key: string, sure: string) => `Réglée dans le panneau du son. L'audio sonne plutôt en ${key} (${sure})`,
    keyInPanel: "Réglée dans le panneau du son",
    keyInTrackName: "Écrite dans un nom de piste du mixer",
    keyFromMixdown: (sure: string) => `Estimée à partir du mixdown (${sure})`,
    keyFromMixdownUnsure: (sure: string) => `Estimée à partir du mixdown, pas sûr (${sure}). Vérifie à l'oreille`,
    keyMissing: "Pas dans le projet. Optionnel, mais les playlists et les DJ s'en servent",
    durationMeasured: "Mesurée sur le dernier mixdown",
    durationMissing: "Fais le rendu d'un mixdown pour pouvoir la mesurer",
    explicitMissing: "Impossible à détecter dans l'audio. Réponds une fois",
    fromRelease: (title: string) => `D'après la sortie "${title}"`,
    firstFriday: (days: number, skipped: number) =>
      `Premier vendredi dans ${days} jours ou plus : le temps de livrer au distributeur et de pitcher l'éditorial Spotify` +
      (skipped ? `. ${skipped} vendredi${skipped === 1 ? "" : "s"} sauté${skipped === 1 ? "" : "s"}, déjà pris par une sortie (la tienne ou celle du crew)` : ""),
    labelCrew: "Le nom de ton crew. Tu sors en indé ? Ton nom d'artiste marche aussi",
    labelSelf: "Sortie en indé : en général, le nom d'artiste sert de label",
    labelEmpty: "Ton label, ou ton nom d'artiste si tu sors en indé",
    languageFromSettings: "Ta langue dans Réglages → IA. Change-la si ce son est différent",
    languageMissing: "La langue des paroles (Instrumental s'il n'y en a pas). Les distributeurs l'exigent",
    isrcNote: "Laisse vide : ton distributeur en attribue un gratuitement. Remplis-le si ce son en a déjà un",
    upcNote: "Laisse vide : attribué gratuitement avec la sortie. Remplis-le pour en réutiliser un",
    singleNote: "Dans aucune sortie de la page Sorties, donc un single",
    trackPlace: (title: string) => `Sa place dans "${title}"`,
    singleTrack1: "Un single, c'est la piste 1",
    fromReleases: "D'après Sorties",
    singleReleaseTitle: "Pour un single, le titre de la sortie est celui du son",
    copyrightNote: "Ligne ℗ : année de sortie + label. Modifie-la si quelqu'un d'autre possède le master",
    youChanged: "Modifié par toi",
    draftsOutdated: "Écrit pour un autre titre, artiste, date ou langue. Réécris avec l'IA ou modifie-le",
    aiWritten: (model: string) => `Écrit par ${model}, puis vérifié`,
    draftedFromFields: "Rédigé à partir des champs au-dessus",
    sameAsSongTitle: "Le même que le titre du son (un single)",
    needTitle: "Une sortie a besoin d'un titre",
    looksLikeFile: "On dirait un nom de fichier, pas un titre de sortie",
    whoArtist: "C'est qui l'artiste ?",
    noProducer: "Aucun producteur crédité",
    genreRequired: "Les distributeurs exigent un genre",
    noTempo: "Pas de tempo",
    notNumber: "Ce n'est pas un nombre",
    unusualTempo: "Tempo inhabituel. Double ou demi-tempo ?",
    noKey: "Pas de tonalité",
    keyFormat: "Écris-la comme Am, F# ou Bb",
    noMixdownToMeasure: "Pas de mixdown à mesurer",
    durationFormat: "Écris-la en minutes:secondes, comme 2:45",
    under30: "Moins de 30 s : Spotify ne compte une écoute qu'après 30 secondes",
    explicitAsk: "Paroles explicites ? Oui ou non",
    pickDate: "Choisis une date de sortie",
    pastDate: "Cette date est déjà passée",
    underWeek: "Moins d'une semaine : trop tard pour pitcher l'éditorial Spotify",
    notFriday: "Pas un vendredi. Les nouveautés sortent partout le vendredi",
    placeholders: "Remplis les [trous]",
    writersRequired: "Les distributeurs ont besoin des noms légaux des auteurs-compositeurs",
    splitAll: "Donne une répartition à chaque auteur, ou à aucun",
    splitsSum: (sum: number) => `Les répartitions font ${String(sum).replace(".", ",")}%, pas 100%`,
    noLabel: "Pas de label : la plupart des distributeurs prennent le nom d'artiste",
    addYear: "Ajoute l'année, comme ℗ 2026 Ton Label",
    languageAsk: "Langue des paroles (ou Instrumental)",
    isrcFormat: "Un ISRC ressemble à FR-AB1-26-00001",
    upcFormat: "Un UPC/EAN fait 12 ou 13 chiffres",
    releaseTitleNeeded: "La sortie a besoin d'un titre",
    releaseTypeAsk: "Single, EP, Album ou Mixtape ?",
    trackNumberAsk: "Un numéro de piste, comme 1",
    notAllIn: (lang: CaptionLang, words: string) => `Pas tout en ${lang === "fr" ? "français" : "anglais"} : ${words}`,
    noMixdown: "Pas encore de mixdown. Fais-en le rendu : c'est le fichier que tu vas uploader",
    staleMixdown: "Le projet a été sauvegardé après le dernier mixdown. Refais le rendu avant d'exporter",
    defaultExportTip: "Dans FL Studio : File → Export → Wave file, 44 100 Hz, 24 bits.",
    masterLossy: (name: string, tip: string) => `Le master est en ${name} : les distributeurs veulent du WAV sans perte. ${tip}`,
    masterFlac: (tip: string) => `Master en FLAC : DistroKid le prend, la plupart des autres veulent du WAV. ${tip}`,
    master48: (tip: string) => `Master en 48 kHz : la plupart des distributeurs veulent du 44,1 kHz. ${tip}`,
    masterRate: (rate: number, tip: string) => `Master en ${(rate / 1000).toFixed(1).replace(".", ",")} kHz : les distributeurs veulent du 44,1 kHz. ${tip}`,
    masterBits: (bits: number, tip: string) => `Master en ${bits} bits : les distributeurs veulent du 16 ou 24 bits. ${tip}`,
    mono: "Master en mono : les distributeurs attendent de la stéréo",
    clipping: (count: number) =>
      `Touche le niveau max ${count.toLocaleString("fr-FR")} fois : sûrement de la saturation. Garde environ 1 dB de marge (Spotify demande −1 dB true peak)`,
  },
);

/** A field's label in the app's language. */
export function fieldLabel(id: KitFieldId): string {
  return tr(T_LABELS)[id];
}

/** Runs `fn` with the app in English, for the exported kit files: they're
 * the same whatever the app's language (distributors, other tools). */
export function inEnglish<R>(fn: () => R): R {
  const prev = currentLang();
  if (prev === "en") return fn();
  applyLang("en");
  try {
    return fn();
  } finally {
    applyLang(prev);
  }
}

// The Launch Kit: everything a release needs, pre-filled from the project.
// Principles (docs/ROADMAP.md): fast by default, never a black box. Every
// field says where its value came from, every field can be edited or reset,
// and anything that can't be detected is asked once instead of guessed.

/** detected = read from the project; suggested = a reasonable default to
 * confirm; ai = written by the AI layer; edited = typed by the user;
 * missing = needs an answer. */
export type FieldSource = "detected" | "suggested" | "ai" | "edited" | "missing";

export interface Check {
  level: "warn" | "missing";
  message: string;
}

export interface KitField {
  id: KitFieldId;
  label: string;
  value: string;
  source: FieldSource;
  /** Where the value came from, in plain words. */
  note: string;
  kind: "text" | "multiline" | "date" | "choice";
  options?: string[];
  check?: Check;
  /** The AI layer's verdict; stale when the value changed since. */
  review?: AiFieldReview & { stale: boolean };
}

export interface KitInput {
  project: ProjectInfo;
  meta: SongMeta;
  people: Person[];
  albums: Album[];
  analysis: AudioAnalysis | null;
  today?: Date;
  /** Language the lyrics are in (Settings → AI language), for distributors. */
  language?: string | null;
  /** Caption language (the kit's own, else Settings). French by default. */
  captionLanguage?: CaptionLang;
  /** Default label: the crew's name, if in a crew. */
  labelName?: string | null;
  /** Release dates already taken (other releases, the crew's): avoided. */
  busyDates?: string[];
}

const DAY = 24 * 60 * 60 * 1000;
/** Lead time to deliver to a distributor and pitch to Spotify editorial,
 * which needs the track at least 7 days before release. */
const LEAD_DAYS = 28;
const PITCH_DAYS = 7;

const VERSION_TAG = /[\s_-]*[([]?\b(v\d+(\.\d+)?|final|master(ed)?|mixdown|demo|wip|copy)\b[)\]]?$/i;

/** "Night_Drive v3 (final)" → "Night Drive". */
export function cleanTitle(name: string): string {
  let t = name.replace(/_/g, " ").trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(VERSION_TAG, "").trim();
  }
  return t || name;
}

/** The kit's title before any edit: the title saved inside the project,
 * else the file name without version tags. The export folder is named
 * after the (edited) title, so everything that finds the folder uses this. */
export function defaultKitTitle(project: Pick<ProjectInfo, "name" | "flpTitle">): string {
  return project.flpTitle?.trim() || cleanTitle(project.name) || project.name;
}

/** The kit folder's name for a song: the edited title, else the default. */
export function kitTitleFor(project: Pick<ProjectInfo, "name" | "flpTitle">, meta?: SongMeta): string {
  return meta?.launchKit?.edits?.title || defaultKitTitle(project);
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** yyyy-mm-dd → local Date, or null. */
/** A YYYY-MM-DD day as local midnight in ms (not UTC: `new Date("2026-11-06")` is UTC and can flip a day). */
export const localDayMs = (value: string | undefined | null): number | null => (value ? (parseDate(value)?.getTime() ?? null) : null);

export function parseDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

/** First Friday at least `days` from today. */
export function fridayAfter(today: Date, days: number): Date {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  return d;
}

export function humanDate(value: string, lang?: CaptionLang): string {
  const d = parseDate(value);
  const locale = lang === "fr" ? "fr-FR" : lang === "en" ? "en-GB" : undefined;
  if (!d) return lang === "fr" ? "[date de sortie]" : "[release date]";
  return d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });
}

/** Section headings of the captions text, per language. */
export const CAPTION_HEADINGS: Record<CaptionLang, { announce: string; teaser: string; releaseDay: string }> = {
  fr: { announce: "ANNONCE", teaser: "TEASER (à poster avec l'extrait du hook)", releaseDay: "JOUR DE SORTIE" },
  en: { announce: "ANNOUNCE", teaser: "TEASER (post with the Hook snippet)", releaseDay: "RELEASE DAY" },
};

export const CAPTION_LANGUAGE_NAMES: Record<CaptionLang, string> = { fr: "French", en: "English" };

// Common words that give a caption's language away (titles, names, hashtags
// and handles are ignored). Short lists on purpose: they only need to catch
// a caption, or part of one, written in the other language.
const LANG_WORDS: Record<CaptionLang, Set<string>> = {
  en: new Set(["the", "is", "are", "out", "now", "link", "in", "bio", "and", "you", "your", "this", "drops", "ready", "not", "new", "on", "it", "for", "with", "everywhere", "tonight", "today", "pre-save", "listen", "stream", "get", "who", "what"]),
  fr: new Set(["le", "la", "les", "est", "sont", "dispo", "disponible", "lien", "dans", "et", "tu", "ton", "ta", "tes", "vous", "ce", "cette", "sort", "sortie", "pas", "nouveau", "nouvelle", "sur", "des", "du", "partout", "maintenant", "ce soir", "écoute", "écoutez", "qui", "quoi", "avec", "pour"]),
};

/** Caption blocks with words in the other language, or undefined when the
 * whole text reads as `lang`. */
export function captionLanguageIssue(text: string, lang: CaptionLang): string | undefined {
  const other: CaptionLang = lang === "fr" ? "en" : "fr";
  const headings = new Set(Object.values(CAPTION_HEADINGS).flatMap((h) => Object.values(h)));
  const offending: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => !headings.has(l.trim()));
    const words = lines
      .join(" ")
      .replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, " ") // quoted titles
      .replace(/[#@][\p{L}\p{N}_]+/gu, " ") // hashtags, handles
      .toLowerCase()
      .match(/[\p{L}'-]+/gu) ?? [];
    const hits = words.filter((w) => LANG_WORDS[other].has(w) && !LANG_WORDS[lang].has(w));
    if (hits.length >= 2) offending.push(hits.slice(0, 3).join(", "));
  }
  if (!offending.length) return undefined;
  return tr(T).notAllIn(lang, offending.join("; "));
}

function tempoFeel(bpm: number): string {
  if (bpm < 85) return "slow and heavy";
  if (bpm < 110) return "mid-tempo, laid back";
  if (bpm < 135) return "upbeat";
  return "fast, or a half-time feel";
}

/** An audio key estimate at or above this is shown as detected. */
export const KEY_SURE = 0.6;
const PITCH: Record<string, number> = { C: 0, "C#": 1, D: 2, Eb: 3, E: 4, F: 5, "F#": 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

/** C and Am share every note: the estimate often can't tell them apart. */
export function relativeKeys(a: string, b: string): boolean {
  const parse = (k: string) => ({ pc: PITCH[k.replace(/m$/, "")], minor: k.endsWith("m") });
  const x = parse(a);
  const y = parse(b);
  if (x.pc === undefined || y.pc === undefined || x.minor === y.minor) return false;
  const [maj, min] = x.minor ? [y, x] : [x, y];
  return (maj.pc + 9) % 12 === min.pc;
}

function joinNames(names: string[]): string {
  return [...new Set(names)].join(", ");
}

/** "Ana feat. Ben": how the artist reads on a cover, a caption or a file name. */
export function artistLine(artists: string, featuring: string): string {
  return featuring.trim() ? `${artists} feat. ${featuring.trim()}` : artists;
}

/** Roles that write: lyrics (rap, vocals, topline) or music (production). */
const WRITER_ROLE = /writ|lyric|compos|author|rap|vocal|sing|mc|lead|artist|feat|prod|beat|topline/i;
const KIND_LABEL: Record<Album["kind"], string> = { single: "Single", ep: "EP", album: "Album", mixtape: "Mixtape" };
export const RELEASE_TYPES = ["Single", "EP", "Album", "Mixtape"];

/** Generated value + provenance for every field, before user edits. */
function generate(input: KitInput) {
  const { project, meta, people, albums, analysis, today = new Date() } = input;
  const name = (id: string) => people.find((p) => p.id === id)?.name;
  const credits = (meta.credits ?? []).map((c) => ({ ...c, name: name(c.personId) })).filter((c) => c.name);
  const byRole = (re: RegExp) => credits.filter((c) => re.test(c.role)).map((c) => c.name!);

  const g: Record<KitFieldId, { value: string; source: FieldSource; note: string }> = {} as never;

  const title = cleanTitle(project.name);
  const t = tr(T);
  const daw = dawOf(project).label;
  const flpTitle = project.flpTitle?.trim();
  g.title = flpTitle
    ? { value: flpTitle, source: "detected", note: t.titleFromProject(daw) }
    : {
        value: title,
        source: "detected",
        note: title === project.name ? t.fromProjectName : t.fromProjectNameTagged(project.name),
      };

  // Distributors take featured artists separately from the main artist.
  const feats = byRole(/feat/i);
  const leads = byRole(/artist|rap|vocal|sing|mc|lead/i).filter((n) => !feats.includes(n));
  if (leads.length) {
    g.artists = { value: joinNames(leads), source: "detected", note: t.fromCredits };
  } else if (project.artist?.trim()) {
    g.artists = { value: project.artist.trim(), source: "detected", note: t.artistFromProject(daw) };
  } else {
    const found = detectedPeople(project, people).map((p) => p.name).filter((n) => !feats.includes(n));
    g.artists = found.length
      ? { value: joinNames(found), source: "suggested", note: t.foundInTrackNames }
      : { value: "", source: "missing", note: t.creditArtist };
  }
  g.featuring = feats.length
    ? { value: joinNames(feats), source: "detected", note: t.featCredited }
    : { value: "", source: "suggested", note: t.noFeat };

  const writers = credits.filter((c) => WRITER_ROLE.test(c.role) && !/mix|master|engineer|design|photo/i.test(c.role));
  g.songwriters = writers.length
    ? {
        value: writers.map((c) => `${c.name} (${c.role})${c.split != null ? ` ${c.split}%` : ""}`).join("; "),
        source: "detected",
        note: t.writersFromCredits,
      }
    : { value: "", source: "missing", note: t.whoWrote };

  const producers = byRole(/prod|beat/i);
  g.producers = producers.length
    ? { value: joinNames(producers), source: "detected", note: t.fromCredits }
    : { value: "", source: "missing", note: t.creditProducer };

  g.genre = project.genre
    ? { value: project.genre, source: "detected", note: t.genreFromProject(daw) }
    : { value: "Hip-Hop/Rap", source: "suggested", note: t.crewDefault };

  g.bpm =
    project.tempoBpm != null
      ? { value: String(Math.round(project.tempoBpm * 10) / 10), source: "detected", note: t.tempoFromProject(daw) }
      : {
          value: "",
          source: "missing",
          note: isSketch(project) ? t.sketchTempo : dawOf(project).readable === "none" ? t.closedFormat(daw) : t.noTempoFound,
        };

  const typedKey = meta.key;
  const nameKey = detectKey(project.trackNames);
  const audioKey = analysis?.key;
  const sure = (c: number) => t.sure(Math.round(c * 100));
  g.key = typedKey
    ? {
        value: typedKey,
        source: "detected",
        note:
          audioKey && audioKey.confidence >= KEY_SURE && audioKey.key !== typedKey && !relativeKeys(audioKey.key, typedKey)
            ? t.keyInPanelAudio(audioKey.key, sure(audioKey.confidence))
            : t.keyInPanel,
      }
    : nameKey
      ? { value: nameKey, source: "suggested", note: t.keyInTrackName }
      : audioKey
        ? audioKey.confidence >= KEY_SURE
          ? { value: audioKey.key, source: "detected", note: t.keyFromMixdown(sure(audioKey.confidence)) }
          : { value: audioKey.key, source: "suggested", note: t.keyFromMixdownUnsure(sure(audioKey.confidence)) }
        : { value: "", source: "missing", note: t.keyMissing };

  g.duration = analysis
    ? { value: formatDuration(analysis.durationSec), source: "detected", note: t.durationMeasured }
    : { value: "", source: "missing", note: t.durationMissing };

  g.explicit = { value: "", source: "missing", note: t.explicitMissing };

  const album = albums.find((a) => a.trackPaths.includes(project.path) && a.releaseDate);
  if (album?.releaseDate) {
    g.releaseDate = { value: album.releaseDate, source: "detected", note: t.fromRelease(album.title) };
  } else {
    // First Friday with enough lead time that nobody else is releasing on.
    const busy = new Set(input.busyDates ?? []);
    let friday = fridayAfter(today, LEAD_DAYS);
    let skipped = 0;
    while (busy.has(isoDate(friday)) && skipped < 12) {
      friday = new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() + 7);
      skipped++;
    }
    g.releaseDate = {
      value: isoDate(friday),
      source: "suggested",
      note: t.firstFriday(LEAD_DAYS, skipped),
    };
  }

  // Distribution details.
  const label = input.labelName?.trim();
  g.label = label
    ? { value: label, source: "suggested", note: t.labelCrew }
    : g.artists.value
      ? { value: g.artists.value.split(",")[0].trim(), source: "suggested", note: t.labelSelf }
      : { value: "", source: "suggested", note: t.labelEmpty };
  g.language = input.language?.trim()
    ? { value: input.language.trim(), source: "suggested", note: t.languageFromSettings }
    : { value: "", source: "missing", note: t.languageMissing };
  g.isrc = { value: "", source: "suggested", note: t.isrcNote };
  g.upc = { value: "", source: "suggested", note: t.upcNote };
  const inAlbum = albums.find((a) => a.trackPaths.includes(project.path));
  g.releaseType = inAlbum
    ? { value: KIND_LABEL[inAlbum.kind], source: "detected", note: t.fromRelease(inAlbum.title) }
    : { value: "Single", source: "suggested", note: t.singleNote };
  g.trackNumber = inAlbum
    ? { value: String(inAlbum.trackPaths.indexOf(project.path) + 1), source: "detected", note: t.trackPlace(inAlbum.title) }
    : { value: "1", source: "suggested", note: t.singleTrack1 };
  // releaseTitle and copyright are derived from final values in buildKit.
  g.releaseTitle = inAlbum
    ? { value: inAlbum.title, source: "detected", note: t.fromReleases }
    : { value: "", source: "suggested", note: t.singleReleaseTitle };
  g.copyright = { value: "", source: "suggested", note: t.copyrightNote };

  return g;
}

/** The factual part of a cover brief (specs, distributor rules). Kept out
 * of the AI's hands: it's the same for every release. */
export function briefSpecs(title: string, artists: string): string[] {
  return [
    `Cover art brief: "${title}"${artists ? ` by ${artists}` : ""}`,
    "",
    "Format: square, 3000 × 3000 px, JPG or PNG, RGB.",
    "Distributors reject covers with URLs, social handles, prices or store logos, and any text must match the release title and artist name.",
  ];
}

/** Templates that use the final (possibly edited) values. */
function coverBrief(v: Record<KitFieldId, string>, meta: SongMeta): string {
  const bpm = Number(v.bpm);
  const minor = /m$/.test(v.key);
  const lines = [
    ...briefSpecs(v.title, artistLine(v.artists, v.featuring)),
    "",
    "Vibe cues from the project:",
    v.bpm && !Number.isNaN(bpm) ? `- Tempo: ${v.bpm} BPM (${tempoFeel(bpm)})` : null,
    v.key ? `- Key: ${v.key} (${minor ? "minor: darker, moodier" : "major: brighter, open"})` : null,
    meta.tags?.length ? `- Tags: ${meta.tags.join(", ")}` : null,
    meta.notes?.trim() ? `- Notes: ${meta.notes.trim().slice(0, 240)}` : null,
    "",
    "It has to work as a thumbnail: one strong subject, the title readable when the cover is 64 px wide.",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

function captions(v: Record<KitFieldId, string>, lang: CaptionLang): string {
  const h = CAPTION_HEADINGS[lang];
  const prod = v.producers ? `\nprod. ${v.producers}` : "";
  const date = humanDate(v.releaseDate, lang);
  if (lang === "fr") {
    const who = artistLine(v.artists, v.featuring) || "[artiste]";
    return [
      `${h.announce}\n"${v.title}" de ${who}, dispo le ${date}.\nPré-save : lien en bio.`,
      `${h.teaser}\nVous êtes pas prêts pour celui-là. "${v.title}" sort le ${date}.`,
      `${h.releaseDay}\n"${v.title}" est dispo partout.${prod}\nLien en bio.`,
    ].join("\n\n");
  }
  const who = artistLine(v.artists, v.featuring) || "[artist]";
  return [
    `${h.announce}\n"${v.title}" by ${who}, out ${date}.\nPre-save link in bio.`,
    `${h.teaser}\nYou're not ready for this one. "${v.title}" drops ${date}.`,
    `${h.releaseDay}\n"${v.title}" is out now everywhere.${prod}\nLink in bio.`,
  ].join("\n\n");
}

/** The verification layer. Deterministic sanity checks for now; an AI pass
 * (roadmap principle 2) plugs in here and returns the same Check shape. */
export function verify(id: KitFieldId, value: string, today = new Date(), captionLang: CaptionLang = "fr"): Check | undefined {
  const v = value.trim();
  const t = tr(T);
  switch (id) {
    case "title":
      if (!v) return { level: "missing", message: t.needTitle };
      if (VERSION_TAG.test(v) || v.includes("_")) return { level: "warn", message: t.looksLikeFile };
      return;
    case "artists":
      return v ? undefined : { level: "missing", message: t.whoArtist };
    case "producers":
      return v ? undefined : { level: "warn", message: t.noProducer };
    case "genre":
      return v ? undefined : { level: "missing", message: t.genreRequired };
    case "bpm": {
      if (!v) return { level: "warn", message: t.noTempo };
      const n = Number(v);
      if (Number.isNaN(n)) return { level: "warn", message: t.notNumber };
      if (n < 50 || n > 220) return { level: "warn", message: t.unusualTempo };
      return;
    }
    case "key":
      if (!v) return { level: "warn", message: t.noKey };
      return KEYS.includes(v) ? undefined : { level: "warn", message: t.keyFormat };
    case "duration": {
      if (!v) return { level: "missing", message: t.noMixdownToMeasure };
      const m = /^(\d+):([0-5]\d)$/.exec(v);
      if (!m) return { level: "warn", message: t.durationFormat };
      return +m[1] * 60 + +m[2] < 30 ? { level: "warn", message: t.under30 } : undefined;
    }
    case "explicit":
      return v === "Yes" || v === "No" ? undefined : { level: "missing", message: t.explicitAsk };
    case "releaseDate": {
      const d = parseDate(v);
      if (!d) return { level: "missing", message: t.pickDate };
      const days = Math.round((d.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY);
      if (days < 0) return { level: "warn", message: t.pastDate };
      if (days < PITCH_DAYS) return { level: "warn", message: t.underWeek };
      if (d.getDay() !== 5) return { level: "warn", message: t.notFriday };
      return;
    }
    case "coverBrief":
      return /\[[^\]]+\]/.test(v) ? { level: "warn", message: t.placeholders } : undefined;
    case "captions": {
      if (/\[[^\]]+\]/.test(v)) return { level: "warn", message: t.placeholders };
      const mixed = captionLanguageIssue(v, captionLang);
      return mixed ? { level: "warn", message: mixed } : undefined;
    }
    case "featuring":
      return;
    case "songwriters": {
      if (!v) return { level: "missing", message: t.writersRequired };
      const parts = v.split(";").map((p) => p.trim()).filter(Boolean);
      const splits = parts.map((p) => /(\d+(?:[.,]\d+)?)\s*%/.exec(p)?.[1]).map((n) => (n ? Number(n.replace(",", ".")) : null));
      const given = splits.filter((n): n is number => n !== null);
      if (given.length && given.length < parts.length) return { level: "warn", message: t.splitAll };
      const sum = given.reduce((a, b) => a + b, 0);
      if (given.length && Math.abs(sum - 100) > 0.5) return { level: "warn", message: t.splitsSum(Math.round(sum * 10) / 10) };
      return;
    }
    case "label":
      return v ? undefined : { level: "warn", message: t.noLabel };
    case "copyright":
      return /\b(19|20)\d{2}\b/.test(v) ? undefined : { level: "warn", message: t.addYear };
    case "language":
      return v ? undefined : { level: "missing", message: t.languageAsk };
    case "isrc":
      return !v || /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i.test(v) ? undefined : { level: "warn", message: t.isrcFormat };
    case "upc":
      return !v || /^\d{12,13}$/.test(v) ? undefined : { level: "warn", message: t.upcFormat };
    case "releaseTitle":
      return v ? undefined : { level: "missing", message: t.releaseTitleNeeded };
    case "releaseType":
      return RELEASE_TYPES.includes(v) ? undefined : { level: "missing", message: t.releaseTypeAsk };
    case "trackNumber":
      return /^\d{1,3}$/.test(v) && Number(v) > 0 ? undefined : { level: "warn", message: t.trackNumberAsk };
  }
}

/** Labels in the exported files (metadata.csv, checklist): always English. */
const LABELS = T_LABELS.en;

/** What a distributor's upload form asks beyond the basics. */
export const DISTRIBUTION_FIELDS: KitFieldId[] = [
  "featuring",
  "songwriters",
  "releaseType",
  "releaseTitle",
  "trackNumber",
  "label",
  "copyright",
  "language",
  "isrc",
  "upc",
];

/** File name for the master and the sheet: "Ana feat. Ben - Night Run". */
export function masterBaseName(fields: KitField[], fallback: string): string {
  const get = (id: KitFieldId) => fields.find((f) => f.id === id)?.value ?? "";
  const title = get("title") || fallback;
  const who = artistLine(get("artists"), get("featuring"));
  return who ? `${who} - ${title}` : title;
}

export const METADATA_FIELDS: KitFieldId[] = ["title", "artists", "producers", "genre", "bpm", "key", "duration", "explicit"];

/** Every field with user edits applied and checked. */
export function buildKit(input: KitInput): KitField[] {
  const edits = input.meta.launchKit?.edits ?? {};
  const g = generate(input);
  const values = {} as Record<KitFieldId, string>;
  for (const id of Object.keys(g) as KitFieldId[]) values[id] = edits[id] ?? g[id].value;
  // Text pieces are generated from the final values, so editing the title
  // flows into the captions unless those were edited too.
  const ai = input.meta.launchKit?.ai;
  const drafts = ai?.drafts;
  values.releaseTitle = edits.releaseTitle ?? (g.releaseTitle.value || values.title);
  const year = /^(\d{4})-/.exec(values.releaseDate)?.[1] ?? String((input.today ?? new Date()).getFullYear());
  values.copyright = edits.copyright ?? (values.label ? `℗ ${year} ${values.label}` : "");
  values.coverBrief = edits.coverBrief ?? drafts?.coverBrief ?? coverBrief(values, input.meta);
  const captionLang = input.captionLanguage ?? "fr";
  values.captions = edits.captions ?? drafts?.captions ?? captions(values, captionLang);
  // AI text bakes in the title/artist/date it was written for.
  const basis = drafts?.basis;
  const draftsOutdated =
    !!basis &&
    (basis.title !== values.title ||
      basis.artists !== values.artists ||
      basis.releaseDate !== values.releaseDate ||
      (basis.language ?? "en") !== captionLang);

  const t = tr(T);
  const field = (id: KitFieldId, kind: KitField["kind"], gen: { source: FieldSource; note: string }, options?: string[]): KitField => {
    const edited = edits[id] !== undefined;
    const review = ai?.review?.fields[id];
    const outdated = draftsOutdated && !edited && (id === "captions" || id === "coverBrief");
    return {
      id,
      label: fieldLabel(id),
      value: values[id],
      source: edited ? "edited" : gen.source,
      note: edited ? t.youChanged : gen.note,
      kind,
      options,
      check: outdated ? { level: "warn", message: t.draftsOutdated } : verify(id, values[id], input.today, captionLang),
      review: review && { ...review, stale: outdated || review.checkedValue !== values[id] },
    };
  };
  const drafted = drafts
    ? { source: "ai" as const, note: t.aiWritten(drafts.model) }
    : { source: "suggested" as const, note: t.draftedFromFields };
  return [
    field("title", "text", g.title),
    field("artists", "text", g.artists),
    field("producers", "text", g.producers),
    field("genre", "text", g.genre),
    field("bpm", "text", g.bpm),
    field("key", "text", g.key),
    field("duration", "text", g.duration),
    field("explicit", "choice", g.explicit, ["Yes", "No"]),
    field("releaseDate", "date", g.releaseDate),
    field("coverBrief", "multiline", drafted),
    field("captions", "multiline", drafted),
    field("featuring", "text", g.featuring),
    field("songwriters", "text", g.songwriters),
    field("releaseType", "choice", g.releaseType, RELEASE_TYPES),
    field("releaseTitle", "text", g.releaseTitle.value ? g.releaseTitle : { source: "suggested", note: t.sameAsSongTitle }),
    field("trackNumber", "text", g.trackNumber),
    field("label", "text", g.label),
    field("copyright", "text", g.copyright),
    field("language", "text", g.language),
    field("isrc", "text", g.isrc),
    field("upc", "text", g.upc),
  ];
}

/** Below this, an AI verdict is shown as low confidence. */
export const LOW_CONFIDENCE = 0.6;

/** Where the AI check stands for the whole kit. */
export function aiSummary(fields: KitField[]): {
  state: "unchecked" | "stale" | "checked";
  flagged: number;
  /** Fields the model skipped in its last answer. */
  skipped: number;
  verified: boolean;
} {
  const reviewed = fields.filter((f) => f.review);
  if (reviewed.length === 0) return { state: "unchecked", flagged: 0, skipped: 0, verified: false };
  const fresh = reviewed.filter((f) => !f.review!.stale);
  const flagged = fresh.filter((f) => f.review!.verdict !== "ok" || f.review!.confidence < LOW_CONFIDENCE).length;
  const skipped = fields.length - reviewed.length;
  const state = fresh.length < reviewed.length ? "stale" : "checked";
  return { state, flagged, skipped, verified: state === "checked" && skipped === 0 && flagged === 0 };
}

/** Kit-level problems that aren't one field's. */
export function kitChecks(project: ProjectInfo, analysis?: AudioAnalysis | null): Check[] {
  const tip = dawOf(project).exportTip;
  const freshness = renderFreshness(project);
  const t = tr(T);
  if (freshness === "none") return [{ level: "missing", message: t.noMixdown }];
  const out: Check[] = [];
  if (freshness === "stale") out.push({ level: "warn", message: t.staleMixdown });
  if (analysis?.master) out.push(...masterChecks(analysis.master, tip));
  return out;
}

/** What distributors accept: lossless WAV (FLAC at some), 44.1 kHz,
 * 16 or 24-bit, stereo, not clipping. */
export function masterChecks(m: MasterSpec, FL_EXPORT_TIP = tr(T).defaultExportTip): Check[] {
  const t = tr(T);
  const out: Check[] = [];
  const name = m.container.toUpperCase() || "This file";
  if (m.container === "mp3" || m.container === "ogg") {
    out.push({ level: "warn", message: t.masterLossy(name, FL_EXPORT_TIP) });
  } else if (m.container === "flac") {
    out.push({ level: "warn", message: t.masterFlac(FL_EXPORT_TIP) });
  }
  if (m.sampleRate === 48000) {
    out.push({ level: "warn", message: t.master48(FL_EXPORT_TIP) });
  } else if (m.sampleRate && m.sampleRate !== 44100) {
    out.push({ level: "warn", message: t.masterRate(m.sampleRate, FL_EXPORT_TIP) });
  }
  if (m.bitsPerSample != null && m.bitsPerSample !== 16 && m.bitsPerSample !== 24) {
    out.push({ level: "warn", message: t.masterBits(m.bitsPerSample, FL_EXPORT_TIP) });
  }
  if (m.channels === 1) out.push({ level: "warn", message: t.mono });
  if (m.clippedSamples >= 3) out.push({ level: "warn", message: t.clipping(m.clippedSamples) });
  return out;
}

/** Lengths a snippet can be set to (reels/stories/TikTok-friendly). */
export const SNIPPET_LENGTHS = [7, 15, 30, 60];

/** Snippets with the user's moves and lengths applied. The label follows
 * the length ("Hook 15s" set to 30 s reads "Hook 30s"); `key` keeps the
 * detected label the edits are stored under. Clips always fit the track. */
export function kitSnippets(analysis: AudioAnalysis | null, meta: SongMeta): Snippet[] {
  const starts = meta.launchKit?.snippetStarts ?? {};
  const lengths = meta.launchKit?.snippetLengths ?? {};
  const duration = analysis?.durationSec ?? Infinity;
  return (analysis?.snippets ?? []).map((s) => {
    const lengthSec = Math.min(lengths[s.label] ?? s.lengthSec, duration);
    const startSec = Math.min(Math.max(0, starts[s.label] ?? s.startSec), Math.max(0, duration - lengthSec));
    const label = lengthSec === s.lengthSec ? s.label : `${s.label.replace(/\s*\d+s$/, "")} ${Math.round(lengthSec)}s`;
    return { ...s, key: s.label, label, startSec, lengthSec };
  });
}

// Quoted, and a leading = + - @ is defused so spreadsheets don't run it.
const csvCell = (s: string) => `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;

/** The text files of an exported kit. Always English (bar the README and
 * captions, which follow the kit's language): build `fields` and `extra`
 * inside `inEnglish` so their check messages are too. */
/** A credited person's profile IDs for the kit (People → Profiles). */
export interface KitArtist {
  name: string;
  /** The credit roles, joined ("Artist, Producer"). */
  roles: string;
  /** Platform label → id and link; empty when nothing was looked up. */
  profiles: { label: string; id: string; url: string }[];
}

/** The song's credited people with their looked-up profile IDs, in credit
 * order; people without profiles are kept (listed as "not looked up") so
 * the gap is visible before uploading. Nothing without an id is included. */
export function kitArtists(meta: SongMeta, people: Person[]): KitArtist[] {
  const out: KitArtist[] = [];
  for (const credit of meta.credits ?? []) {
    const person = people.find((p) => p.id === credit.personId);
    if (!person) continue;
    const existing = out.find((a) => a.name === person.name);
    if (existing) {
      if (!existing.roles.split(", ").includes(credit.role)) existing.roles += `, ${credit.role}`;
      continue;
    }
    out.push({
      name: person.name,
      roles: credit.role,
      // Only ids that count: a by-name guess (Deezer, Apple Music) needs confirming first.
      profiles: (person.links ?? []).filter((l) => l.id && linkVerified(l)).map((l) => ({ label: l.label, id: l.id!, url: l.url })),
    });
  }
  return out;
}

function artistIdsMarkdown(title: string, artists: KitArtist[]): string {
  const lines = [`# Artist IDs: "${title}"`, "", "Paste these when the distributor asks to link a track to an existing artist profile (Spotify artist ID, Apple Music ID…). Looked up in Hivo → People → Profiles.", ""];
  for (const a of artists) {
    lines.push(`## ${a.name} (${a.roles})`);
    if (a.profiles.length === 0) {
      lines.push("- (no profiles looked up yet: People → this person → Look up profiles)");
    } else {
      for (const p of a.profiles) lines.push(`- ${p.label}: ${p.id}  (${p.url})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function kitFiles(fields: KitField[], snippets: Snippet[], extra: Check[], lang: KitLang = "en", masterExt: string | null = "wav", artists: KitArtist[] | null = null): { name: string; content: string }[] {
  const get = (id: KitFieldId) => fields.find((f) => f.id === id)?.value ?? "";
  const meta = METADATA_FIELDS.concat("releaseDate", DISTRIBUTION_FIELDS);
  const aiFlags: Check[] = fields.flatMap((f) =>
    f.review && !f.review.stale && (f.review.verdict !== "ok" || f.review.confidence < LOW_CONFIDENCE)
      ? [{ level: "warn" as const, message: `${LABELS[f.id]}: AI says ${f.review.reason || f.review.verdict}` }]
      : [],
  );
  const open = [...extra, ...fields.flatMap((f) => (f.check ? [{ ...f.check, message: `${LABELS[f.id]}: ${f.check.message}` }] : [])), ...aiFlags];
  const json = {
    ...Object.fromEntries(meta.map((id) => [id, get(id)])),
    snippets: snippets.map((s) => ({ file: `snippets/${s.label}.wav`, startSec: s.startSec, lengthSec: s.lengthSec })),
    openChecks: open.map((c) => `${c.level}: ${c.message}`),
    ...(artists ? { artists: artists.map((a) => ({ name: a.name, roles: a.roles, profiles: a.profiles })) } : {}),
    generatedAt: new Date().toISOString(),
  };
  const guide = kitGuide(lang, {
    title: get("title"),
    master: masterExt ? `${masterBaseName(fields, get("title"))}.${masterExt}` : null,
    snippets: snippets.map((s) => s.label),
  });
  return [
    { name: "README.md", content: kitReadme(guide, lang) },
    { name: "metadata.json", content: JSON.stringify(json, null, 2) },
    {
      name: "metadata.csv",
      // BOM so Excel reads accented names (é, ñ) as UTF-8.
      content: "﻿" + [meta.map((id) => csvCell(LABELS[id])).join(","), meta.map((id) => csvCell(get(id))).join(",")].join("\n") + "\n",
    },
    { name: "distributor-sheet.md", content: distributorSheet(get, snippets, open, masterBaseName(fields, get("title")), artists) },
    ...(artists ? [{ name: "artist-ids.md", content: artistIdsMarkdown(get("title"), artists) }] : []),
    { name: "cover-brief.md", content: get("coverBrief") + "\n" },
    { name: "captions.md", content: get("captions") + "\n" },
    {
      name: "checklist.md",
      content:
        `# ${get("title")}: before you upload\n\n` +
        (open.length ? open.map((c) => `- [ ] ${c.message}`).join("\n") : "- [x] All checks passed") +
        "\n",
    },
  ];
}

/** Every value in the order distributors' upload forms ask for it, ready to
 * copy field by field (DistroKid, TuneCore, CD Baby, Amuse…). */
function distributorSheet(get: (id: KitFieldId) => string, snippets: Snippet[], open: Check[], master: string, artists: KitArtist[] | null = null): string {
  const or = (v: string, empty: string) => v.trim() || empty;
  const hook = snippets.find((s) => /hook/i.test(s.label)) ?? snippets[0];
  const writers = get("songwriters")
    .split(";")
    .map((w) => w.trim())
    .filter(Boolean);
  const lines = [
    `# Distributor sheet: "${get("title")}"`,
    "",
    "Copy each value into your distributor's upload form. Optional fields left empty: leave them blank there too.",
    "",
    "## Release",
    `- Release type: ${or(get("releaseType"), "Single")}`,
    `- Release title: ${or(get("releaseTitle"), get("title"))}`,
    `- Release date: ${get("releaseDate")}${get("releaseDate") ? ` (${humanDate(get("releaseDate"), "en")})` : ""}`,
    `- Label: ${or(get("label"), "(your artist name)")}`,
    `- ℗ / © line: ${or(get("copyright"), "(year + label)")}`,
    `- UPC / EAN: ${or(get("upc"), "(leave empty: assigned for free)")}`,
    "",
    `## Track ${or(get("trackNumber"), "1")}`,
    `- Track title: ${get("title")}`,
    `- Primary artist(s): ${get("artists")}`,
    `- Featured artist(s): ${or(get("featuring"), "(none)")}`,
    `- Songwriters (legal names):${writers.length ? "\n" + writers.map((w) => `  - ${w}`).join("\n") : " (missing)"}`,
    `- Producer(s): ${or(get("producers"), "(none credited)")}`,
    `- Genre: ${get("genre")}`,
    `- Lyrics language: ${or(get("language"), "(missing)")}`,
    `- Explicit: ${or(get("explicit"), "(answer Yes or No)")}`,
    `- ISRC: ${or(get("isrc"), "(leave empty: assigned for free)")}`,
    hook ? `- Preview / TikTok start: ${formatDuration(hook.startSec)} (the ${hook.label} snippet)` : null,
    `- BPM / key: ${[get("bpm"), get("key")].filter(Boolean).join(" / ") || "(not needed)"}`,
    `- Duration: ${get("duration")}`,
    ...(artists
      ? [
          "",
          "## Artist profiles (link the track to existing profiles)",
          ...artists.map((a) => `- ${a.name} (${a.roles}): ${a.profiles.length ? a.profiles.map((p) => `${p.label} ${p.id}`).join(" · ") : "(no profiles looked up yet)"}`),
        ]
      : []),
    "",
    "## Files",
    `- Audio: "${master}" in this folder. Distributors want WAV, 16 or 24-bit, 44.1 kHz.`,
    "- Cover: 3000 × 3000 px JPG, RGB. cover-concept.jpg is a draft to brief the designer, not the final cover.",
    "",
    "## Before you submit",
    open.length ? open.map((c) => `- [ ] ${c.message}`).join("\n") : "- [x] All checks passed",
  ];
  return lines.filter((l) => l !== null).join("\n") + "\n";
}

/** Plausible analysis for sample data (no real audio): verse/hook shape. */
export function demoAnalysis(project: ProjectInfo): AudioAnalysis {
  let seed = [...project.path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const windowSec = 0.5;
  const durationSec = 150 + Math.floor(rand() * 60);
  const energy = Array.from({ length: durationSec / windowSec }, (_, i) => {
    const t = i * windowSec;
    const section = Math.floor(t / 20) % 3 === 1 ? 0.95 : 0.6; // hooks every third 20s block
    const edge = Math.min(1, t / 8, (durationSec - t) / 8);
    return Math.max(0.05, (section + rand() * 0.08) * edge);
  });
  const loudest = (len: number, skip?: [number, number]) => {
    const n = len / windowSec;
    let best = -1;
    let bestSum = -1;
    for (let i = 0; i + n <= energy.length; i++) {
      if (skip && i < skip[1] && i + n > skip[0]) continue;
      const sum = energy.slice(i, i + n).reduce((a, b) => a + b, 0);
      if (sum > bestSum) [best, bestSum] = [i, sum];
    }
    return best * windowSec;
  };
  const hook = loudest(15);
  return {
    durationSec,
    windowSec,
    energy,
    snippets: [
      { label: "Hook 15s", startSec: hook, lengthSec: 15 },
      { label: "Teaser 30s", startSec: loudest(30), lengthSec: 30 },
      { label: "Alt 15s", startSec: loudest(15, [hook / windowSec, (hook + 15) / windowSec]), lengthSec: 15 },
    ],
  };
}

// ---- What's in an exported kit (README.md + the popup after export) ----

export type KitLang = "en" | "fr";

export interface KitGuideItem {
  /** File or folder in the kit. */
  file: string;
  /** What it is. */
  what: string;
  /** What to do with it. */
  todo: string;
}

export interface KitGuide {
  title: string;
  intro: string;
  items: KitGuideItem[];
  /** The order to do things in. */
  steps: string[];
}

/** One text for the README and the popup, in the kit's language. Shorts and
 * the cover concept are listed too: they land in the same folder when made. */
export function kitGuide(lang: KitLang, { title, master, snippets }: { title: string; master: string | null; snippets: string[] }): KitGuide {
  const fr = lang === "fr";
  const clips = snippets.length ? snippets.join(", ") : fr ? "aucun extrait" : "no snippets";
  const items: KitGuideItem[] = [
    {
      file: "distributor-sheet.md",
      what: fr ? "Toutes les infos de la sortie, dans l'ordre du formulaire du distributeur." : "Every release detail, in the order distributors ask for them.",
      todo: fr
        ? "Copie chaque ligne dans DistroKid, TuneCore, Amuse… pendant l'upload."
        : "Copy each line into DistroKid, TuneCore, Amuse… while you upload.",
    },
    ...(master
      ? [
          {
            file: master,
            what: fr ? "Le mixdown final à envoyer." : "The final mixdown to upload.",
            todo: fr ? "C'est le fichier audio à donner au distributeur." : "This is the audio file you give the distributor.",
          },
        ]
      : []),
    {
      file: "snippets/",
      what: fr ? `Extraits pour les réseaux (${clips}).` : `Clips for socials (${clips}).`,
      todo: fr
        ? "Poste-les en reels, stories et TikTok avant la sortie (le teaser d'abord, le hook ensuite)."
        : "Post them as reels, stories and TikToks before release (the teaser first, then the hook).",
    },
    {
      file: "shorts/",
      what: fr ? "Vidéos 9:16 prêtes à poster, si tu les as rendues." : "Ready-to-post 9:16 videos, if you rendered them.",
      todo: fr ? "Publie-les telles quelles sur Reels, Shorts et TikTok." : "Post them as they are on Reels, Shorts and TikTok.",
    },
    {
      file: "captions.md",
      what: fr ? "Les textes des posts : annonce, teaser, jour de sortie." : "Post texts: announcement, teaser, release day.",
      todo: fr ? "Colle chaque texte sous le post qui va avec, au bon moment." : "Paste each one under the matching post, at the right time.",
    },
    {
      file: "cover-brief.md",
      what: fr ? "La direction artistique de la cover." : "Art direction for the cover.",
      todo: fr ? "Donne-la au graphiste (avec cover-concept.jpg si tu en as choisi un)." : "Give it to the designer (with cover-concept.jpg if you picked one).",
    },
    {
      file: "checklist.md",
      what: fr ? "Ce qui reste à vérifier avant l'upload." : "What's still open before you upload.",
      todo: fr ? "Coche tout avant d'envoyer la sortie." : "Tick everything off before you send the release.",
    },
    {
      file: "metadata.json / metadata.csv",
      what: fr ? "Les mêmes infos pour un tableur ou un autre outil." : "The same details for a spreadsheet or another tool.",
      todo: fr ? "Optionnel : importe-les si ton outil le permet." : "Optional: import them if your tool can.",
    },
  ];
  return {
    title: fr ? `Kit de sortie : ${title}` : `Launch kit: ${title}`,
    intro: fr ? "Tout ce qu'il faut pour sortir ce son. Voici ce que contient le dossier et quoi en faire." : "Everything you need to release this song. Here's what's in the folder and what to do with it.",
    items,
    steps: fr
      ? [
          "Vérifie checklist.md.",
          "Upload le mixdown chez ton distributeur avec distributor-sheet.md (vise 3 à 4 semaines avant la sortie pour les playlists).",
          "Fais la cover à partir de cover-brief.md.",
          "Avant la sortie : poste le teaser et les extraits avec les textes de captions.md.",
          "Le jour J : poste le texte « jour de sortie ».",
        ]
      : [
          "Check checklist.md.",
          "Upload the mixdown to your distributor using distributor-sheet.md (aim for 3-4 weeks before release, for playlist pitching).",
          "Get the cover made from cover-brief.md.",
          "Before release: post the teaser and snippets with the texts from captions.md.",
          "On release day: post the release-day text.",
        ],
  };
}

/** README.md for the kit folder. */
export function kitReadme(guide: KitGuide, lang: KitLang): string {
  const fr = lang === "fr";
  return [
    `# ${guide.title}`,
    "",
    guide.intro,
    "",
    fr ? "## Dans ce dossier" : "## In this folder",
    "",
    ...guide.items.map((i) => `- **${i.file}**: ${i.what} ${i.todo}`),
    "",
    fr ? "## Dans l'ordre" : "## In order",
    "",
    ...guide.steps.map((s, n) => `${n + 1}. ${s}`),
    "",
    fr ? "_Généré par Hivo._" : "_Made with Hivo._",
    "",
  ].join("\n");
}
