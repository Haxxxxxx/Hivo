import { useState } from "react";
import { Plus, Send, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { detectedPeople } from "../lib/people";
import type { PitchOutcome, ProjectInfo } from "../types";
import { btn, input } from "./ui";
import { dict, tr } from "../i18n";

const T = dict(
  {
    name: "Name",
    newPerson: "+ New person…",
    unknown: "Unknown",
    splitTitle: "Agreed split (%)",
    splitsOver: (n: number) => `Splits add up to ${n}%.`,
    inSession: "In this session:",
    suggestTitle: "Found in the song's mixer/recording track names — click to credit",
    creditSomeone: "Credit someone",
    notSent: "Not sent to anyone yet.",
    notePlaceholder: "Note (feedback, price, link…)",
    logSend: "Log a send",
    cancelNew: "Cancel new person",
    removeCredit: (name: string) => `Remove ${name} from the credits`,
    removeSend: (name: string) => `Remove the send to ${name}`,
  },
  {
    name: "Nom",
    newPerson: "+ Nouvelle personne…",
    unknown: "Inconnu",
    splitTitle: "Répartition convenue (%)",
    splitsOver: (n: number) => `Les répartitions font ${n} %.`,
    inSession: "Dans cette session :",
    suggestTitle: "Trouvé dans les noms de pistes du mixer ou des prises du son — clique pour créditer",
    creditSomeone: "Créditer quelqu'un",
    notSent: "Envoyé à personne pour l'instant.",
    notePlaceholder: "Note (retour, prix, lien…)",
    logSend: "Noter un envoi",
    cancelNew: "Annuler la nouvelle personne",
    removeCredit: (name: string) => `Retirer ${name} des crédits`,
    removeSend: (name: string) => `Supprimer l'envoi à ${name}`,
  },
);

// Roles are stored as these English words (they're data: shared with the
// crew, used by the Launch Kit); only what's shown is translated.
export const ROLES = ["Producer", "Co-producer", "Vocals", "Feature", "Writer", "Mix", "Master", "Engineer", "Other"];

const T_ROLES = dict(
  {
    Producer: "Producer",
    "Co-producer": "Co-producer",
    Vocals: "Vocals",
    Feature: "Feature",
    Writer: "Writer",
    Mix: "Mix",
    Master: "Master",
    Engineer: "Engineer",
    Other: "Other",
  },
  {
    Producer: "Prod",
    "Co-producer": "Coprod",
    Vocals: "Voix",
    Feature: "Feat",
    Writer: "Auteur",
    Mix: "Mix",
    Master: "Master",
    Engineer: "Ingé son",
    Other: "Autre",
  },
);

/** A credit role as shown (custom roles stay as typed). */
export function roleLabel(role: string): string {
  const t = tr(T_ROLES) as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(t, role) ? t[role] : role;
}

const T_OUTCOMES = dict(
  { sent: "Sent", listened: "Listened", interested: "Interested", placed: "Placed", sold: "Sold", passed: "Passed" },
  { sent: "Envoyé", listened: "Écouté", interested: "Intéressé", placed: "Placé", sold: "Vendu", passed: "Refusé" },
);

const outcome = (id: PitchOutcome, tone: string) => ({
  id,
  tone,
  get label() {
    return tr(T_OUTCOMES)[id];
  },
});

export const OUTCOMES: { id: PitchOutcome; label: string; tone: string }[] = [
  outcome("sent", "text-body"),
  outcome("listened", "text-body"),
  outcome("interested", "text-sky-300"),
  outcome("placed", "text-emerald-300"),
  outcome("sold", "text-emerald-300"),
  outcome("passed", "text-engrave"),
];

const today = () => new Date().toISOString().slice(0, 10);
const small = "rounded border border-rule bg-panel px-1.5 py-0.5 text-[11px] text-body";

/** Pick an existing person or type a new name (created on submit). */
function PersonPicker({ onPick, label }: { onPick: (personId: string) => void; label: string }) {
  const people = useAppStore((s) => s.workspace.people);
  const createPerson = useAppStore((s) => s.createPerson);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  if (naming || people.length === 0) {
    return (
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onPick(createPerson(name));
          setName("");
          setNaming(false);
        }}
      >
        <input autoFocus={naming} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr(T).name} className={`${input} py-1 text-xs`} />
        <button type="submit" className={`${btn} py-1 text-xs`}>
          {label}
        </button>
        {people.length > 0 && (
          <button type="button" onClick={() => setNaming(false)} aria-label={tr(T).cancelNew} className="text-engrave hover:text-cream">
            <X size={13} />
          </button>
        )}
      </form>
    );
  }
  return (
    <label className={`${btn} relative cursor-pointer py-1 text-xs`}>
      <Plus size={12} /> {label}
      <select
        value=""
        onChange={(e) => (e.target.value === "__new" ? setNaming(true) : e.target.value && onPick(e.target.value))}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="" />
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="__new">{tr(T).newPerson}</option>
      </select>
    </label>
  );
}

export function SongCredits({ project }: { project: ProjectInfo }) {
  const people = useAppStore((s) => s.workspace.people);
  const meta = useAppStore((s) => s.workspace.songs[project.path]);
  const updateSong = useAppStore((s) => s.updateSong);
  const openPerson = useAppStore((s) => s.openPerson);
  const credits = meta?.credits ?? [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const suggested = detectedPeople(project, people).filter((p) => !credits.some((c) => c.personId === p.id));

  const setCredits = (next: typeof credits) => updateSong(project.path, { credits: next });
  const add = (personId: string, role = "Vocals") => {
    if (!credits.some((c) => c.personId === personId)) setCredits([...credits, { personId, role }]);
  };
  const splitTotal = credits.reduce((t, c) => t + (c.split ?? 0), 0);
  const t = tr(T);

  return (
    <div>
      <div className="flex flex-col gap-1.5">
        {credits.map((c, i) => (
          <div key={c.personId} className="flex items-center gap-2 text-xs">
            <button onClick={() => openPerson(c.personId)} className="min-w-0 flex-1 truncate text-left text-cream hover:underline">
              {byId.get(c.personId)?.name ?? t.unknown}
            </button>
            <select
              value={c.role}
              onChange={(e) => setCredits(credits.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
              className={small}
            >
              {ROLES.map((r) => (
                <option key={r} value={r} className="bg-raised">
                  {roleLabel(r)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-0.5 text-engrave" title={t.splitTitle}>
              <input
                type="number"
                min={0}
                max={100}
                value={c.split ?? ""}
                placeholder="—"
                onChange={(e) =>
                  setCredits(
                    credits.map((x, j) =>
                      j === i ? { ...x, split: e.target.value === "" ? undefined : Math.max(0, Math.min(100, Number(e.target.value))) } : x,
                    ),
                  )
                }
                className={`${small} w-11 text-right`}
              />
              %
            </label>
            <button
              onClick={() => setCredits(credits.filter((_, j) => j !== i))}
              aria-label={t.removeCredit(byId.get(c.personId)?.name ?? t.unknown)}
              className="text-engrave hover:text-cream"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      {splitTotal > 100 && <div className="mt-1 text-[11px] text-amber-300">{t.splitsOver(splitTotal)}</div>}

      {suggested.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-engrave">{t.inSession}</span>
          {suggested.map((p) => (
            <button
              key={p.id}
              onClick={() => add(p.id)}
              title={t.suggestTitle}
              className="rounded-full border border-dashed border-rule-strong px-2 py-0.5 text-[11px] text-body hover:border-engrave hover:text-cream"
            >
              + {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2">
        <PersonPicker label={t.creditSomeone} onPick={(id) => add(id, "Feature")} />
      </div>
    </div>
  );
}

export function SongPitches({ project }: { project: ProjectInfo }) {
  const people = useAppStore((s) => s.workspace.people);
  const pitches = useAppStore((s) => s.workspace.songs[project.path]?.pitches) ?? [];
  const addPitch = useAppStore((s) => s.addPitch);
  const updatePitch = useAppStore((s) => s.updatePitch);
  const removePitch = useAppStore((s) => s.removePitch);
  const openPerson = useAppStore((s) => s.openPerson);
  const byId = new Map(people.map((p) => [p.id, p]));
  const sorted = [...pitches].sort((a, b) => b.date.localeCompare(a.date));
  const t = tr(T);

  return (
    <div>
      {sorted.length === 0 && <div className="mb-2 text-xs text-engrave">{t.notSent}</div>}
      <div className="flex flex-col gap-1.5">
        {sorted.map((p) => {
          const outcome = OUTCOMES.find((o) => o.id === p.outcome);
          return (
            <div key={p.id} className="group text-xs">
              <div className="flex items-center gap-2">
                <Send size={11} className="shrink-0 text-engrave" />
                <button onClick={() => openPerson(p.personId)} className="min-w-0 flex-1 truncate text-left text-cream hover:underline">
                  {byId.get(p.personId)?.name ?? t.unknown}
                </button>
                <input
                  type="date"
                  value={p.date}
                  onChange={(e) => e.target.value && updatePitch(project.path, p.id, { date: e.target.value })}
                  className={`${small} w-[108px]`}
                />
                <select
                  value={p.outcome}
                  onChange={(e) => updatePitch(project.path, p.id, { outcome: e.target.value as PitchOutcome })}
                  className={`${small} ${outcome?.tone ?? ""}`}
                >
                  {OUTCOMES.map((o) => (
                    <option key={o.id} value={o.id} className="bg-raised text-cream">
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => removePitch(project.path, p.id)}
                  aria-label={t.removeSend(byId.get(p.personId)?.name ?? t.unknown)}
                  className="text-engrave opacity-0 hover:text-cream focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>
              <input
                value={p.note ?? ""}
                onChange={(e) => updatePitch(project.path, p.id, { note: e.target.value })}
                placeholder={t.notePlaceholder}
                className="ml-5 mt-0.5 w-[calc(100%-1.25rem)] rounded border border-transparent bg-transparent text-[11px] text-engrave placeholder:text-engrave focus:border-hot focus:outline-none"
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2">
        <PersonPicker label={t.logSend} onPick={(personId) => addPitch(project.path, { personId, date: today(), outcome: "sent" })} />
      </div>
    </div>
  );
}

