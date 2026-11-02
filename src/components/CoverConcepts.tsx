import { useEffect, useState } from "react";
import { Check, FolderOpen, ImageIcon, Images, RefreshCw, Save } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { previousKitFolder } from "../lib/kitState";
import { buildCoverPrompt, COVER_VARIANTS, FREE_NEURONS_PER_DAY, NEURONS_PER_IMAGE, randomSeeds } from "../lib/cover";
import type { CoverImage } from "../types";
import { btn, btnPrimary } from "./ui";
import { dict, locale, tr } from "../i18n";

interface Concept {
  prompt: string;
  variant: number;
  seed: number;
  image?: CoverImage;
  error?: string;
}

interface Session {
  concepts: Concept[];
  picked: number | null;
}

// Generated images live here, in memory, per song: they survive switching
// views but never go into the workspace (only the pick's seed/prompt does).
const sessions = new Map<string, Session>();
const listeners = new Set<() => void>();
const EMPTY: Session = { concepts: [], picked: null };

function update(path: string, fn: (s: Session) => Session) {
  sessions.set(path, fn(sessions.get(path) ?? EMPTY));
  listeners.forEach((l) => l());
}

function useSession(path: string): Session {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return sessions.get(path) ?? EMPTY;
}

/** The picked concept's image (base64 JPEG) while it's in memory, for the shorts. */
export function usePickedConcept(path: string): string | null {
  const s = useSession(path);
  return s.picked != null ? (s.concepts[s.picked]?.image?.imageB64 ?? null) : null;
}

const PER_DAY = Math.floor(FREE_NEURONS_PER_DAY / NEURONS_PER_IMAGE);

const T = dict(
  {
    setUpHint: (perDay: number) =>
      `Turn this brief into cover concepts with FLUX. It's free: a Cloudflare account gives about ${perDay} images a day, no card needed.`,
    setUp: "Set up",
    needExportFolder: "Set an export folder in Settings first.",
    saved: "Saved as cover-concept.jpg in the kit folder.",
    heading: "Cover concepts · FLUX",
    painting: "Painting…",
    fourNew: "4 new concepts",
    generateFour: "Generate 4 concepts",
    moreLikeThisHint: "Four more with this concept's prompt and new seeds",
    moreLikeThis: "More like this",
    saveOffDemo: "Saving is off for sample data",
    saveWhere: "Writes cover-concept.jpg into <export folder>/Launch Kits/<song>/",
    saving: "Saving…",
    saveToKit: "Save to kit",
    concept: (n: number) => `Concept ${n}`,
    conceptAlt: (n: number) => `Cover concept ${n}`,
    picked: "Picked",
    clickToPick: "Click a concept to pick it.",
    show: "Show",
    savedInKit: "A concept is saved in the kit (cover-concept.jpg).",
    promptSent: (seed: number, notApplied: boolean) => `Prompt sent to FLUX (seed ${seed}${notApplied ? ", not applied by Cloudflare" : ""})`,
    draftsNote: (size: string) =>
      `Concepts are drafts at ${size} px. Distributors need 3000 × 3000: a designer (or an upscaler) makes the final from the pick and adds the title and artist name, which FLUX leaves out on purpose.`,
    quotaNote: (perImage: number, perDay: number) =>
      `Each concept uses about ${perImage} of Cloudflare's ${FREE_NEURONS_PER_DAY.toLocaleString("en")} free daily neurons (about ${perDay} a day). Only the image prompt goes to Cloudflare: this brief's concept, imagery, palette, tags and any free text you add, without the title, artist names or the Notes line (see it under "Prompt sent to FLUX").`,
  },
  {
    setUpHint: (perDay: number) =>
      `Transforme ce brief en concepts de cover avec FLUX. C'est gratuit : un compte Cloudflare donne environ ${perDay} images par jour, sans carte bancaire.`,
    setUp: "Configurer",
    needExportFolder: "Choisis d'abord un dossier d'export dans les Réglages.",
    saved: "Enregistré sous cover-concept.jpg dans le dossier du kit.",
    heading: "Concepts de cover · FLUX",
    painting: "Génération…",
    fourNew: "4 nouveaux concepts",
    generateFour: "Générer 4 concepts",
    moreLikeThisHint: "Quatre de plus avec le prompt de ce concept et de nouvelles seeds",
    moreLikeThis: "Plus dans ce style",
    saveOffDemo: "Pas d'enregistrement avec les données d'exemple",
    saveWhere: "Écrit cover-concept.jpg dans <dossier d'export>/Launch Kits/<son>/",
    saving: "Enregistrement…",
    saveToKit: "Enregistrer dans le kit",
    concept: (n: number) => `Concept ${n}`,
    conceptAlt: (n: number) => `Concept de cover ${n}`,
    picked: "Choisi",
    clickToPick: "Clique sur un concept pour le choisir.",
    show: "Voir",
    savedInKit: "Un concept est enregistré dans le kit (cover-concept.jpg).",
    promptSent: (seed: number, notApplied: boolean) => `Prompt envoyé à FLUX (seed ${seed}${notApplied ? ", pas appliquée par Cloudflare" : ""})`,
    draftsNote: (size: string) =>
      `Les concepts sont des brouillons en ${size} px. Les distributeurs veulent du 3000 × 3000 : un graphiste (ou un upscaler) fait la version finale à partir de ton choix et ajoute le titre et le nom de l'artiste, que FLUX laisse de côté exprès.`,
    quotaNote: (perImage: number, perDay: number) =>
      `Chaque concept utilise environ ${perImage} des ${FREE_NEURONS_PER_DAY.toLocaleString(locale())} neurons gratuits par jour de Cloudflare (environ ${perDay} images par jour). Seul le prompt de l'image part chez Cloudflare : le concept du brief, l'imagerie, la palette, les tags et le texte libre que tu ajoutes, sans le titre, les noms d'artistes ni la ligne Notes (vois-le sous « Prompt envoyé à FLUX »).`,
  },
);

/** FLUX cover concepts (Cloudflare Workers AI, free tier) for the brief
 * above. Drafts at 1024 px; the final cover is a designer's job. */
export function CoverConcepts({ path, title, artists, brief, releaseType }: { path: string; title: string; artists: string; brief: string; releaseType?: string }) {
  const coverStatus = useAppStore((s) => s.coverStatus);
  const settings = useAppStore((s) => s.settings);
  const demoMode = useAppStore((s) => s.demoMode);
  const saved = useAppStore((s) => s.workspace.songs[path]?.launchKit?.cover);
  const songMeta = useAppStore((s) => s.workspace.songs[path]);
  const setKitCover = useAppStore((s) => s.setKitCover);
  const setView = useAppStore((s) => s.setView);
  const session = useSession(path);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; dir?: string } | null>(null);

  const t = tr(T);
  if (!coverStatus?.configured) {
    return (
      <div className="mt-4 flex items-center gap-3 rounded-lg border border-rule bg-panel p-3 text-sm">
        <ImageIcon size={16} className="shrink-0 text-orange-300" />
        <span className="flex-1 text-xs text-body">{t.setUpHint(PER_DAY)}</span>
        <button onClick={() => setView("settings", "cover")} className={btn}>
          {t.setUp}
        </button>
      </div>
    );
  }

  const running = session.concepts.some((c) => !c.image && !c.error);
  const picked = session.picked != null ? session.concepts[session.picked] : undefined;
  const size = session.concepts.find((c) => c.image?.width)?.image;

  function generate(batch: { prompt: string; variant: number }[]) {
    setMessage(null);
    const seeds = randomSeeds(batch.length);
    const concepts = batch.map((b, i) => ({ ...b, seed: seeds[i] }));
    update(path, () => ({ concepts, picked: null }));
    concepts.forEach((c, i) => {
      api
        .generateCover(c.prompt, c.seed)
        .then((image) => patch(i, c.seed, { image, seed: image.seed }))
        .catch((e) => patch(i, c.seed, { error: e instanceof Error ? e.message : String(e) }));
    });
  }

  /** Fill slot i, unless a newer batch replaced it meanwhile. */
  function patch(i: number, seed: number, p: Partial<Concept>) {
    update(path, (s) => (s.concepts[i]?.seed !== seed ? s : { ...s, concepts: s.concepts.map((c, j) => (j === i ? { ...c, ...p } : c)) }));
  }

  function generateFour() {
    generate(COVER_VARIANTS.map((_, variant) => ({ prompt: buildCoverPrompt({ brief, title, artists, variant, releaseType }), variant })));
  }

  function moreLikeThis() {
    if (!picked) return;
    generate(Array.from({ length: 4 }, () => ({ prompt: picked.prompt, variant: picked.variant })));
  }

  function pick(i: number) {
    const c = session.concepts[i];
    if (!c?.image) return;
    update(path, (s) => ({ ...s, picked: i }));
    setMessage(null);
    // Keep the record of a saved cover: picking isn't saving.
    setKitCover(path, { ...saved, seed: c.seed, prompt: c.prompt, variant: c.variant });
  }

  async function save() {
    if (!picked?.image) return;
    if (!settings.outputFolder) return setMessage({ kind: "error", text: t.needExportFolder });
    setSaving(true);
    try {
      const file = await api.saveCover({ song: path, previousFolder: previousKitFolder(songMeta), folderName: title, imageB64: picked.image.imageB64 });
      setKitCover(path, { seed: picked.seed, prompt: picked.prompt, variant: picked.variant, savedPath: file, savedAtMs: Date.now() });
      setMessage({ kind: "ok", text: t.saved, dir: file });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-rule pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">{t.heading}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={generateFour} disabled={running || !brief.trim()} className={session.concepts.length ? btn : btnPrimary}>
            <Images size={14} /> {running ? t.painting : session.concepts.length ? t.fourNew : t.generateFour}
          </button>
          {picked && (
            <>
              <button onClick={moreLikeThis} disabled={running} className={btn} title={t.moreLikeThisHint}>
                <RefreshCw size={14} /> {t.moreLikeThis}
              </button>
              <button
                onClick={save}
                disabled={running || saving || demoMode}
                title={demoMode ? t.saveOffDemo : t.saveWhere}
                className={btnPrimary}
              >
                <Save size={14} /> {saving ? t.saving : t.saveToKit}
              </button>
            </>
          )}
        </div>
      </div>

      {session.concepts.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {session.concepts.map((c, i) => (
            <button
              key={`${c.seed}-${i}`}
              onClick={() => pick(i)}
              disabled={!c.image}
              aria-pressed={session.picked === i}
              aria-label={t.concept(i + 1)}
              className={`relative aspect-square overflow-hidden rounded-md border bg-panel ${
                session.picked === i ? "border-orange-400 ring-2 ring-orange-400/60" : "border-rule hover:border-engrave"
              }`}
            >
              {c.image ? (
                <img src={`data:image/jpeg;base64,${c.image.imageB64}`} alt={t.conceptAlt(i + 1)} className="h-full w-full object-cover" />
              ) : c.error ? (
                <span className="absolute inset-0 flex items-center justify-center p-3 text-center text-[11px] leading-snug text-red-300">{c.error}</span>
              ) : (
                <span className="absolute inset-0 flex motion-safe:animate-pulse items-center justify-center text-[11px] text-engrave">{t.painting}</span>
              )}
              {session.picked === i && (
                <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-orange-500 px-1.5 py-0.5 text-[10px] font-medium text-chassis">
                  <Check size={10} /> {t.picked}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {session.concepts.length > 0 && !running && session.picked == null && session.concepts.some((c) => c.image) && (
        <div className="text-xs text-engrave">{t.clickToPick}</div>
      )}
      {message && (
        <div className={`flex items-center gap-2 text-xs ${message.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>
          {message.text}
          {message.dir && (
            <button onClick={() => api.revealInFileManager(message.dir!)} className="flex items-center gap-1 underline">
              <FolderOpen size={12} /> {t.show}
            </button>
          )}
        </div>
      )}
      {!session.concepts.length && saved?.savedPath && (
        <div className="flex items-center gap-2 text-xs text-engrave">
          {t.savedInKit}
          <button onClick={() => api.revealInFileManager(saved.savedPath!)} className="flex items-center gap-1 text-body underline hover:text-cream">
            <FolderOpen size={12} /> {t.show}
          </button>
        </div>
      )}

      {picked && (
        <details className="text-[11px] text-engrave">
          <summary className="cursor-pointer hover:text-body">{t.promptSent(picked.seed, !!picked.image && !picked.image.seedApplied)}</summary>
          <p className="mt-1 whitespace-pre-wrap font-mono leading-relaxed text-engrave">{picked.prompt}</p>
        </details>
      )}

      <div className="rounded-md border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200/80">
        {t.draftsNote(size?.width && size.height ? `${size.width} × ${size.height}` : "1024 × 1024")}
      </div>
      <div className="text-[11px] leading-relaxed text-engrave">{t.quotaNote(Math.round(NEURONS_PER_IMAGE), PER_DAY)}</div>
    </div>
  );
}
