import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FolderOpen, RefreshCw } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { errorText } from "../lib/errors";
import { ConfirmButton, btn } from "./ui";
import { dict, plural, tr } from "../i18n";

// Folders whose song is gone. Deleting a song leaves its folder standing
// whenever real files are still in it — the takes recorded into it, the
// mixdown bounced out of it — and says so at the time. But that prompt
// speaks once, to whoever happens to be looking. A folder orphaned before
// the prompt existed, or by a delete where it was dismissed, had no way
// back: Hivo stops seeing a folder as a song the moment its project file
// goes. This is where they are found again.

const T = dict(
  {
    title: "Leftovers",
    hint: "Folders whose song is gone, still holding what was in them — recordings, mixdowns. Hivo never deletes these with the song; it is your call, and they go to the Trash, not away.",
    none: "Nothing left over. Every folder in your linked folders still has its song.",
    back: "Back to the library",
    refresh: "Look again",
    count: (n: number) => `${n} folder${plural(n, "", "s")}`,
    files: (n: number) => `${n} file${plural(n, "", "s")}`,
    remove: "Delete folder",
    reveal: "Show in folder",
  },
  {
    title: "Restes",
    hint: "Des dossiers dont le son a disparu, qui gardent encore ce qu'il y avait dedans — enregistrements, mixdowns. Hivo ne les supprime jamais avec le son : c'est toi qui décides, et ils vont à la corbeille, pas dans le vide.",
    none: "Rien qui traîne. Chaque dossier de tes dossiers liés a encore son son.",
    back: "Retour à la bibliothèque",
    refresh: "Regarder à nouveau",
    count: (n: number) => `${n} dossier${plural(n, "", "s")}`,
    files: (n: number) => `${n} fichier${plural(n, "", "s")}`,
    remove: "Supprimer le dossier",
    reveal: "Afficher dans le dossier",
  },
);

const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function LeftoversView() {
  const setView = useAppStore((s) => s.setView);
  const listOrphanFolders = useAppStore((s) => s.listOrphanFolders);
  const deleteSongFolders = useAppStore((s) => s.deleteSongFolders);
  const [rows, setRows] = useState<api.KeptFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = tr(T);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRows(await listOrphanFolders());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [listOrphanFolders]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-6 py-3">
        <div className="mr-auto">
          <h1 className="font-display text-3xl uppercase leading-none tracking-tight text-cream">{t.title}</h1>
          <p className="mt-1 max-w-2xl text-xs text-engrave">{t.hint}</p>
        </div>
        <span className="text-xs text-engrave">{t.count(rows.length)}</span>
        <button onClick={() => void load()} disabled={busy} className={`${btn} text-xs`} title={t.refresh}>
          <RefreshCw size={13} className={busy ? "motion-safe:animate-spin" : ""} />
        </button>
        <button onClick={() => setView("library")} className={`${btn} text-xs`}>
          <ArrowLeft size={13} /> {t.back}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {error && <div className="mb-3 text-sm text-red-300">{error}</div>}
        {rows.length === 0 && !busy ? (
          <div className="text-sm text-engrave">{t.none}</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <li
                key={r.path}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-rule bg-panel px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-cream">{folderName(r.path)}</span>
                <span className="text-xs text-engrave">{t.files(r.files)}</span>
                {/* What KIND of thing is in there, so the choice is informed. */}
                <span className="min-w-0 flex-1 truncate text-xs text-engrave">{r.examples.join(", ")}</span>
                <button
                  onClick={() => void api.revealInFileManager(r.path).catch(() => {})}
                  aria-label={t.reveal}
                  title={t.reveal}
                  className="shrink-0 rounded p-1 text-engrave hover:text-cream"
                >
                  <FolderOpen size={13} />
                </button>
                <ConfirmButton
                  label={t.remove}
                  confirmLabel={t.remove}
                  onConfirm={async () => {
                    try {
                      await deleteSongFolders([r.path]);
                      setRows((v) => v.filter((x) => x.path !== r.path));
                      setError(null);
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                  className={`${btn} py-1 text-xs text-red-300 hover:bg-red-500/10`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
