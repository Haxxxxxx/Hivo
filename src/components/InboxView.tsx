import { useEffect, useMemo, useState } from "react";
import { FileAudio, FolderOpen, Inbox as InboxIcon, Lightbulb, Mic, Smartphone, Trash2, Undo2 } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { usePhoneInbox } from "../store/usePhoneInbox";
import * as api from "../lib/tauri";
import { audioSrc } from "../lib/tauri";
import { formatBytes, formatDateTime } from "../lib/format";
import {
  bandlabLink,
  canFileElsewhere,
  duration,
  filedPath,
  filterInbox,
  knownTarget,
  newCount,
  parseTargetKey,
  removeLoses,
  sketchName,
  targetOptions,
  type InboxFilter,
  type TargetOption,
} from "../lib/phoneInbox";
import { isSketchAudioName } from "../lib/sketch";
import type { BeatFile, FiledSketch, IncomingItem, InboxItem, InboxTarget, SavedLead } from "../types";
import { ConfirmButton, btn, btnPrimary, btnQuiet, engrave, input } from "./ui";
import { StatusDot } from "../ui";
import { dict, plural, tr } from "../i18n";
import { errorText } from "../lib/errors";

// The phone inbox (docs/PHONE-SYNC.md v1.1): ideas, voice memos and BandLab
// exports sent from the phone. Each card files its item: an idea into a
// note, a memo into a song's "Voice memos" folder (or onto a beat or a
// prod), a sketch into a new song folder. Errors stay on their card.

const T = dict(
  {
    title: "Phone inbox",
    intro: "Ideas, voice memos and BandLab exports from your phone. They stay on this computer: nothing goes through a server.",
    filterNew: (n: number) => `New (${n})`,
    filterFiled: "Filed",
    filterAll: "All",
    receiving: (n: number) => plural(n, "Receiving 1 item from the phone…", `Receiving ${n} items from the phone…`),
    sample: "Sample data is on screen: the phone inbox is off. Switch to your library to receive.",
    notPaired: "No phone paired yet. Turn on Phone sync in Settings and scan the QR code with the Hivo phone app.",
    openSettings: "Open Phone sync",
    emptyNew: "Nothing new. On the phone: share a BandLab export to Hivo, record a voice memo, or write an idea.",
    emptyOther: "Nothing here.",
    idea: "Idea",
    memo: "Voice memo",
    sketch: "BandLab export",
    from: (phone: string, when: string) => `From ${phone} · ${when}`,
    phone: "Phone",
    aimedAt: (title: string) => `Written for ${title}`,
    aimedGone: (title: string) => `Written for ${title}, which isn't on this computer any more: pick another.`,
    pickTarget: "Pick a song, beat or prod",
    songs: "Songs",
    beats: "Beats",
    prods: "Saved prods",
    addToNote: "Add to its notes",
    attach: "Attach",
    attachHintSong: "A song: the memo is copied into its “Voice memos” folder.",
    fileAsSong: "File as a new song",
    songName: "Song name",
    folder: "In",
    noFolders: "Link a project folder in Settings first: the song folder is created there.",
    orAttach: "Or attach the audio to a song:",
    attachTo: (title: string) => `Attach to ${title}`,
    attachToHint: "The phone sent it for this song: the audio goes into its BandLab folder.",
    orNewSong: "Or file it as a new song:",
    dismiss: "Dismiss",
    restore: "Back to new",
    remove: "Remove",
    removeConfirm: "Remove from inbox?",
    removeKept: "Removes it from the inbox only: what was filed stays where it went.",
    removeOnly: "Deletes it for good: the inbox holds the only copy.",
    removeOnlyConfirm: "Delete the only copy?",
    incomingTitle: "Still arriving",
    incomingLine: (done: number, of: number, got: string, total: string) => `${done} of ${of} file${plural(of, "", "s")} in · ${got} of ${total}`,
    incomingHint: "Interrupted uploads hold space in the inbox until they finish or a week goes by. Remove one to free it now; if the phone is still sending it, it starts again.",
    fileElsewhere: "File elsewhere",
    fileElsewhereHint: "Back to new, to file it somewhere else: what was already filed stays there.",
    filedFolder: "Copied into the song's BandLab folder",
    filedSketchNotice: (name: string) => `${name} is filed as a new song.`,
    stemsApart: (n: number) => ` The ${n} stem${plural(n, "", "s")} went to BandLab/Stems, apart from the mixdown: Continue in FL Studio lays out the stems, not the mixdown over them.`,
    overTwenty: (n: number) => ` ${n} audio files: Continue in FL Studio lays out the first 20, drag the rest in from the BandLab folder.`,
    filedNote: (title: string) => `Added to the notes of ${title}`,
    filedSketch: "Filed as a new song",
    sharedWith: "Shared with it",
    filedMemo: "Copied into the song's Voice memos folder",
    filedMemoTo: (title: string) => `Copied into the Voice memos folder of ${title}`,
    filedLink: (title: string) => `Linked to ${title}`,
    filedLinkCopy: (title: string) => `Linked to ${title} (copied into the beats folder's _memos)`,
    dismissed: "Dismissed",
    openSong: "Open the song",
    reveal: "Show in folder",
    missing: "File missing (deleted by hand?): this item can only be removed.",
    files: (n: number) => plural(n, "1 file", `${n} files`),
    zip: "zip of stems: unpacked when filed",
    working: "Working…",
    unknown: "something on this computer",
  },
  {
    title: "Boîte du téléphone",
    intro: "Idées, mémos vocaux et exports BandLab venus de ton téléphone. Ils restent sur cet ordi : rien ne passe par un serveur.",
    filterNew: (n: number) => `Nouveaux (${n})`,
    filterFiled: "Rangés",
    filterAll: "Tout",
    receiving: (n: number) => plural(n, `Réception de ${n} élément du téléphone…`, `Réception de ${n} éléments du téléphone…`),
    sample: "Les données d'exemple sont affichées : la boîte du téléphone est coupée. Passe à ta bibliothèque pour recevoir.",
    notPaired: "Aucun téléphone associé. Active la synchro téléphone dans les Réglages et scanne le QR code avec l'app Hivo du téléphone.",
    openSettings: "Ouvrir la synchro téléphone",
    emptyNew: "Rien de nouveau. Sur le téléphone : partage un export BandLab vers Hivo, enregistre un mémo vocal ou écris une idée.",
    emptyOther: "Rien ici.",
    idea: "Idée",
    memo: "Mémo vocal",
    sketch: "Export BandLab",
    from: (phone: string, when: string) => `De ${phone} · ${when}`,
    phone: "Téléphone",
    aimedAt: (title: string) => `Écrit pour ${title}`,
    aimedGone: (title: string) => `Écrit pour ${title}, qui n'est plus sur cet ordi : choisis-en un autre.`,
    pickTarget: "Choisis un son, une prod ou une prod enregistrée",
    songs: "Sons",
    beats: "Prods",
    prods: "Prods enregistrées",
    addToNote: "Ajouter à ses notes",
    attach: "Joindre",
    attachHintSong: "Un son : le mémo est copié dans son dossier « Voice memos ».",
    fileAsSong: "Ranger comme nouveau son",
    songName: "Nom du son",
    folder: "Dans",
    noFolders: "Lie d'abord un dossier de projets dans les Réglages : le dossier du son y est créé.",
    orAttach: "Ou joindre l'audio à un son :",
    attachTo: (title: string) => `Joindre à ${title}`,
    attachToHint: "Le téléphone l'a envoyé pour ce son : l'audio va dans son dossier BandLab.",
    orNewSong: "Ou le classer comme nouveau son :",
    dismiss: "Écarter",
    restore: "Remettre en nouveau",
    remove: "Retirer",
    removeConfirm: "Retirer de la boîte ?",
    removeKept: "Le retire de la boîte seulement : ce qui a été rangé reste où il est.",
    removeOnly: "Le supprime pour de bon : la boîte en a la seule copie.",
    removeOnlyConfirm: "Supprimer la seule copie ?",
    incomingTitle: "En cours de réception",
    incomingLine: (done: number, of: number, got: string, total: string) => `${done} fichier${plural(done, "", "s")} sur ${of} reçu${plural(done, "", "s")} · ${got} sur ${total}`,
    incomingHint: "Un envoi interrompu garde sa place dans la boîte jusqu'à ce qu'il finisse ou qu'une semaine passe. Retire-le pour la libérer tout de suite ; si le téléphone l'envoie encore, il recommence.",
    fileElsewhere: "Ranger ailleurs",
    fileElsewhereHint: "Remet en nouveau pour le ranger ailleurs : ce qui a déjà été rangé y reste.",
    filedFolder: "Copié dans le dossier BandLab du son",
    filedSketchNotice: (name: string) => `${name} est rangé comme nouveau son.`,
    stemsApart: (n: number) => ` ${plural(n, "Le stem est allé", `Les ${n} stems sont allés`)} dans BandLab/Stems, à part du mix : Continuer dans FL Studio place les stems, pas le mix par-dessus.`,
    overTwenty: (n: number) => ` ${n} fichiers audio : Continuer dans FL Studio place les 20 premiers, glisse les autres depuis le dossier BandLab.`,
    filedNote: (title: string) => `Ajouté aux notes de ${title}`,
    filedSketch: "Rangé comme nouveau son",
    sharedWith: "Partagé avec",
    filedMemo: "Copié dans le dossier Voice memos du son",
    filedMemoTo: (title: string) => `Copié dans le dossier Voice memos de ${title}`,
    filedLink: (title: string) => `Lié à ${title}`,
    filedLinkCopy: (title: string) => `Lié à ${title} (copié dans _memos du dossier de prods)`,
    dismissed: "Écarté",
    openSong: "Ouvrir le son",
    reveal: "Afficher dans le dossier",
    missing: "Fichier manquant (supprimé à la main ?) : cet élément peut seulement être retiré.",
    files: (n: number) => plural(n, `${n} fichier`, `${n} fichiers`),
    zip: "zip de stems : décompressé au rangement",
    working: "En cours…",
    unknown: "un élément de cet ordi",
  },
);

export function InboxView() {
  const t = tr(T);
  const items = usePhoneInbox((s) => s.items);
  const receiving = usePhoneInbox((s) => s.receiving);
  const incoming = usePhoneInbox((s) => s.incoming);
  const [notice, setNotice] = useState<string | null>(null);
  const paired = usePhoneInbox((s) => s.paired);
  const loadError = usePhoneInbox((s) => s.error);
  const refresh = usePhoneInbox((s) => s.refresh);
  const demoMode = useAppStore((s) => s.demoMode);
  const setView = useAppStore((s) => s.setView);
  const projects = useAppStore((s) => s.projects);
  const workspace = useAppStore((s) => s.workspace);
  const [filter, setFilter] = useState<InboxFilter>("new");
  const [beats, setBeats] = useState<BeatFile[]>([]);
  const [leads, setLeads] = useState<SavedLead[]>([]);

  useEffect(() => {
    void refresh();
    let live = true;
    // Targets for ideas and memos: beats and saved prods are read fresh.
    void Promise.all([api.scanBeats().catch(() => []), api.listLeads().then((ls) => ls.filter((l) => !l.unrecognised)).catch(() => [])]).then(([b, l]) => {
      if (live) {
        setBeats(b);
        setLeads(l);
      }
    });
    return () => {
      live = false;
    };
  }, [refresh]);

  const options = useMemo(() => targetOptions(projects, workspace, beats, leads), [projects, workspace, beats, leads]);
  const shown = filterInbox(items, filter);

  return (
    <div className="min-w-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <header className="flex items-center gap-3">
          <InboxIcon size={18} className="text-engrave" />
          <h1 className="font-display text-3xl uppercase leading-none tracking-tight text-cream">{t.title}</h1>
        </header>
        <p className="-mt-2 text-sm text-body">{t.intro}</p>

        {demoMode && <Notice>{t.sample}</Notice>}
        {loadError && <Notice error>{loadError}</Notice>}
        {receiving > 0 && (
          <div className="flex items-center gap-2 text-sm text-body">
            <StatusDot color="var(--color-warn)" size={7} /> {t.receiving(receiving)}
          </div>
        )}
        {incoming.length > 0 && <IncomingList items={incoming} />}
        {notice && <Notice>{notice}</Notice>}

        <div className="flex gap-2">
          {(["new", "filed", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-3 py-1 text-sm ${filter === f ? "bg-cream font-medium text-chassis" : "text-body hover:bg-raised hover:text-cream"}`}
            >
              {f === "new" ? t.filterNew(newCount(items)) : f === "filed" ? t.filterFiled : t.filterAll}
            </button>
          ))}
        </div>

        {shown.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-rule bg-panel px-6 py-10 text-center text-sm text-body">
            <Smartphone size={22} className="text-engrave" />
            {paired === 0 && items.length === 0 ? (
              <>
                <p>{t.notPaired}</p>
                <button className={btn} onClick={() => setView("settings", "phone-sync")}>
                  {t.openSettings}
                </button>
              </>
            ) : (
              <p>{filter === "new" ? t.emptyNew : t.emptyOther}</p>
            )}
          </div>
        )}

        {shown.map((item) => (
          <InboxCard key={item.id} item={item} options={options} onNotice={setNotice} />
        ))}
      </div>
    </div>
  );
}

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={`rounded border px-3 py-2 text-sm ${error ? "border-missing/50 text-missing" : "border-rule-strong text-body"}`}>{children}</div>
  );
}

function TargetSelect({
  options,
  value,
  onChange,
  songsOnly = false,
}: {
  options: TargetOption[];
  value: string;
  onChange: (key: string) => void;
  songsOnly?: boolean;
}) {
  const t = tr(T);
  const groups: Array<[TargetOption["kind"], string]> = songsOnly
    ? [["song", t.songs]]
    : [
        ["song", t.songs],
        ["beat", t.beats],
        ["prod", t.prods],
      ];
  return (
    <select className={`${input} max-w-sm py-1.5`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t.pickTarget}</option>
      {groups.map(([kind, label]) => {
        const list = options.filter((o) => o.kind === kind);
        if (list.length === 0) return null;
        return (
          <optgroup key={kind} label={label}>
            {list.map((o) => (
              <option key={`${o.kind}:${o.id}`} value={`${o.kind}:${o.id}`}>
                {o.title}
                {o.detail ? ` · ${o.detail}` : ""}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

function optionFor(options: TargetOption[], key: string): InboxTarget | null {
  const k = parseTargetKey(key);
  return k ? (options.find((o) => o.kind === k.kind && o.id === k.id) ?? null) : null;
}

/** Items still arriving: how far they got, and Remove to free their space. */
function IncomingList({ items }: { items: IncomingItem[] }) {
  const t = tr(T);
  const remove = usePhoneInbox((s) => s.removeIncoming);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-rule bg-panel p-4">
      <div className={engrave}>{t.incomingTitle}</div>
      {items.map((i) => (
        <div key={i.id} className="flex items-center gap-3 text-sm">
          <StatusDot color="var(--color-warn)" size={6} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-cream">{i.title || (i.itemType === "memo" ? t.memo : t.sketch)}</div>
            <div className="text-xs text-engrave">
              {t.from(i.phoneName || t.phone, formatDateTime(i.updatedAt))} · {t.incomingLine(i.filesDone, i.fileCount, formatBytes(i.receivedBytes), formatBytes(i.totalBytes))}
            </div>
          </div>
          <ConfirmButton
            label={
              <>
                <Trash2 size={14} /> {t.remove}
              </>
            }
            confirmLabel={t.removeConfirm}
            onConfirm={() => void remove(i.id).catch((e) => setError(errorText(e)))}
            className={btnQuiet}
          />
        </div>
      ))}
      <p className="text-xs text-engrave">{t.incomingHint}</p>
      {error && <Notice error>{error}</Notice>}
    </section>
  );
}

function sketchNotice(name: string, filed: FiledSketch): string | null {
  const t = tr(T);
  const extra = (filed.stemsApart ? t.stemsApart(filed.stems) : "") + (filed.audio + filed.stems > 20 ? t.overTwenty(filed.audio + filed.stems) : "");
  return extra ? t.filedSketchNotice(name) + extra : null;
}

function InboxCard({ item, options, onNotice }: { item: InboxItem; options: TargetOption[]; onNotice: (text: string | null) => void }) {
  const t = tr(T);
  const fileIdea = usePhoneInbox((s) => s.fileIdea);
  const attachMemo = usePhoneInbox((s) => s.attachMemo);
  const fileSketch = usePhoneInbox((s) => s.fileSketch);
  const dismiss = usePhoneInbox((s) => s.dismiss);
  const restore = usePhoneInbox((s) => s.restore);
  const remove = usePhoneInbox((s) => s.remove);
  const openDetail = useAppStore((s) => s.openDetail);
  const folders = useAppStore((s) => s.settings.watchedFolders);
  const projects = useAppStore((s) => s.projects);

  const aimed = knownTarget(item, options);
  const aimedSong = item.itemType === "sketch" && aimed?.kind === "song" ? aimed : null;
  const [targetKey, setTargetKey] = useState(aimed ? `${aimed.kind}:${aimed.id}` : "");
  const [name, setName] = useState(() => sketchName(item));
  const [folder, setFolder] = useState(folders[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = item.files.some((f) => f.missing);
  const isNew = item.status === "new";
  const firstAudio = item.files.find((f) => !f.missing && isSketchAudioName(f.name));
  const Icon = item.itemType === "idea" ? Lightbulb : item.itemType === "memo" ? Mic : FileAudio;
  const kindLabel = item.itemType === "idea" ? t.idea : item.itemType === "memo" ? t.memo : t.sketch;

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      const msg = errorText(e);
      setError(msg === "disk full" ? "This computer's disk is full." : msg);
    } finally {
      setBusy(false);
    }
  }

  const chosen = optionFor(options, targetKey);
  const filedTarget = parseTargetKey(item.filedTo);
  const filedTitle = filedTarget ? (options.find((o) => o.kind === filedTarget.kind && o.id === filedTarget.id)?.title ?? t.unknown) : null;
  // A sketch filed as a song: its key is the BandLab folder; open it if scanned.
  const filedSong = item.itemType === "sketch" && item.filedTo && projects.some((p) => p.path === item.filedTo) ? item.filedTo : null;
  const shownAt = filedPath(item);
  const loses = removeLoses(item);

  return (
    <article className={`flex flex-col gap-3 rounded-lg border bg-panel p-4 ${isNew ? "border-rule-strong" : "border-rule opacity-80"}`}>
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0 text-engrave" />
        <div className="min-w-0 flex-1">
          <div className={engrave}>{kindLabel}</div>
          <div className="truncate font-medium text-cream">{item.title || (item.itemType === "idea" ? item.text.split("\n")[0] : item.itemType === "sketch" ? sketchName(item) : item.files[0]?.name) || kindLabel}</div>
          <div className="text-xs text-engrave">{t.from(item.phoneName || t.phone, formatDateTime(item.receivedAt ?? item.createdAt))}</div>
        </div>
        {!isNew && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-body">
            <StatusDot color={item.status === "filed" ? "var(--color-ok)" : "var(--color-engrave)"} size={6} />
            {item.status === "dismissed"
              ? t.dismissed
              : item.itemType === "sketch" && !filedTarget
                ? item.filedAs === "folder"
                  ? t.filedFolder
                  : t.filedSketch
                : item.itemType === "idea" && filedTitle
                  ? t.filedNote(filedTitle)
                  : filedTitle
                    ? item.filedAs === "folder"
                      ? t.filedMemoTo(filedTitle)
                      : item.copiedTo
                        ? t.filedLinkCopy(filedTitle)
                        : t.filedLink(filedTitle)
                    : t.filedMemo}
          </span>
        )}
      </div>

      {item.itemType === "idea" && item.text && <p className="whitespace-pre-wrap rounded bg-chassis px-3 py-2 text-sm text-body">{item.text}</p>}
      {/* What the sharing app sent with the files (BandLab's words and link). */}
      {item.itemType !== "idea" && item.text && (
        <p className="whitespace-pre-wrap break-words text-xs text-engrave">
          <span className="text-body">{t.sharedWith}: </span>
          {item.text}
        </p>
      )}

      {item.itemType !== "idea" && (
        <div className="flex flex-col gap-2">
          {firstAudio && <audio controls preload="none" src={audioSrc(firstAudio.path)} className="h-9 w-full max-w-md" />}
          <div className="text-xs text-engrave">
            {item.durationMs ? `${duration(item.durationMs)} · ` : ""}
            {t.files(item.files.length)} · {formatBytes(item.files.reduce((n, f) => n + f.size, 0))}
          </div>
          {item.itemType === "sketch" && item.files.length > 1 && (
            <ul className="text-xs text-body">
              {item.files.map((f) => (
                <li key={f.path} className={f.missing ? "text-missing" : ""}>
                  {f.name} {f.name.toLowerCase().endsWith(".zip") ? `(${t.zip})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {missing && <Notice error>{t.missing}</Notice>}

      {item.target && isNew && <div className="text-xs text-body">{aimed ? t.aimedAt(aimed.title) : t.aimedGone(item.target.title || item.target.id)}</div>}

      {isNew && !missing && item.itemType === "idea" && (
        <div className="flex flex-wrap items-center gap-2">
          <TargetSelect options={options} value={targetKey} onChange={setTargetKey} />
          <button className={btnPrimary} disabled={busy || !chosen} onClick={() => chosen && void run(() => fileIdea(item, chosen))}>
            {busy ? t.working : t.addToNote}
          </button>
        </div>
      )}

      {isNew && !missing && item.itemType === "memo" && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <TargetSelect options={options} value={targetKey} onChange={setTargetKey} />
            <button className={btnPrimary} disabled={busy || !chosen} onClick={() => chosen && void run(() => attachMemo(item, chosen))}>
              {busy ? t.working : t.attach}
            </button>
          </div>
          {chosen?.kind === "song" && <span className="text-xs text-engrave">{t.attachHintSong}</span>}
        </div>
      )}

      {isNew && !missing && item.itemType === "sketch" && (
        <div className="flex flex-col gap-3">
          {/* Sent for a song that's here: joining it is the first choice, not a new sketch. */}
          {aimedSong && (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <button className={btnPrimary} disabled={busy} onClick={() => void run(() => attachMemo(item, aimedSong))}>
                  {busy ? t.working : t.attachTo(aimedSong.title)}
                </button>
                <span className="text-xs text-engrave">{t.attachToHint}</span>
              </div>
              <span className="mt-1 text-xs text-body">{t.orNewSong}</span>
            </div>
          )}
          {folders.length === 0 ? (
            <Notice>{t.noFolders}</Notice>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className={engrave}>{t.songName}</span>
                <input className={`${input} w-56 py-1.5`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={engrave}>{t.folder}</span>
                <select className={`${input} max-w-xs py-1.5`} value={folder} onChange={(e) => setFolder(e.target.value)}>
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={aimedSong ? btn : btnPrimary}
                disabled={busy || !name.trim() || !folder}
                onClick={() =>
                  void run(async () => {
                    const filed = await fileSketch(item, folder, name.trim(), bandlabLink(item) ?? undefined);
                    onNotice(sketchNotice(name.trim(), filed));
                    openDetail(filed.key);
                  })
                }
              >
                {busy ? t.working : t.fileAsSong}
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-body">
            {t.orAttach}
            <TargetSelect options={options} value={targetKey.startsWith("song:") ? targetKey : ""} onChange={setTargetKey} songsOnly />
            <button className={btn} disabled={busy || chosen?.kind !== "song"} onClick={() => chosen && void run(() => attachMemo(item, chosen))}>
              {t.attach}
            </button>
          </div>
        </div>
      )}

      {error && <Notice error>{error}</Notice>}

      <div className="flex flex-wrap items-center gap-2">
        {filedSong && (
          <button className={btn} onClick={() => openDetail(filedSong)}>
            <FolderOpen size={14} /> {t.openSong}
          </button>
        )}
        {shownAt && (
          <button className={btnQuiet} disabled={busy} onClick={() => void run(() => api.revealInFileManager(shownAt))}>
            <FolderOpen size={14} /> {t.reveal}
          </button>
        )}
        {canFileElsewhere(item) && (
          <button className={btnQuiet} disabled={busy} title={t.fileElsewhereHint} onClick={() => void run(() => restore(item))}>
            <Undo2 size={14} /> {t.fileElsewhere}
          </button>
        )}
        {isNew && !missing && (
          <button className={btnQuiet} disabled={busy} onClick={() => void run(() => dismiss(item))}>
            {t.dismiss}
          </button>
        )}
        {item.status === "dismissed" && (
          <button className={btnQuiet} disabled={busy} onClick={() => void run(() => restore(item))}>
            <Undo2 size={14} /> {t.restore}
          </button>
        )}
        <span className="ml-auto" title={loses === "only" ? t.removeOnly : t.removeKept}>
          <ConfirmButton
            label={
              <>
                <Trash2 size={14} /> {t.remove}
              </>
            }
            confirmLabel={loses === "only" && item.itemType !== "idea" ? t.removeOnlyConfirm : t.removeConfirm}
            onConfirm={() => void run(() => remove(item))}
            className={btnQuiet}
            disabled={busy}
          />
        </span>
      </div>
    </article>
  );
}
