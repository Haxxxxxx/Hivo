import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { digIsStale, useDigger } from "../store/useDigger";
import { useAppStore } from "../store/useAppStore";
import { beatFactsLine, nameQueries } from "../lib/digger";
import { currentLang, dict, tr } from "../i18n";
import type { YoutubeStatus } from "../types";
import { chip, label, secondary } from "./DigResults";
import { errorDetail, errorReason } from "../lib/errors";

// The right side of the Digger: the picked beats, the AI dig (what they
// share, what Gemini heard, the searches, "Go deeper"). The results live
// in the main area (DigResults). Links only: nothing is ever downloaded
// (docs/GUARDRAILS.md).

const NB = " ";
const T = dict(
  {
    title: "Picked",
    none: "Pick the beats that have the vibe you want (up to 5).",
    dig: "Dig",
    digging: "Listening and digging…",
    digTitle: "What they share",
    needAi: "The dig uses Gemini (free). Add a key in",
    listen: "Let Gemini listen (30 seconds of each beat)",
    disclosure: (audio: boolean) =>
      "Sends the beats' file names, tempo, key, loudness and length to Google Gemini" +
      (audio ? ", plus a 30-second, low-quality excerpt of each beat" : "") +
      `. Never file paths${audio ? "" : " or audio"}. On the free tier Google may use what it receives to improve its products.`,
    stale: "Your picks changed since this dig. Dig again to update it.",
    heardTitle: "What Gemini heard",
    namesOnly: "Based on names, tempo and key only. Tick \"Let Gemini listen\" for the sound itself.",
    aiSearches: "Searches from the dig",
    round: (n: number) => `Round ${n}`,
    deeper: "Go deeper",
    deeperSeeded: (n: number) => `Go deeper · seeded from ${n} pick${n > 1 ? "s" : ""}`,
    deeperRunning: "Digging deeper…",
    find: "Find similar beats",
    ideas: "Searches from your picks",
    noKey: "Add a YouTube key in Settings to see results in the app. Without one, searches open in your browser.",
    setUp: "Settings",
    failed: (n: number) => `${n} beat${n > 1 ? "s" : ""} couldn't be read, the dig went on without ${n > 1 ? "them" : "it"}:`,
    tryAgain: "Try again",
    tryAgainTitle: "Tries Gemini's web search again now (for example after a new key) as a new round.",
  },
  {
    title: "Choisies",
    none: "Choisis les prods qui ont le vibe que tu cherches (5 max).",
    dig: "Creuser",
    digging: "Écoute et recherche…",
    digTitle: "Ce qu'elles ont en commun",
    needAi: "Le Digger utilise Gemini (gratuit). Ajoute une clé dans les",
    listen: "Faire écouter à Gemini (30 secondes de chaque prod)",
    disclosure: (audio: boolean) =>
      "Envoie à Google Gemini le nom des fichiers, le tempo, la tonalité, le volume et la durée des prods" +
      (audio ? ", plus un extrait de 30 secondes, en basse qualité, de chaque prod" : "") +
      `. Jamais les chemins de fichiers${audio ? "" : " ni l'audio"}. Avec l'offre gratuite, Google peut utiliser ce qu'il reçoit pour améliorer ses produits.`,
    stale: "Tes choix ont changé depuis. Creuse à nouveau pour mettre à jour.",
    heardTitle: "Ce que Gemini a entendu",
    namesOnly: `D'après les noms, le tempo et la tonalité seulement. Coche «${NB}Faire écouter à Gemini${NB}» pour le son lui-même.`,
    aiSearches: "Recherches tirées de l'analyse",
    round: (n: number) => `Tour ${n}`,
    deeper: "Creuser plus loin",
    deeperSeeded: (n: number) => `Creuser plus loin · à partir de ${n} sélection${n > 1 ? "s" : ""}`,
    deeperRunning: "On creuse…",
    find: "Trouver des prods proches",
    ideas: "Recherches tirées de tes choix",
    noKey: "Ajoute une clé YouTube dans les Réglages pour voir les résultats dans l'app. Sans clé, les recherches s'ouvrent dans ton navigateur.",
    setUp: "Réglages",
    failed: (n: number) => `${n} prod${n > 1 ? "s" : ""} illisible${n > 1 ? "s" : ""}, la recherche a continué sans${NB}:`,
    tryAgain: "Réessayer",
    tryAgainTitle: "Relance la recherche web de Gemini maintenant (par exemple après une nouvelle clé), dans un nouveau tour.",
  },
);

interface Props {
  yt: YoutubeStatus | null;
  /** The round on screen (DigResults): its new searches are shown here. */
  round: number;
}

export function DigPanel({ yt, round }: Props) {
  const t = tr(T);
  const d = useDigger();
  const { picked, beats, webQuery, rounds, setWebQuery, searchYoutube } = d;
  const setView = useAppStore((s) => s.setView);
  const aiStatus = useAppStore((s) => s.aiStatus);
  const sendAudio = useAppStore((s) => !!s.settings.digSendAudio);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const byPath = useMemo(() => new Map(beats.map((b) => [b.path, b])), [beats]);
  const ideas = useMemo(() => nameQueries(picked.map((p) => byPath.get(p)?.name ?? "")), [picked, byPath]);

  const q = webQuery.trim();
  const run = (query: string) => {
    setWebQuery(query);
    if (yt?.configured && query.trim()) void searchYoutube(query);
  };
  const dig = d.dig;
  const stale = !!dig && digIsStale(picked, d.dugFor);
  const roundQueries = round > 0 ? (rounds[round - 1]?.queries ?? []) : [];
  // The picks' own searches matter until the dig writes better ones.
  const showIdeas = !dig && ideas.length > 0;
  const showNoKey = !!yt && !yt.configured;

  return (
    <aside className="flex min-h-0 w-[clamp(320px,38%,460px)] shrink-0 flex-col gap-3 overflow-y-auto border-l border-rule p-4" aria-label={t.title}>
      <h2 className={label}>{t.title}</h2>
      {picked.length === 0 ? (
        <p className="text-sm text-engrave">{t.none}</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {picked.map((p, i) => (
            <li key={p} className="flex items-start gap-2 text-sm">
              <span className="w-4 shrink-0 pt-0.5 font-mono text-[11px] text-engrave">{i + 1}</span>
              <span title={byPath.get(p)?.name ?? p} className="line-clamp-2 min-w-0 break-words text-cream">{byPath.get(p)?.name ?? p}</span>
            </li>
          ))}
        </ol>
      )}

      {picked.length > 0 && (
        <div className="flex flex-col gap-2">
          <label className="flex cursor-pointer items-start gap-2 text-xs text-body">
            <input type="checkbox" checked={sendAudio} onChange={(e) => void updateSettings({ digSendAudio: e.target.checked })} className="mt-0.5 accent-orange-500" />
            {t.listen}
          </label>
          {aiStatus && !aiStatus.configured ? (
            <p className="text-[11px] leading-relaxed text-engrave">
              {t.needAi}{" "}
              <button onClick={() => setView("settings", "ai")} className="underline hover:text-cream">
                {t.setUp}
              </button>
              .
            </p>
          ) : (
            <button
              onClick={() => void d.runDig(currentLang(), !!yt?.configured)}
              disabled={d.digging}
              className="flex items-center justify-center gap-2 rounded bg-hot px-4 py-2 font-display text-[15px] font-bold uppercase tracking-[0.06em] text-chassis hover:bg-hot-hover disabled:opacity-50"
            >
              <Sparkles size={15} aria-hidden /> {d.digging ? t.digging : t.dig}
            </button>
          )}
          <p className="text-[11px] leading-relaxed text-engrave">{t.disclosure(sendAudio)}</p>
          {d.digError && <div role="alert" className="rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">{d.digError}</div>}
        </div>
      )}

      {dig && (
        <section aria-label={t.digTitle} className="flex flex-col gap-2 border-t border-rule pt-3">
          <h2 className={label}>{t.digTitle}</h2>
          {stale && <p className="text-[11px] text-warn">{t.stale}</p>}
          <p className="text-sm leading-relaxed text-cream">{dig.analysis.summary}</p>
          {(dig.analysis.traits.length > 0 || dig.analysis.tempo) && (
            <ul className="flex flex-wrap gap-1.5">
              {dig.analysis.tempo && <li className="rounded bg-raised px-2 py-0.5 font-mono text-[11px] text-cream">{dig.analysis.tempo}</li>}
              {dig.analysis.traits.map((tag) => (
                <li key={tag} className="rounded bg-raised px-2 py-0.5 text-[11px] text-body">
                  {tag}
                </li>
              ))}
            </ul>
          )}
          <ul className="flex flex-col gap-0.5">
            {dig.beats.map((b, i) => (
              <li key={i} className="flex gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-engrave">{b.name}</span>
                <span className="shrink-0 font-mono text-body">{beatFactsLine(b)}</span>
              </li>
            ))}
          </ul>
          {(dig.failed ?? []).length > 0 && (
            <div role="status" className="flex flex-col gap-0.5 text-[11px] text-warn">
              <span>{t.failed(dig.failed.length)}</span>
              <ul className="flex flex-col gap-0.5">
                {dig.failed.map((f, i) => (
                  <li key={i} className="truncate text-engrave" title={errorDetail(f.error)}>
                    {f.name}: {errorReason(f.error)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {dig.audioSent && dig.analysis.heard ? (
            <div className="flex flex-col gap-1">
              <h3 className={label}>{t.heardTitle}</h3>
              <p className="text-sm leading-relaxed text-body">{dig.analysis.heard}</p>
            </div>
          ) : (
            !dig.audioSent && <p className="text-[11px] leading-relaxed text-engrave">{t.namesOnly}</p>
          )}
          {dig.analysis.queries.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className={label}>{t.aiSearches}</h3>
              <div className="flex flex-wrap gap-1.5" aria-label={t.aiSearches}>
                {dig.analysis.queries.map((s) => (
                  <button key={s} onClick={() => run(s)} className={chip(s === q)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {roundQueries.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className={label}>{t.round(round + 1)}</h3>
              <div className="flex flex-wrap gap-1.5" aria-label={t.round(round + 1)}>
                {roundQueries.map((s) => (
                  <button key={s} onClick={() => run(s)} className={chip(s === q)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {dig.webError && (
            <p className="text-[11px] text-engrave">
              {errorReason(dig.webError)}{" "}
              <button onClick={() => void d.retryWeb(currentLang(), !!yt?.configured)} disabled={d.diggingDeeper || d.digging} title={t.tryAgainTitle} className="underline hover:text-cream disabled:opacity-40">
                {t.tryAgain}
              </button>
            </p>
          )}
          {d.deeperError && <p className="text-[11px] text-engrave">{d.deeperError}</p>}
          <button onClick={() => void d.runDeeper(currentLang(), !!yt?.configured)} disabled={d.diggingDeeper || d.digging} className={`${secondary} self-start`}>
            {d.diggingDeeper ? t.deeperRunning : d.liked.length > 0 ? t.deeperSeeded(d.liked.length) : t.deeper}
          </button>
        </section>
      )}

      {(showIdeas || showNoKey) && (
        <section aria-label={t.find} className="flex flex-col gap-2 border-t border-rule pt-3">
          <h2 className={label}>{t.find}</h2>
          {showIdeas && (
            <div className="flex flex-wrap gap-1.5" aria-label={t.ideas}>
              {ideas.map((idea) => (
                <button key={idea} onClick={() => run(idea)} className={chip(idea === q)}>
                  {idea}
                </button>
              ))}
            </div>
          )}
          {showNoKey && (
            <p className="text-[11px] leading-relaxed text-engrave">
              {t.noKey}{" "}
              <button onClick={() => setView("settings", "youtube")} className="underline hover:text-cream">
                {t.setUp}
              </button>
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
