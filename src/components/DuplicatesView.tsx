import { useMemo } from "react";
import { ArrowLeft, Copy, FolderOpen } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { duplicateGroups } from "../lib/duplicates";
import { formatBpm } from "../lib/songs";
import { formatRelative } from "../lib/format";
import { btn, sectionLabel } from "../ui";
import { dict, plural, tr } from "../i18n";

// Songs saved several times over the same material. EVIDENCE ONLY: this
// screen never says which version to keep and Hivo never deletes anything
// here. A version can differ in automation or mixer settings the .flp
// reader cannot see, so a confident "safe to delete" about someone's vocal
// take is a claim this cannot honestly make.

const T = dict(
  {
    title: "Duplicates",
    hint: "Songs that share their distinctive samples — the same stems or vocal takes saved under more than one project. Hivo shows what they share and how they differ; what to keep is your call, and nothing is deleted here.",
    none: "No songs share enough material to look like versions of each other.",
    back: "Back to the library",
    groups: (n: number) => `${n} group${plural(n, "", "s")}`,
    shared: (n: number) => `${n} shared sample${plural(n, "", "s")}`,
    sameTempo: "Same tempo",
    tempoDiffers: "Tempo differs",
    samePlugins: "Same plugins",
    pluginsDiffer: "Plugins differ",
    saved: "Last saved",
    samples: (n: number) => `${n} sample${plural(n, "", "s")}`,
    only: (names: string) => `Only here: ${names}`,
    reveal: "Show in folder",
    sharedList: "Shared samples",
  },
  {
    title: "Doublons",
    hint: "Des sons qui partagent leurs samples distinctifs — les mêmes stems ou prises de voix enregistrés sous plusieurs projets. Hivo montre ce qu'ils partagent et ce qui diffère ; ce que tu gardes, c'est toi qui décides, et rien n'est supprimé ici.",
    none: "Aucun son ne partage assez de matière pour ressembler à une autre version.",
    back: "Retour à la bibliothèque",
    groups: (n: number) => `${n} groupe${plural(n, "", "s")}`,
    shared: (n: number) => `${n} sample${plural(n, "", "s")} en commun`,
    sameTempo: "Même tempo",
    tempoDiffers: "Tempo différent",
    samePlugins: "Mêmes plugins",
    pluginsDiffer: "Plugins différents",
    saved: "Dernière sauvegarde",
    samples: (n: number) => `${n} sample${plural(n, "", "s")}`,
    only: (names: string) => `Seulement ici : ${names}`,
    reveal: "Afficher dans le dossier",
    sharedList: "Samples en commun",
  },
);

export function DuplicatesView() {
  const projects = useAppStore((s) => s.projects);
  const setView = useAppStore((s) => s.setView);
  const openDetail = useAppStore((s) => s.openDetail);
  const t = tr(T);

  const groups = useMemo(() => duplicateGroups(projects), [projects]);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-6 py-3">
        <div className="mr-auto">
          <h1 className="font-display text-3xl uppercase leading-none tracking-tight text-cream">{t.title}</h1>
          <p className="mt-1 max-w-2xl text-xs text-engrave">{t.hint}</p>
        </div>
        <span className="text-xs text-engrave">{t.groups(groups.length)}</span>
        <button onClick={() => setView("library")} className={`${btn} text-xs`}>
          <ArrowLeft size={13} /> {t.back}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {groups.length === 0 ? (
          <div className="text-sm text-engrave">{t.none}</div>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <section key={g.id} className="rounded-lg border border-rule bg-panel p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Copy size={13} className="text-engrave" />
                  <span className="text-cream">{t.shared(g.sharedSamples.length)}</span>
                  <span className={g.sameTempo ? "text-engrave" : "text-amber-300"}>
                    {g.sameTempo ? t.sameTempo : t.tempoDiffers}
                  </span>
                  <span className={g.samePlugins ? "text-engrave" : "text-amber-300"}>
                    {g.samePlugins ? t.samePlugins : t.pluginsDiffer}
                  </span>
                </div>

                <ul className="mt-3 flex flex-col gap-1.5">
                  {g.members.map((m) => (
                    <li
                      key={m.path}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-rule bg-raised px-3 py-2 text-sm"
                    >
                      <button onClick={() => openDetail(m.path)} className="min-w-0 flex-1 truncate text-left text-cream hover:underline">
                        {m.name}
                      </button>
                      <span className="text-xs text-engrave">
                        {t.saved} {formatRelative(m.savedMs)}
                      </span>
                      <span className="text-xs text-engrave">{formatBpm(m.tempoBpm)} BPM</span>
                      <span className="text-xs text-engrave">{t.samples(m.sampleCount)}</span>
                      {m.pluginsNotInAll.length > 0 && (
                        <span className="text-xs text-amber-300">{t.only(m.pluginsNotInAll.join(", "))}</span>
                      )}
                      <button
                        onClick={() => void api.revealInFileManager(m.path).catch(() => {})}
                        aria-label={t.reveal}
                        title={t.reveal}
                        className="shrink-0 rounded p-1 text-engrave hover:text-cream"
                      >
                        <FolderOpen size={13} />
                      </button>
                    </li>
                  ))}
                </ul>

                <details className="mt-3">
                  <summary className={`${sectionLabel} cursor-pointer`}>{t.sharedList}</summary>
                  <div className="mt-1.5 font-mono text-[11px] leading-5 text-engrave">
                    {g.sharedSamples.join("  ·  ")}
                  </div>
                </details>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
