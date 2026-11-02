import { useState } from "react";
import { useCrewStore } from "../store/useCrewStore";
import { btn, input } from "../ui";
import { dict, tr } from "../i18n";
import { errorText } from "../lib/errors";

const T = dict(
  {
    title: "Delete this crew",
    what: (crew: string, n: number) =>
      `Everyone loses access to ${crew} (${n === 1 ? "just you" : `${n} members`}): its board, shared releases, columns and invite codes are deleted from the crew server.`,
    kept: "Nothing on anyone's computer is touched: songs, notes, stages and releases stay, and every app goes back to solo mode.",
    start: "Delete crew…",
    typeName: (crew: string) => `Type ${crew} to confirm`,
    confirm: "Delete for everyone",
    deleting: "Deleting…",
    cancel: "Cancel",
  },
  {
    title: "Supprimer ce crew",
    what: (crew: string, n: number) =>
      `Tout le monde perd l'accès à ${crew} (${n === 1 ? "juste toi" : `${n} membres`}) : son tableau, les sorties partagées, les colonnes et les codes d'invitation sont supprimés du serveur du crew.`,
    kept: "Rien n'est touché sur les ordis : sons, notes, étapes et sorties restent, et chaque app repasse en mode solo.",
    start: "Supprimer le crew…",
    typeName: (crew: string) => `Tape ${crew} pour confirmer`,
    confirm: "Supprimer pour tout le monde",
    deleting: "Suppression…",
    cancel: "Annuler",
  },
);

/** Owner only (Crew settings): delete the active crew, the name typed back.
 * The server checks the owner and the name again (delete_crew). */
export function DeleteCrew() {
  const crew = useCrewStore((s) => s.crews.find((c) => c.id === s.activeCrewId));
  const members = useCrewStore((s) => s.members.length);
  const deleteCrew = useCrewStore((s) => s.deleteCrew);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!crew || crew.role !== "owner") return null;
  const t = tr(T);
  const matches = typed.trim().toLowerCase() === crew.name.trim().toLowerCase();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteCrew(typed);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-md border border-missing/40 p-4">
      <h3 className="text-sm font-medium text-cream">{t.title}</h3>
      <p className="text-xs text-body">{t.what(crew.name, Math.max(members, 1))}</p>
      <p className="text-xs text-engrave">{t.kept}</p>
      {!open ? (
        <button onClick={() => setOpen(true)} className={`${btn} self-start`}>
          {t.start}
        </button>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !busy) void submit();
          }}
        >
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t.typeName(crew.name)}
            aria-label={t.typeName(crew.name)}
            className={`${input} w-64`}
            disabled={busy}
          />
          <button type="submit" disabled={!matches || busy} className="rounded border border-missing/60 bg-missing/15 px-3 py-1.5 text-xs text-cream hover:bg-missing/25 disabled:opacity-40">
            {busy ? t.deleting : t.confirm}
          </button>
          <button type="button" onClick={() => (setOpen(false), setTyped(""), setError(null))} disabled={busy} className="text-xs text-engrave hover:text-cream">
            {t.cancel}
          </button>
        </form>
      )}
      {error && (
        <div role="alert" className="rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">
          {error}
        </div>
      )}
    </section>
  );
}
