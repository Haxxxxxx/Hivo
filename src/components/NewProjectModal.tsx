import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { STATUSES } from "../lib/songs";
import type { SongStatus, TemplateInfo } from "../types";
import { Modal, btn, btnPrimary, input, sectionLabel } from "./ui";
import { dict, tr } from "../i18n";
import { adoptBeat } from "../store/beatToSong";
import { errorText, errorReason } from "../lib/errors";

const T = dict(
  {
    openFailed: (name: string, err: string) => `Created ${name}, but it didn't open: ${err}. Open it from the song panel.`,
    title: "New song",
    name: "Name",
    namePlaceholder: "Song title",
    clash: "A song with this name already exists there.",
    startFrom: "Start from",
    chooseTemplate: "Choose a template…",
    yourTemplates: "Your templates",
    noTemplates:
      "No templates found. Save any project into a Templates folder inside a linked folder to start new songs from it.",
    setFlPath: "Set the FL Studio path in Settings to see its templates.",
    location: "Location",
    stage: "Stage",
    release: "Release",
    none: "None",
    openAfter: "Open in FL Studio after creating",
    demo: "Link a real project folder to create songs.",
    noFolder: "Link a project folder in Settings first.",
    openSettings: "Open Settings",
    cancel: "Cancel",
    creating: "Creating…",
    create: "Create song",
    fromBeat: (name: string) => `From the beat ${name}: its notes and phone memos move to the song. The beat file stays where it is.`,
    creditProducer: "Credit as producer",
    producerName: "Producer",
    memosFailed: (name: string, list: string) => `Created ${name}, but these phone memos stayed on the beat: ${list}. File them from the Phone inbox.`,
  },
  {
    openFailed: (name: string, err: string) =>
      `${name} est créé, mais il ne s'est pas ouvert : ${err}. Ouvre-le depuis le panneau du son.`,
    title: "Nouveau son",
    name: "Nom",
    namePlaceholder: "Titre du son",
    clash: "Un son avec ce nom existe déjà à cet endroit.",
    startFrom: "Partir de",
    chooseTemplate: "Choisis un template…",
    yourTemplates: "Tes templates",
    noTemplates:
      "Aucun template trouvé. Enregistre un projet dans un dossier Templates à l'intérieur d'un dossier lié pour démarrer des sons à partir de lui.",
    setFlPath: "Indique le chemin de FL Studio dans les Réglages pour voir ses templates.",
    location: "Emplacement",
    stage: "Étape",
    release: "Sortie",
    none: "Aucune",
    openAfter: "Ouvrir dans FL Studio après la création",
    demo: "Lie un vrai dossier de projets pour créer des sons.",
    noFolder: "Lie d'abord un dossier de projets dans les Réglages.",
    openSettings: "Ouvrir les réglages",
    cancel: "Annuler",
    creating: "Création…",
    create: "Créer le son",
    fromBeat: (name: string) => `À partir de la prod ${name} : ses notes et ses mémos du téléphone passent au son. Le fichier de la prod reste où il est.`,
    creditProducer: "Créditer comme producteur",
    producerName: "Producteur",
    memosFailed: (name: string, list: string) => `${name} est créé, mais ces mémos du téléphone sont restés sur la prod : ${list}. Range-les depuis la boîte du téléphone.`,
  },
);

export function NewProjectModal() {
  const draft = useAppStore((s) => s.newProject);
  const close = useAppStore((s) => s.closeNewProject);
  const settings = useAppStore((s) => s.settings);
  const projects = useAppStore((s) => s.projects);
  const albums = useAppStore((s) => s.workspace.albums);
  const demoMode = useAppStore((s) => s.demoMode);
  const createProject = useAppStore((s) => s.createProject);
  const openDetail = useAppStore((s) => s.openDetail);
  const setView = useAppStore((s) => s.setView);
  const resetLibraryFilters = useAppStore((s) => s.resetLibraryFilters);

  const [name, setName] = useState("");
  const [templatePath, setTemplatePath] = useState("");
  const [parentFolder, setParentFolder] = useState(settings.watchedFolders[0] ?? "");
  const [status, setStatus] = useState<SongStatus>(draft?.status ?? "creation");
  const [albumId, setAlbumId] = useState<string>(draft?.albumId ?? "");
  const [openAfter, setOpenAfter] = useState(true);
  const [producer, setProducer] = useState("");
  const [creditProducer, setCreditProducer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The modal stays mounted: re-pick the location each time it opens, so a
  // folder linked (or removed) since the app started is reflected.
  const folders = settings.watchedFolders;
  useEffect(() => {
    if (!draft) return;
    setParentFolder((current) => (folders.includes(current) ? current : folders[0] ?? ""));
    setError(null);
  }, [draft, folders]);

  // Apply the draft once per opening (a new draft object each time). Not on
  // every rescan: a window-focus scan must not reset the stage and release
  // picked meanwhile.
  useEffect(() => {
    if (!draft) return;
    setStatus(draft.status);
    setAlbumId(draft.albumId ?? "");
    if (draft.name !== undefined) setName(draft.name);
    setProducer(draft.fromBeat?.producer ?? "");
    setCreditProducer(!!draft.fromBeat?.producer);
  }, [draft]);

  const factory = useFactoryTemplates(!!draft, setTemplatePath);

  if (!draft) return null;

  const trimmed = name.trim();
  const clash = projects.some(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase() && p.folder.toLowerCase().startsWith(parentFolder.toLowerCase()),
  );
  const canCreate = !demoMode && trimmed && templatePath && parentFolder && !busy;

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const path = await createProject({
        name: trimmed,
        templatePath,
        parentFolder,
        albumId: albumId || null,
        status,
      });
      setName("");
      // From a beat: its note, a producer credit and its phone memos move to the song.
      let memosFailed: string[] = [];
      if (draft?.fromBeat) {
        const r = await adoptBeat(path, draft.fromBeat, creditProducer ? producer.trim() || null : null);
        memosFailed = r.failed;
      }
      // Land where the new song shows: the Library (no drawer on Settings or
      // the Launch Kit; the drawer would squeeze the Digger's panels), with
      // no filter hiding it.
      const view = useAppStore.getState().view;
      if (view === "settings" || view === "launch" || view === "digger") setView("library");
      resetLibraryFilters();
      openDetail(path);
      // The song exists: say what didn't follow it on the app's error strip, not on a closed modal.
      if (memosFailed.length) useAppStore.setState({ actionError: tr(T).memosFailed(trimmed, memosFailed.join(", ")) });
      if (openAfter) {
        try {
          await api.openInFlStudio(path);
        } catch (e) {
          // The song exists; say so here instead of on a closed modal.
          setError(tr(T).openFailed(trimmed, errorReason(e)));
          return;
        }
      }
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const sep = parentFolder.includes("\\") ? "\\" : "/";
  const L = tr(T);

  return (
    <Modal title={L.title} onClose={busy ? () => {} : close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-4"
      >
        <div>
          <div className={sectionLabel}>{L.name}</div>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={L.namePlaceholder} className={`${input} mt-1.5`} />
          {clash && <div className="mt-1 text-xs text-amber-400">{L.clash}</div>}
        </div>

        {draft.fromBeat && (
          <div className="flex flex-col gap-2 rounded border border-rule bg-chassis px-3 py-2 text-xs text-body">
            <span>{L.fromBeat(draft.fromBeat.name)}</span>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={creditProducer} onChange={(e) => setCreditProducer(e.target.checked)} className="accent-orange-500" />
              {L.creditProducer}
              <input
                value={producer}
                onChange={(e) => {
                  setProducer(e.target.value);
                  setCreditProducer(!!e.target.value.trim());
                }}
                placeholder={L.producerName}
                aria-label={L.producerName}
                className={`${input} flex-1 py-1`}
              />
            </label>
          </div>
        )}

        <div>
          <div className={sectionLabel}>{L.startFrom}</div>
          <TemplateSelect value={templatePath} onChange={setTemplatePath} factory={factory} className="mt-1.5" />
        </div>

        <div>
          <div className={sectionLabel}>{L.location}</div>
          <select value={parentFolder} onChange={(e) => setParentFolder(e.target.value)} className={`${input} mt-1.5`}>
            {settings.watchedFolders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          {!demoMode && folders.length === 0 && (
            <div className="mt-1 flex items-center gap-2 text-xs text-engrave">
              {L.noFolder}
              <button
                type="button"
                onClick={() => {
                  close();
                  setView("settings", "folders");
                }}
                className="underline hover:text-cream"
              >
                {L.openSettings}
              </button>
            </div>
          )}
          {trimmed && parentFolder && (
            <div className="mt-1 truncate text-[11px] text-engrave">
              {parentFolder}
              {sep}
              {trimmed}
              {sep}
              {trimmed}.flp
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={sectionLabel}>{L.stage}</div>
            <select value={status} onChange={(e) => setStatus(e.target.value as SongStatus)} className={`${input} mt-1.5`}>
              {STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className={sectionLabel}>{L.release}</div>
            <select value={albumId} onChange={(e) => setAlbumId(e.target.value)} className={`${input} mt-1.5`}>
              <option value="">{L.none}</option>
              {albums.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-body">
          <input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} className="accent-orange-500" />
          {L.openAfter}
        </label>

        {demoMode && <div className="text-xs text-orange-200">{L.demo}</div>}
        {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className={btn}>
            {L.cancel}
          </button>
          <button type="submit" disabled={!canCreate} className={btnPrimary}>
            {busy ? L.creating : L.create}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** FL's factory templates, loaded while `active`; the first time, picks FL's
 * own default (else a template of yours, else the first) if none is picked. */
export function useFactoryTemplates(active: boolean, setTemplatePath: Dispatch<SetStateAction<string>>): TemplateInfo[] {
  const flStudioPath = useAppStore((s) => s.settings.flStudioPath);
  const [factory, setFactory] = useState<TemplateInfo[]>([]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    Promise.all([api.listTemplates(), api.defaultTemplate()])
      .then(([list, fallback]) => {
        if (cancelled) return;
        setFactory(list);
        const userTemplate = useAppStore.getState().projects.find((p) => p.isTemplate)?.path;
        setTemplatePath((current) => current || fallback || userTemplate || list[0]?.path || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, flStudioPath, setTemplatePath]);
  return factory;
}

/** Your templates (projects under a Templates folder) and FL's, by category. */
export function TemplateSelect({
  value,
  onChange,
  factory,
  className = "",
}: {
  value: string;
  onChange: (path: string) => void;
  factory: TemplateInfo[];
  className?: string;
}) {
  const projects = useAppStore((s) => s.projects);
  const flStudioPath = useAppStore((s) => s.settings.flStudioPath);
  const userTemplates = useMemo(() => projects.filter((p) => p.isTemplate), [projects]);
  const byCategory = useMemo(() => {
    const groups = new Map<string, TemplateInfo[]>();
    for (const t of factory) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
    return [...groups.entries()];
  }, [factory]);
  const L = tr(T);
  return (
    <>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${input} ${className}`}>
        {!value && <option value="">{L.chooseTemplate}</option>}
        {userTemplates.length > 0 && (
          <optgroup label={L.yourTemplates}>
            {userTemplates.map((t) => (
              <option key={t.path} value={t.path}>
                {t.name}
              </option>
            ))}
          </optgroup>
        )}
        {byCategory.map(([category, list]) => (
          <optgroup key={category} label={`FL Studio — ${category}`}>
            {list.map((t) => (
              <option key={t.path} value={t.path}>
                {t.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {factory.length === 0 && userTemplates.length === 0 && (
        <div className="mt-1 text-xs text-engrave">{flStudioPath ? L.noTemplates : L.setFlPath}</div>
      )}
    </>
  );
}
