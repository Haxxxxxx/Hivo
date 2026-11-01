import { useEffect, useState } from "react";
import { Check, FolderPlus, RefreshCw } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { btn } from "../ui";
import { dict, tr } from "../i18n";

const T = dict(
  {
    looking: "Looking for DAW folders…",
    none: "No DAW's default projects folder was found on this computer. This only checks the usual default places: if you save your projects somewhere else, add that folder above.",
    listLabel: "DAW folders found on this computer",
    empty: "No projects in it yet",
    projects: (n: number) => `${n >= 999 ? "999+" : n} project${n === 1 ? "" : "s"}`,
    linked: "Linked",
    linking: "Linking…",
    link: "Link",
    lookAgain: "Look again",
    failed: (e: string) => `Couldn't look for DAW folders: ${e}`,
  },
  {
    looking: "Recherche des dossiers de DAW…",
    none: "Aucun dossier de projets par défaut de DAW trouvé sur cet ordi. Seuls les emplacements par défaut habituels sont vérifiés : si tu enregistres tes projets ailleurs, ajoute ce dossier au-dessus.",
    listLabel: "Dossiers de DAW trouvés sur cet ordi",
    empty: "Pas encore de projet dedans",
    projects: (n: number) => `${n >= 999 ? "999+" : n} projet${n === 1 ? "" : "s"}`,
    linked: "Relié",
    linking: "Liaison…",
    link: "Relier",
    lookAgain: "Chercher encore",
    failed: (e: string) => `Impossible de chercher les dossiers de DAW : ${e}`,
  },
);

/** Every DAW's default projects folder found on this computer, each linked
 * only when the user says so (first-run screen and Settings). */
export function DetectedFolders({ compact = false }: { compact?: boolean }) {
  const detected = useAppStore((s) => s.detectedFolders);
  const detectFolders = useAppStore((s) => s.detectFolders);
  const detectError = useAppStore((s) => s.detectError);
  const linkDetected = useAppStore((s) => s.linkDetected);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (detected === null) void detectFolders();
  }, [detected, detectFolders]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const t = tr(T);
  if (detected === null) return <div className="text-xs text-engrave">{t.looking}</div>;

  return (
    <div className={`flex flex-col gap-2 ${compact ? "text-left" : ""}`}>
      {detectError ? (
        <div className="text-xs text-missing">{t.failed(detectError)}</div>
      ) : detected.length === 0 ? (
        <div className="text-xs text-engrave">{t.none}</div>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label={t.listLabel}>
          {detected.map((f) => (
            <li key={f.path} className="flex items-center gap-3 rounded-md border border-rule bg-raised px-3 py-2 text-sm">
              <span className="w-28 shrink-0 font-medium text-cream">{f.daw}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-body" title={f.path}>
                  {f.path}
                </span>
                <span className="text-[11px] text-engrave">
                  {f.projects === 0 ? t.empty : t.projects(f.projects)}
                </span>
              </span>
              {f.linked ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-300">
                  <Check size={13} /> {t.linked}
                </span>
              ) : (
                <button onClick={() => void run(f.path, () => linkDetected(f.path))} disabled={busy !== null} className={`${btn} shrink-0 text-xs`}>
                  <FolderPlus size={13} /> {busy === f.path ? t.linking : t.link}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <button onClick={() => void run("again", detectFolders)} disabled={busy !== null} className="flex items-center gap-1 text-xs text-engrave hover:text-cream">
          <RefreshCw size={12} className={busy === "again" ? "animate-spin" : ""} /> {t.lookAgain}
        </button>
        {error && <span className="text-xs text-red-300">{error}</span>}
      </div>
    </div>
  );
}
