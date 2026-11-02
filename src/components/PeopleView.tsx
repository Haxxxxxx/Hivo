import { useMemo, useState } from "react";
import { ArrowLeft, Plus, Send, Sparkles, Trash2, Users } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { formatRelative } from "../lib/format";
import { songsOf, suggestedPeople } from "../lib/people";
import { lastSaveMs, statusInfo } from "../lib/songs";
import type { Person, ProjectInfo } from "../types";
import { useVisibleSongs } from "./LibraryView";
import { OUTCOMES, roleLabel } from "./SongPeople";
import { Profiles } from "./ProfileLookup";
import { ConfirmButton, StatusDot, TagEditor, btn, btnPrimary, input, sectionLabel } from "./ui";
import { Avatar } from "../ui";
import { dict, plural, tr } from "../i18n";

const T = dict(
  {
    people: "People",
    addPerson: "Add person",
    namePlaceholder: "Name or artist name",
    add: "Add",
    cancel: "Cancel",
    foundInSessions: "Found in your session track names — add who's a real person",
    songs: (n: number) => `${n} song${plural(n, "", "s")}`,
    spellingsHint: "Same person under several spellings (NV, Novah…)? Add one, then add the others as aliases on their page.",
    noPeople: "No people yet.",
    aka: (names: string) => `aka ${names}`,
    sent: (n: number, won: number) => `${n} sent${won ? ` · ${won} won` : ""}`,
    allPeople: "All people",
    alsoAppearsAs: "Also appears as",
    aliasHint: "Spellings used in track names (NV, Novah…). Case doesn't matter.",
    contact: "Contact",
    contactPlaceholder: "Email, @handle, phone…",
    notes: "Notes",
    notesPlaceholder: "What they like, deals, availability…",
    songsCount: (n: number) => `Songs · ${n}`,
    notOnAny:
      "Not on any song yet. Credit them from a song's panel, or add the spelling used in your track names as an alias.",
    inTrackNames: "in track names",
    sentToThem: (n: number) => `Sent to them · ${n}`,
    logHint: 'Log a send from any song\'s panel ("Sent to").',
    removePerson: "Remove person",
    confirmRemove: "Also removes their credits and send log. Click again",
    personName: "Name",
  },
  {
    people: "Personnes",
    addPerson: "Ajouter une personne",
    namePlaceholder: "Nom ou nom d'artiste",
    add: "Ajouter",
    cancel: "Annuler",
    foundInSessions: "Trouvés dans les noms de pistes de tes sessions — ajoute ceux qui sont de vraies personnes",
    songs: (n: number) => `${n} son${plural(n, "", "s")}`,
    spellingsHint:
      "La même personne sous plusieurs orthographes (NV, Novah…) ? Ajoutes-en une, puis ajoute les autres comme alias sur sa page.",
    noPeople: "Personne pour l'instant.",
    aka: (names: string) => `alias ${names}`,
    sent: (n: number, won: number) => `${n} envoi${plural(n, "", "s")}${won ? ` · ${won} gagné${plural(won, "", "s")}` : ""}`,
    allPeople: "Toutes les personnes",
    alsoAppearsAs: "Apparaît aussi comme",
    aliasHint: "Orthographes utilisées dans les noms de pistes (NV, Novah…). Majuscules ou pas, peu importe.",
    contact: "Contact",
    contactPlaceholder: "E-mail, @pseudo, téléphone…",
    notes: "Notes",
    notesPlaceholder: "Ce qu'il ou elle aime, deals, dispos…",
    songsCount: (n: number) => `Sons · ${n}`,
    notOnAny:
      "Sur aucun son pour l'instant. Crédite cette personne depuis le panneau d'un son, ou ajoute en alias l'orthographe utilisée dans tes noms de pistes.",
    inTrackNames: "dans les noms de pistes",
    sentToThem: (n: number) => `Envoyé à cette personne · ${n}`,
    logHint: "Note un envoi depuis le panneau de n'importe quel son (« Envoyé à »).",
    removePerson: "Supprimer la personne",
    confirmRemove: "Supprime aussi ses crédits et son historique d'envois. Clique encore",
    personName: "Nom",
  },
);

export function PeopleView() {
  const openPersonId = useAppStore((s) => s.openPersonId);
  const person = useAppStore((s) => s.workspace.people.find((p) => p.id === s.openPersonId));
  return openPersonId && person ? <PersonDetail person={person} /> : <PeopleList />;
}

function usePitchesOf(personId: string | null) {
  const songsMeta = useAppStore((s) => s.workspace.songs);
  const projects = useAppStore((s) => s.projects);
  return useMemo(() => {
    const byPath = new Map(projects.map((p) => [p.path, p]));
    const out: { song: ProjectInfo | undefined; path: string; pitch: NonNullable<(typeof songsMeta)[string]["pitches"]>[number] }[] = [];
    for (const [path, meta] of Object.entries(songsMeta))
      for (const pitch of meta.pitches ?? [])
        if (!personId || pitch.personId === personId) out.push({ song: byPath.get(path), path, pitch });
    return out.sort((a, b) => b.pitch.date.localeCompare(a.pitch.date));
  }, [songsMeta, projects, personId]);
}

function PeopleList() {
  const songs = useVisibleSongs();
  const workspace = useAppStore((s) => s.workspace);
  const createPerson = useAppStore((s) => s.createPerson);
  const openPerson = useAppStore((s) => s.openPerson);
  const [draft, setDraft] = useState<string | null>(null);
  const allPitches = usePitchesOf(null);

  const suggestions = useMemo(() => suggestedPeople(songs, workspace.people).slice(0, 12), [songs, workspace.people]);
  const rows = useMemo(
    () =>
      workspace.people
        .map((p) => ({
          person: p,
          songs: songsOf(p, songs, workspace).length,
          pitches: allPitches.filter((x) => x.pitch.personId === p.id),
        }))
        .sort((a, b) => b.songs + b.pitches.length - (a.songs + a.pitches.length)),
    [workspace, songs, allPitches],
  );
  const t = tr(T);

  return (
    <div className="min-w-0 flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-3xl uppercase leading-none tracking-tight text-cream">{t.people}</h1>
          </div>
          {draft === null && (
            <button onClick={() => setDraft("")} className={btnPrimary}>
              <Plus size={14} /> {t.addPerson}
            </button>
          )}
        </div>

        {draft !== null && (
          <form
            className="mt-5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              openPerson(createPerson(draft));
              setDraft(null);
            }}
          >
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.namePlaceholder} className={input} />
            <button type="submit" className={btnPrimary}>
              {t.add}
            </button>
            <button type="button" onClick={() => setDraft(null)} className={btn}>
              {t.cancel}
            </button>
          </form>
        )}

        {suggestions.length > 0 && (
          <div className="mt-6 rounded-lg border border-rule bg-panel p-4">
            <div className="flex items-center gap-1.5 text-xs text-body">
              <Sparkles size={13} className="text-orange-300" /> {t.foundInSessions}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s.name}
                  onClick={() => createPerson(s.name)}
                  className="rounded-full border border-dashed border-rule-strong px-2.5 py-1 text-xs text-body hover:border-orange-400/50 hover:text-cream"
                >
                  + {s.name} <span className="text-engrave">· {t.songs(s.songs)}</span>
                </button>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-engrave">
              {t.spellingsHint}
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-2 text-center text-engrave">
            <Users size={32} />
            <div className="text-sm">{t.noPeople}</div>
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-lg border border-rule">
            {rows.map(({ person, songs: n, pitches }) => {
              const wins = pitches.filter((x) => x.pitch.outcome === "placed" || x.pitch.outcome === "sold").length;
              return (
                <button
                  key={person.id}
                  onClick={() => openPerson(person.id)}
                  className="flex w-full items-center gap-4 border-b border-rule px-4 py-3 text-left last:border-0 hover:bg-panel"
                >
                  <Avatar name={person.name} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-cream">{person.name}</div>
                    <div className="truncate text-[11px] text-engrave">
                      {[person.aliases.length ? t.aka(person.aliases.join(", ")) : "", person.contact].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  <div className="w-20 text-right text-xs text-body">
                    {t.songs(n)}
                  </div>
                  <div className="w-28 text-right text-xs text-body">
                    {pitches.length ? t.sent(pitches.length, wins) : "—"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PersonDetail({ person }: { person: Person }) {
  const songs = useVisibleSongs();
  const workspace = useAppStore((s) => s.workspace);
  const updatePerson = useAppStore((s) => s.updatePerson);
  const deletePerson = useAppStore((s) => s.deletePerson);
  const openPerson = useAppStore((s) => s.openPerson);
  const openDetail = useAppStore((s) => s.openDetail);
  const pitches = usePitchesOf(person.id);
  const theirSongs = useMemo(() => songsOf(person, songs, workspace), [person, songs, workspace]);
  const t = tr(T);

  return (
    <div className="min-w-0 flex-1 overflow-auto px-8 py-6">
      <div className="mx-auto max-w-3xl">
        <button onClick={() => openPerson(null)} className="flex items-center gap-1 text-xs text-engrave hover:text-cream">
          <ArrowLeft size={13} /> {t.allPeople}
        </button>

        <div className="mt-4 flex items-center gap-4">
          {person.spotify?.imageUrl ? (
            <img src={person.spotify.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover" />
          ) : (
            <Avatar name={person.name} size={56} />
          )}
          <input
            value={person.name}
            onChange={(e) => updatePerson(person.id, { name: e.target.value })}
            aria-label={t.personName}
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent text-2xl font-semibold text-cream focus:border-hot focus:outline-none"
          />
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <div>
            <div className={`${sectionLabel} mb-2`}>{t.alsoAppearsAs}</div>
            <TagEditor tags={person.aliases} suggestions={[]} onChange={(aliases) => updatePerson(person.id, { aliases })} />
            <div className="mt-1 text-[11px] text-engrave">{t.aliasHint}</div>
          </div>
          <div>
            <div className={`${sectionLabel} mb-2`}>{t.contact}</div>
            <input
              value={person.contact}
              onChange={(e) => updatePerson(person.id, { contact: e.target.value })}
              placeholder={t.contactPlaceholder}
              className={`${input} py-1.5 text-xs`}
            />
          </div>
        </div>

        <Profiles person={person} />

        <div className={`${sectionLabel} mt-6 mb-2`}>{t.notes}</div>
        <textarea
          value={person.notes}
          onChange={(e) => updatePerson(person.id, { notes: e.target.value })}
          placeholder={t.notesPlaceholder}
          rows={3}
          className={`${input} resize-y text-xs`}
        />

        <div className={`${sectionLabel} mt-8 mb-2`}>{t.songsCount(theirSongs.length)}</div>
        <div className="overflow-hidden rounded-lg border border-rule">
          {theirSongs.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-engrave">
              {t.notOnAny}
            </div>
          )}
          {theirSongs.map(({ song, credit, detected }) => {
            const s = statusInfo(workspace.songs[song.path]?.status);
            return (
              <button
                key={song.path}
                onClick={() => openDetail(song.path)}
                className="flex w-full items-center gap-3 border-b border-rule px-4 py-2 text-left text-sm last:border-0 hover:bg-panel"
              >
                <span className="min-w-0 flex-1 truncate text-cream">{song.name}</span>
                <span className="text-xs text-engrave">
                  {credit ? `${roleLabel(credit.role)}${credit.split != null ? ` · ${credit.split}%` : ""}` : detected ? t.inTrackNames : ""}
                </span>
                <span className="flex w-28 items-center gap-1.5 text-xs text-body">
                  <StatusDot color={s.color} size={6} /> {s.label}
                </span>
                <span className="w-24 text-right text-xs text-engrave">{formatRelative(lastSaveMs(song))}</span>
              </button>
            );
          })}
        </div>

        <div className={`${sectionLabel} mt-8 mb-2`}>{t.sentToThem(pitches.length)}</div>
        {pitches.length === 0 ? (
          <div className="text-xs text-engrave">{t.logHint}</div>
        ) : (
          <div className="flex flex-col gap-1">
            {pitches.map(({ song, path, pitch }) => {
              const o = OUTCOMES.find((x) => x.id === pitch.outcome);
              return (
                <button key={pitch.id} onClick={() => openDetail(path)} className="flex items-center gap-3 rounded px-2 py-1.5 text-left text-xs hover:bg-panel">
                  <Send size={11} className="text-engrave" />
                  <span className="w-24 text-body">{pitch.date}</span>
                  <span className="min-w-0 flex-1 truncate text-cream">{song?.name ?? path.split(/[/\\]/).pop()}</span>
                  <span className={`w-20 text-right ${o?.tone ?? ""}`}>{o?.label}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-10 border-t border-rule pt-4">
          <ConfirmButton
            label={
              <>
                <Trash2 size={13} /> {t.removePerson}
              </>
            }
            confirmLabel={t.confirmRemove}
            onConfirm={() => deletePerson(person.id)}
            className={`${btn} text-xs`}
          />
        </div>
      </div>
    </div>
  );
}
