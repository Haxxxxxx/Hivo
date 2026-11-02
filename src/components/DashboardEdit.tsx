import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, X } from "lucide-react";
import { nextSize, type BlockSize, type DashboardBlockId } from "../lib/dashboardLayout";
import { engrave } from "../ui";
import { dict, tr } from "../i18n";

/** Every word of the dashboard's edit mode (the top bar, the block strips, the tray). */
export const T_LAYOUT = dict(
  {
    editLayout: "Edit layout",
    done: "Done",
    resetLayout: "Reset layout",
    resetConfirm: "Reset?",
    dragToReorder: "Drag to move this block",
    moveUp: "Move up",
    moveDown: "Move down",
    hide: "Hide",
    width: "Width",
    sizeName: (size: BlockSize) => ({ full: "Full", half: "Half", third: "Third" })[size],
    addBlock: "Add block",
    add: "Add",
    allShown: "Every block is on the dashboard.",
    emptyBlock: "Nothing to show here yet.",
    look: "Look",
    blockTitle: (id: DashboardBlockId) =>
      ({
        stats: "Stats",
        pickUp: "Pick up where you left off",
        nextRelease: "Next release",
        stalled: "Stalled",
        crewWho: "Crew · who's on what",
        activity: "Studio activity",
        pipeline: "Pipeline",
        openCleanly: "Will this computer open your songs?",
        attention: "Needs attention",
        storage: "Storage",
        pitches: "Pitches",
        releases: "Releases",
        tempoKey: "Tempo & key tendencies",
        workingHours: "Working hours",
        yourSound: "Your sound",
        collaborators: "Collaborators",
        songShape: "Song shape",
      })[id],
    /** One line under the title saying what the block reads (tendency blocks only). */
    blockSubtitle: (id: DashboardBlockId): string =>
      ({
        tempoKey: "Project tempos and the keys you set, across your songs",
        workingHours: "Every save, by weekday and hour, last 12 months",
        yourSound: "Plugins and sample folders, by the songs they're in",
        collaborators: "Credits on your songs",
        songShape: "Versions, time to a first mixdown, and when songs start",
      })[id as TendencyBlockId] ?? "",
  },
  {
    editLayout: "Modifier la disposition",
    done: "Terminé",
    resetLayout: "Disposition par défaut",
    resetConfirm: "Réinitialiser ?",
    dragToReorder: "Glisse pour déplacer ce bloc",
    moveUp: "Monter",
    moveDown: "Descendre",
    hide: "Masquer",
    width: "Largeur",
    sizeName: (size: BlockSize) => ({ full: "Pleine", half: "Moitié", third: "Tiers" })[size],
    addBlock: "Ajouter un bloc",
    add: "Ajouter",
    allShown: "Tous les blocs sont sur le tableau de bord.",
    emptyBlock: "Rien à afficher ici pour l'instant.",
    look: "Affichage",
    blockTitle: (id: DashboardBlockId) =>
      ({
        stats: "Stats",
        pickUp: "Reprends là où tu en étais",
        nextRelease: "Prochaine sortie",
        stalled: "À l'arrêt",
        crewWho: "Crew · qui bosse sur quoi",
        activity: "Activité studio",
        pipeline: "Pipeline",
        openCleanly: "Cet ordi va-t-il ouvrir tes sons ?",
        attention: "À compléter",
        storage: "Stockage",
        pitches: "Pitchs",
        releases: "Sorties",
        tempoKey: "Tendances tempo & tonalité",
        workingHours: "Heures de travail",
        yourSound: "Ton son",
        collaborators: "Collaborateurs",
        songShape: "Forme des sons",
      })[id],
    blockSubtitle: (id: DashboardBlockId): string =>
      ({
        tempoKey: "Les tempos des projets et les tonalités que tu as notées, sur tous tes sons",
        workingHours: "Chaque sauvegarde, par jour de la semaine et par heure, 12 derniers mois",
        yourSound: "Plugins et dossiers de samples, par nombre de sons où ils sont",
        collaborators: "Les crédits de tes sons",
        songShape: "Versions, délai jusqu'au premier mixdown, et quand les sons démarrent",
      })[id as TendencyBlockId] ?? "",
  },
);

/** The optional tendency blocks (src/lib/tendencies.ts): hidden by default. */
export type TendencyBlockId = "tempoKey" | "workingHours" | "yourSound" | "collaborators" | "songShape";

// ---- Grid ----

/** Column spans on the 12-column grid: thirds on wide windows, two columns
 * down to `sm`, one below it. Full strings so Tailwind sees them. */
export const SIZE_CLASS: Record<BlockSize, string> = {
  full: "col-span-12",
  half: "col-span-12 sm:col-span-6",
  third: "col-span-12 sm:col-span-6 xl:col-span-4",
};

// ---- Drag rules (HTML5 drag and drop, like the pipeline's columns) ----

/** Blocks travel under their own type, so the window's file-drop guard and
 * the pipeline's song drags never see them. */
const BLOCK_TYPE = "application/x-hivo-block";

function isBlockDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(BLOCK_TYPE);
}

/** Where a dragged block would land: before or after another block. */
export interface BlockDropSpot {
  id: DashboardBlockId;
  before: boolean;
}

/** Drag state shared by the blocks of one dashboard. */
export function useBlockDrag(onDrop: (id: DashboardBlockId, spot: BlockDropSpot) => void) {
  const [spot, setSpotState] = useState<BlockDropSpot | null>(null);
  // The drop reads the latest spot from a ref: state can lag a render behind
  // the last dragover.
  const spotRef = useRef<BlockDropSpot | null>(null);
  const setSpot = (next: BlockDropSpot | null) => {
    if (spotRef.current?.id === next?.id && spotRef.current?.before === next?.before) return;
    spotRef.current = next;
    setSpotState(next);
  };
  return {
    spot,
    start(e: DragEvent, id: DashboardBlockId) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(BLOCK_TYPE, id);
    },
    over(e: DragEvent, id: DashboardBlockId) {
      if (!isBlockDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      setSpot({ id, before: e.clientY < r.top + r.height / 2 });
    },
    leave(e: DragEvent) {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSpot(null);
    },
    drop(e: DragEvent) {
      if (!isBlockDrag(e)) return;
      e.preventDefault();
      const id = e.dataTransfer.getData(BLOCK_TYPE) as DashboardBlockId;
      const latest = spotRef.current;
      setSpot(null);
      if (id && latest && latest.id !== id) onDrop(id, latest);
    },
    end() {
      setSpot(null);
    },
  };
}

// ---- Pieces ----

/** Two or three looks for one block, as a segmented control in its header.
 * The chosen one is cream on black, like every selection. */
export function VariantSwitch({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 rounded border border-rule-strong p-px font-mono text-[10px] uppercase tracking-[0.08em]">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={o.id === value}
          className={`rounded-[3px] px-1.5 py-0.5 ${o.id === value ? "bg-cream text-chassis" : "text-engrave hover:text-cream"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const stripButton = "rounded p-0.5 text-engrave hover:bg-rule hover:text-cream disabled:opacity-30";

/** One block of the grid. Out of edit mode it's just its content at its
 * width. In edit mode it gets a dashed outline and a strip to drag, move,
 * resize and hide it. */
export function BlockFrame({
  id,
  size,
  editing,
  index,
  count,
  drag,
  onMove,
  onSize,
  onHide,
  children,
}: {
  id: DashboardBlockId;
  size: BlockSize;
  editing: boolean;
  /** Position among the visible blocks, for Move up / Move down. */
  index: number;
  count: number;
  drag: ReturnType<typeof useBlockDrag>;
  onMove: (to: number) => void;
  onSize: (size: BlockSize) => void;
  onHide: () => void;
  children: ReactNode;
}) {
  const t = tr(T_LAYOUT);
  const title = t.blockTitle(id);

  if (!editing) return <section className={`min-w-0 ${SIZE_CLASS[size]}`}>{children}</section>;

  const over = drag.spot?.id === id ? drag.spot : null;
  return (
    <section
      aria-label={title}
      onDragOver={(e) => drag.over(e, id)}
      onDragLeave={drag.leave}
      onDrop={drag.drop}
      className={`relative flex min-w-0 flex-col gap-1 rounded border border-dashed border-rule-strong p-1 ${SIZE_CLASS[size]}`}
    >
      {over && <div className={`absolute inset-x-1 h-0.5 rounded-full bg-hot ${over.before ? "-top-[3px]" : "-bottom-[3px]"}`} aria-hidden />}
      {/* Only the strip is draggable: the content keeps its own gestures
          (the attention carousel scrolls by dragging). */}
      <div
        draggable
        onDragStart={(e) => drag.start(e, id)}
        onDragEnd={drag.end}
        title={t.dragToReorder}
        className="flex cursor-grab items-center gap-1 rounded bg-raised px-1.5 py-1 active:cursor-grabbing"
      >
        <GripVertical size={13} className="shrink-0 text-engrave" aria-hidden />
        <span className={`min-w-0 flex-1 truncate ${engrave}`}>{title}</span>
        <button onClick={() => onSize(nextSize(size))} title={t.width} aria-label={`${t.width}: ${t.sizeName(size)}`} className={`${stripButton} px-1.5 font-mono text-[10px] uppercase tracking-[0.08em]`}>
          {t.sizeName(size)}
        </button>
        <button onClick={() => onMove(index - 1)} disabled={index <= 0} title={t.moveUp} aria-label={`${t.moveUp}: ${title}`} className={stripButton}>
          <ChevronUp size={13} />
        </button>
        <button onClick={() => onMove(index + 1)} disabled={index >= count - 1} title={t.moveDown} aria-label={`${t.moveDown}: ${title}`} className={stripButton}>
          <ChevronDown size={13} />
        </button>
        <button onClick={onHide} title={t.hide} aria-label={`${t.hide}: ${title}`} className={stripButton}>
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </section>
  );
}

/** What a block shows in edit mode when it has nothing to draw yet. */
export function EmptyBlock() {
  return <div className="rounded border border-rule bg-panel p-5 text-xs text-engrave">{tr(T_LAYOUT).emptyBlock}</div>;
}

/** The hidden blocks, each with an Add button, under the grid in edit mode. */
export function AddBlockTray({ hidden, onShow }: { hidden: DashboardBlockId[]; onShow: (id: DashboardBlockId) => void }) {
  const t = tr(T_LAYOUT);
  return (
    <div className="col-span-12 rounded border border-dashed border-rule-strong p-4">
      <div className={`mb-2 flex items-center gap-1.5 ${engrave}`}>
        <Plus size={12} /> {t.addBlock}
      </div>
      {hidden.length === 0 ? (
        <div className="text-xs text-engrave">{t.allShown}</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {hidden.map((id) => (
            <div key={id} className="flex items-center gap-2 rounded border border-rule bg-panel px-2.5 py-1.5 text-xs text-cream">
              <span>{t.blockTitle(id)}</span>
              <button onClick={() => onShow(id)} aria-label={`${t.add}: ${t.blockTitle(id)}`} className="font-display text-[13px] font-semibold uppercase tracking-[0.06em] text-body hover:text-cream">
                {t.add}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
