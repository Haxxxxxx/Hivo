import { useEffect, useState } from "react";
import { Clapperboard, Disc3, FileAudio, History, Image, Layers, Mic, Music2, Package, Rocket } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { kitTitleFor } from "../lib/launchKit";
import { kitFolderName } from "../lib/kitState";
import { formatBytes, formatRelative } from "../lib/format";
import type { ProjectInfo } from "../types";
import { FileRow } from "../ui";
import { dict, tr } from "../i18n";

const T = dict(
  {
    project: "Project",
    backups: "Backups",
    backupsDetail: (n: number, size: string) => `${n} backups · ${size}`,
    noneYet: "none yet",
    takes: "Recorded takes",
    takesDetail: (n: number, size: string) => `${n} in Audio/ · ${size}`,
    none: "none",
    stems: "Stems",
    theProjectFolder: "the project folder",
    stemsDetail: (n: number, where: string, size: string, when: string) => `${n} in ${where} · ${size} · ${when}`,
    noStems: "none exported (a Stems folder, or FL's split mixer tracks)",
    mixdowns: "Mixdowns",
    olderMixdowns: (n: number) => `+${n} older mixdowns`,
    setExportFolder: "set an export folder in Settings",
    looking: "looking…",
    notExported: "not exported yet",
    openKit: "Open Launch Kit →",
    kitFiles: (n: number, folder: string) => `${n} files in ${folder}`,
  },
  {
    project: "Projet",
    backups: "Sauvegardes",
    backupsDetail: (n: number, size: string) => `${n} sauvegarde${n > 1 ? "s" : ""} · ${size}`,
    noneYet: "aucune pour l'instant",
    takes: "Prises enregistrées",
    takesDetail: (n: number, size: string) => `${n} dans Audio/ · ${size}`,
    none: "aucune",
    stems: "Stems",
    theProjectFolder: "le dossier du projet",
    stemsDetail: (n: number, where: string, size: string, when: string) => `${n} dans ${where} · ${size} · ${when}`,
    noStems: "aucun exporté (un dossier Stems, ou les pistes du mixer séparées par FL)",
    mixdowns: "Mixdowns",
    olderMixdowns: (n: number) => `+${n} mixdown${n > 1 ? "s" : ""} plus ancien${n > 1 ? "s" : ""}`,
    setExportFolder: "choisis un dossier d'export dans les Réglages",
    looking: "recherche…",
    notExported: "pas encore exporté",
    openKit: "Ouvrir le Launch Kit →",
    kitFiles: (n: number, folder: string) => `${n} fichier${n > 1 ? "s" : ""} dans ${folder}`,
  },
);

// Roadmap 1a: "a clear view of where each track's files live". Everything a
// song has on disk, in one place, each with Reveal.

const fileName = (p: string) => p.split(/[/\\]/).pop() ?? p;
const join = (dir: string, name: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;

function kitIcon(relative: string) {
  if (relative.startsWith("shorts/")) return <Clapperboard size={13} />;
  if (relative.startsWith("snippets/")) return <FileAudio size={13} />;
  if (/\.(jpe?g|png)$/i.test(relative)) return <Image size={13} />;
  if (/\.(wav|mp3|flac|ogg)$/i.test(relative)) return <Disc3 size={13} />;
  return <Package size={13} />;
}

export function FilesPanel({ project }: { project: ProjectInfo }) {
  const settings = useAppStore((s) => s.settings);
  const meta = useAppStore((s) => s.workspace.songs[project.path]);
  const demoMode = useAppStore((s) => s.demoMode);
  const openLaunchKit = useAppStore((s) => s.openLaunchKit);
  const [kit, setKit] = useState<api.KitFile[] | null>(null);
  // The folder the last export went to (it may be "Title (2)"), else the
  // kit's title (as the export names it).
  const kitTitle = kitFolderName(meta, kitTitleFor(project, meta));

  useEffect(() => {
    let live = true;
    if (demoMode || !settings.outputFolder) return setKit([]);
    api
      .kitFiles(kitTitle)
      .then((files) => live && setKit(files ?? []))
      .catch(() => live && setKit([]));
    return () => {
      live = false;
    };
  }, [settings.outputFolder, kitTitle, demoMode, project.modifiedAtMs]);

  // Audio attached from the phone inbox (`<song folder>/BandLab/`), for any
  // song; a sketch's own BandLab audio already shows as its mixdowns.
  const [bandlab, setBandlab] = useState<api.KitFile[]>([]);
  useEffect(() => {
    let live = true;
    if (demoMode || project.daw === "bandlab") return setBandlab([]);
    api
      .bandlabFiles(project.path)
      .then((files) => live && setBandlab(files ?? []))
      .catch(() => live && setBandlab([]));
    return () => {
      live = false;
    };
  }, [project.path, project.daw, project.modifiedAtMs, demoMode]);

  const reveal = (path: string) => void api.revealInFileManager(path).catch(() => {});
  const audioDir = join(project.folder, "Audio");
  const backupsSize = project.backups.reduce((t, b) => t + b.sizeBytes, 0);
  const t = tr(T);

  return (
    <div className="flex flex-col gap-1 text-xs">
      <FileRow icon={<Music2 size={13} />} label={t.project} detail={`${fileName(project.path)} · ${formatBytes(project.sizeBytes)}`} onReveal={demoMode ? undefined : () => reveal(project.path)} />
      <FileRow
        icon={<History size={13} />}
        label={t.backups}
        detail={project.backups.length ? t.backupsDetail(project.backups.length, formatBytes(backupsSize)) : t.noneYet}
        onReveal={project.backups[0] && !demoMode ? () => reveal(project.backups[0].path) : undefined}
      />
      <FileRow
        icon={<Mic size={13} />}
        label={t.takes}
        detail={project.recordingsCount ? t.takesDetail(project.recordingsCount, formatBytes(project.recordingsBytes)) : t.none}
        onReveal={project.recordingsCount && !demoMode ? () => reveal(audioDir) : undefined}
      />
      <FileRow
        icon={<Layers size={13} />}
        label={t.stems}
        detail={
          project.stems
            ? t.stemsDetail(
                project.stems.count,
                fileName(project.stems.folder) || t.theProjectFolder,
                formatBytes(project.stems.bytes),
                formatRelative(project.stems.newestMs),
              )
            : t.noStems
        }
        onReveal={project.stems && !demoMode ? () => reveal(project.stems!.folder) : undefined}
      />
      {project.renders.length === 0 ? (
        <FileRow icon={<Disc3 size={13} />} label={t.mixdowns} detail={t.noneYet} />
      ) : (
        project.renders.slice(0, 4).map((r, i) => (
          <FileRow
            key={r.path}
            icon={<Disc3 size={13} />}
            label={i === 0 ? t.mixdowns : ""}
            detail={`${fileName(r.path)} · ${formatBytes(r.sizeBytes)} · ${formatRelative(r.modifiedAtMs)}`}
            onReveal={demoMode ? undefined : () => reveal(r.path)}
          />
        ))
      )}
      {project.renders.length > 4 && <div className="pl-[118px] text-[11px] text-engrave">{t.olderMixdowns(project.renders.length - 4)}</div>}
      {bandlab.map((f, i) => (
        <FileRow
          key={f.path}
          icon={<FileAudio size={13} />}
          label={i === 0 ? "BandLab" : ""}
          detail={`${f.relative} · ${formatBytes(f.sizeBytes)}`}
          onReveal={() => reveal(f.path)}
        />
      ))}

      <div className="mt-2 border-t border-rule pt-2">
        {!settings.outputFolder ? (
          <FileRow icon={<Rocket size={13} />} label="Launch Kit" detail={t.setExportFolder} />
        ) : kit === null ? (
          <FileRow icon={<Rocket size={13} />} label="Launch Kit" detail={t.looking} />
        ) : kit.length === 0 ? (
          <div className="flex items-center gap-2">
            <FileRow icon={<Rocket size={13} />} label="Launch Kit" detail={t.notExported} />
            <button onClick={() => openLaunchKit(project.path)} className="ml-auto shrink-0 text-[11px] text-body hover:text-cream">
              {t.openKit}
            </button>
          </div>
        ) : (
          <>
            <FileRow icon={<Rocket size={13} />} label="Launch Kit" detail={t.kitFiles(kit.length, `Launch Kits/${kitTitle}`)} onReveal={() => reveal(kit[0].path)} />
            {kit.map((f) => (
              <FileRow key={f.path} icon={kitIcon(f.relative)} label="" detail={`${f.relative} · ${formatBytes(f.sizeBytes)}`} onReveal={() => reveal(f.path)} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
