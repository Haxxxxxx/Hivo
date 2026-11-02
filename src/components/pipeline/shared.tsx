import { createContext, useContext, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowRightLeft, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { usePipelineView, type PipelineScope, type PipelineViewKind } from "../../store/usePipelineView";
import { cardMoves, stageColor, stageLabel, STAGE_ORDER, NAME_MAX } from "../../lib/pipeline";
import type { PipelineColumn, SongStatus } from "../../types";
import { ConfirmButton, StatusDot } from "../ui";
import { dict, plural, tr } from "../../i18n";

/** Every word of the pipeline pages (board, list, table, yours and the crew's). */
export const T_PIPELINE = dict(
  {
    // Page
    board: "Board",
    list: "List",
    table: "Table",
    filterPlaceholder: "Filter songs, #tags, key",
    filterLabel: "Filter songs",
    clearFilter: "Clear filter",
    matching: (shown: number, total: number) => `${shown} of ${total} songs match`,
    clear: "Clear",
    noMatch: "No songs match your search",
    onlyOf: (name: string) => `Only ${name}'s songs`,
    onlyYours: "Only your songs",
    showAll: "Show everyone's",
    emptyMine: "No songs yet. Link a folder in Settings or create a song.",
    emptyCrew: "Nothing shared yet. Share a song from its panel.",
    dismiss: "Dismiss",
    viewLabel: "View",
    // List and table headers
    song: "Song",
    column: "Column",
    saved: "Saved",
    bpm: "BPM",
    key: "Key",
    tags: "Tags",
    who: "Who",
    mixdown: "Mixdown",
    emptyColumn: "Nothing here. Drag a song in.",
    columnsShown: "Columns shown",
    show: "Show",
    boardOrder: "Board order",
    noSongs: "No songs to show.",
    stageOf: (stage: string) => `Stage: ${stage}`,
    // Column header
    dragColumns: "Drag to reorder columns",
    expand: (name: string) => `Expand ${name}`,
    collapse: (name: string) => `Collapse ${name}`,
    columnName: "Column name",
    renameHint: "Double-click (or Enter) to rename",
    stageCrewSees: "The stage the crew sees",
    newSong: "New song",
    moveLeft: "Move left",
    moveEarlier: (name: string) => `Move ${name} earlier`,
    moveRight: "Move right",
    moveLater: (name: string) => `Move ${name} later`,
    rename: "Rename",
    renameColumn: (name: string) => `Rename ${name}`,
    removeHint: (stage: string) => `Remove (songs move to the other ${stage} column)`,
    keepOne: "Every stage keeps one column. Rename it, or collapse it.",
    removeColumn: (name: string) => `Remove ${name}`,
    removeConfirm: "Remove?",
    // Add a column
    addColumn: "Add a column",
    newColumnPlaceholder: "Column name (e.g. Mixing)",
    newColumnLabel: "New column name",
    stagePick: "Stage (what the crew sees)",
    add: "Add",
    cancel: "Cancel",
    // Bits
    conflict: "A crewmate moved this song on the crew board too: open it to choose",
    conflictLabel: "Stage conflict",
    // Crew cards
    you: "You",
    crewmate: "Crewmate",
    savedAgo: (when: string) => `saved ${when}`,
    out: (date: string) => `· out ${date}`,
    hasMixdown: "Has a mixdown",
    mixdownFresh: "Mixdown up to date",
    mixdownStale: "Mixdown older than the last save",
    kitAccepted: "Launch Kit accepted",
    movedBy: (who: string) => `moved by ${who}`,
    youLower: "you",
    aCrewmate: "a crewmate",
    credits: "Credits",
    // Keyboard moves
    moveMenu: (title: string) => `Move ${title}`,
    moveTo: "Move to…",
    moveUp: "Move up",
    moveDown: "Move down",
    toColumn: "To the column",
  },
  {
    board: "Tableau",
    list: "Liste",
    table: "Table",
    filterPlaceholder: "Filtrer sons, #tags, tonalité",
    filterLabel: "Filtrer les sons",
    clearFilter: "Effacer le filtre",
    matching: (shown: number, total: number) => `${shown} son${plural(shown, "", "s")} sur ${total}`,
    clear: "Effacer",
    noMatch: "Aucun son ne correspond à ta recherche",
    onlyOf: (name: string) => `Seulement les sons de ${name}`,
    onlyYours: "Seulement tes sons",
    showAll: "Montrer ceux de tout le monde",
    emptyMine: "Pas encore de son. Relie un dossier dans Réglages ou crée un son.",
    emptyCrew: "Rien de partagé pour l'instant. Partage un son depuis son panneau.",
    dismiss: "Fermer",
    viewLabel: "Vue",
    song: "Son",
    column: "Colonne",
    saved: "Enregistré",
    bpm: "BPM",
    key: "Tonalité",
    tags: "Tags",
    who: "Qui",
    mixdown: "Mixdown",
    emptyColumn: "Rien ici. Glisse un son dedans.",
    columnsShown: "Colonnes affichées",
    show: "Afficher",
    boardOrder: "Ordre du tableau",
    noSongs: "Aucun son à afficher.",
    stageOf: (stage: string) => `Étape : ${stage}`,
    dragColumns: "Glisse pour réordonner les colonnes",
    expand: (name: string) => `Déplier ${name}`,
    collapse: (name: string) => `Replier ${name}`,
    columnName: "Nom de la colonne",
    renameHint: "Double-clic (ou Entrée) pour renommer",
    stageCrewSees: "L'étape que voit le crew",
    newSong: "Nouveau son",
    moveLeft: "Déplacer à gauche",
    moveEarlier: (name: string) => `Avancer ${name}`,
    moveRight: "Déplacer à droite",
    moveLater: (name: string) => `Reculer ${name}`,
    rename: "Renommer",
    renameColumn: (name: string) => `Renommer ${name}`,
    removeHint: (stage: string) => `Supprimer (les sons passent dans l'autre colonne ${stage})`,
    keepOne: "Chaque étape garde au moins une colonne. Renomme-la ou replie-la.",
    removeColumn: (name: string) => `Supprimer ${name}`,
    removeConfirm: "Supprimer ?",
    addColumn: "Ajouter une colonne",
    newColumnPlaceholder: "Nom de la colonne (ex. Mix)",
    newColumnLabel: "Nom de la nouvelle colonne",
    stagePick: "Étape (ce que voit le crew)",
    add: "Ajouter",
    cancel: "Annuler",
    conflict: "Quelqu'un du crew a aussi déplacé ce son sur le tableau du crew : ouvre-le pour choisir",
    conflictLabel: "Conflit d'étape",
    you: "Toi",
    crewmate: "Membre du crew",
    savedAgo: (when: string) => `enregistré ${when}`,
    out: (date: string) => `· sortie le ${date}`,
    hasMixdown: "A un mixdown",
    mixdownFresh: "Mixdown à jour",
    mixdownStale: "Mixdown plus vieux que la dernière sauvegarde",
    kitAccepted: "Launch Kit validé",
    movedBy: (who: string) => `déplacé par ${who}`,
    youLower: "toi",
    aCrewmate: "quelqu'un du crew",
    credits: "Crédits",
    moveMenu: (title: string) => `Déplacer ${title}`,
    moveTo: "Déplacer vers…",
    moveUp: "Monter",
    moveDown: "Descendre",
    toColumn: "Vers la colonne",
  },
);

// Pieces shared by the board, list and table, for any pipeline: yours
// (src/components/pipeline/mine.tsx) or the crew's (crew.tsx). A pipeline is
// a `PipelineSource`: its columns with their items, and what you may do.
// One place, so the views (and the two pipelines) can't drift apart.

/** One song on a pipeline, whatever it is underneath. */
export interface PipelineItem {
  /** Your song's .flp path, or the crew song's id. */
  key: string;
  title: string;
  /** Last save, ms (0 = unknown). */
  savedMs: number;
  bpm: number | null;
  musicalKey: string;
  tags: string[];
  /** A crewmate moved it while your move was waiting. */
  conflict?: boolean;
  /** The board card's body (under the title). */
  card: ReactNode;
  /** The list row's last cell (mixdown badge, who). */
  extra?: ReactNode;
  open?: () => void;
  selected?: boolean;
}

export interface PipelineGroup {
  column: PipelineColumn;
  items: PipelineItem[];
}

export interface PipelineSource {
  scope: PipelineScope;
  groups: PipelineGroup[];
  query: string;
  /** Songs on the pipeline, and how many the query lets through. */
  total: number;
  shown: number;
  /** Columns can be renamed, added, removed, reordered here. */
  editable: boolean;
  canRemove: (columnId: string) => boolean;
  rename: (columnId: string, name: string) => void;
  add: (name: string, stage: SongStatus | null) => void;
  remove: (columnId: string) => void;
  moveColumn: (columnId: string, toIndex: number) => void;
  /** Put a song in a column, before another (or at the end). */
  moveCard: (key: string, columnId: string, beforeKey: string | null) => void;
  /** "New song" on the Creation column (your pipeline only). */
  newSong?: () => void;
  /** A filter set from elsewhere (the crew board scoped to one member):
   * what it shows, and how to lift it. */
  scoped?: { label: string; clear: () => void } | null;
  /** Shown above the views (a refused move, a failed save). */
  error?: string | null;
  clearError?: () => void;
}

const SourceContext = createContext<PipelineSource | null>(null);
export const PipelineSourceProvider = SourceContext.Provider;
export function useSource(): PipelineSource {
  const s = useContext(SourceContext);
  if (!s) throw new Error("pipeline views need a PipelineSourceProvider");
  return s;
}

/** The visible focus ring of a card or row reached with the keyboard. */
export const CARD_FOCUS = "focus-visible:outline-2 focus-visible:outline-cream";

/** A card's or row's title: a real button when the song opens (the card
 * itself is only a mouse target), plain text when it doesn't (a crewmate's
 * song not on this computer), so nothing focusable does nothing. */
export function CardTitle({ item, className = "" }: { item: PipelineItem; className?: string }) {
  if (!item.open) return <span className={`truncate font-medium text-cream ${className}`}>{item.title}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        item.open?.();
      }}
      aria-pressed={item.selected ?? undefined}
      className={`min-w-0 truncate rounded text-left font-medium text-cream hover:underline ${CARD_FOCUS} ${className}`}
    >
      {item.title}
    </button>
  );
}

/** The keyboard way to move a card (dragging is mouse only): a native menu
 * with up / down in its column and every other column, like the column
 * picker on the website's crew board. Shown on hover and on focus. */
export function MoveMenu({ item }: { item: PipelineItem }) {
  const source = useSource();
  const t = tr(T_PIPELINE);
  const moves = cardMoves(source.groups, item.key, !source.query);
  if (moves.length === 0) return null;
  const columns = moves.filter((m) => m.kind === "column");
  return (
    <label
      title={t.moveTo}
      onClick={(e) => e.stopPropagation()}
      className="relative flex shrink-0 cursor-pointer items-center rounded p-0.5 text-engrave opacity-0 hover:bg-rule hover:text-cream focus-within:opacity-100 focus-within:outline-2 focus-within:outline-cream group-hover/card:opacity-100 group-focus-within/card:opacity-100"
    >
      <ArrowRightLeft size={12} aria-hidden />
      <select
        value=""
        aria-label={t.moveMenu(item.title)}
        onChange={(e) => {
          const move = moves.find((m) => m.id === e.target.value);
          if (move) source.moveCard(item.key, move.columnId, move.beforeKey);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="" disabled>
          {t.moveTo}
        </option>
        {moves.map((m) => m.kind === "up" && <option key={m.id} value={m.id}>{t.moveUp}</option>)}
        {moves.map((m) => m.kind === "down" && <option key={m.id} value={m.id}>{t.moveDown}</option>)}
        {columns.length > 0 && (
          <optgroup label={t.toColumn}>
            {columns.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

// ---- Drag rules (HTML5 drag and drop; Tauri's own file drop is off) ----

const COLUMN_TYPE = "application/x-hivo-column";
/** Songs travel as text/plain (their key). */
const SONG_TYPE = "text/plain";

export function dragKind(e: DragEvent): "song" | "column" | null {
  const types = Array.from(e.dataTransfer.types);
  if (types.includes(COLUMN_TYPE)) return "column";
  if (types.includes(SONG_TYPE)) return "song";
  return null;
}

export function startSongDrag(e: DragEvent, key: string) {
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(SONG_TYPE, key);
}

export function startColumnDrag(e: DragEvent, id: string) {
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(COLUMN_TYPE, id);
}

/** Dropping on a card or row: before it (top half) or before the next one. */
export function beforeKeyFor(e: DragEvent, list: PipelineItem[], index: number): string | null {
  const r = e.currentTarget.getBoundingClientRect();
  const upper = e.clientY < r.top + r.height / 2;
  return upper ? list[index].key : (list[index + 1]?.key ?? null);
}

/** Where a dragged song would land (for the drop line). */
export interface DropSpot {
  columnId: string;
  beforeKey: string | null;
}

/** Drop handling for songs and columns, shared by the board and the list. */
export function usePipelineDrop() {
  const source = useSource();
  const [spot, setSpotState] = useState<DropSpot | null>(null);
  const [columnOver, setColumnOver] = useState<string | null>(null);
  // The drop reads the latest spot from a ref: state can lag a render behind
  // the last dragover, which would land the card one slot off.
  const spotRef = useRef<DropSpot | null>(null);
  const setSpot = (next: DropSpot | null) => {
    if (spotRef.current?.columnId === next?.columnId && spotRef.current?.beforeKey === next?.beforeKey) return;
    spotRef.current = next;
    setSpotState(next);
  };
  return {
    spot,
    columnOver,
    /** dragover on a column (or a card in it, with its before-key). */
    over(e: DragEvent, columnId: string, beforeKey: string | null) {
      const kind = dragKind(e);
      if (!kind || (kind === "column" && !source.editable)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (kind === "song") setSpot({ columnId, beforeKey });
      else setColumnOver(columnId);
    },
    leave(e: DragEvent) {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setSpot(null);
        setColumnOver(null);
      }
    },
    drop(e: DragEvent, columnId: string, columnIndex: number) {
      e.preventDefault();
      e.stopPropagation();
      const kind = dragKind(e);
      const latest = spotRef.current;
      const target = latest?.columnId === columnId ? latest.beforeKey : null;
      setSpot(null);
      setColumnOver(null);
      if (kind === "column") {
        const id = e.dataTransfer.getData(COLUMN_TYPE);
        if (source.editable && id && id !== columnId) source.moveColumn(id, columnIndex);
        return;
      }
      // Only songs of this pipeline: dragged text or links aren't songs.
      const key = e.dataTransfer.getData(SONG_TYPE);
      if (source.groups.some((g) => g.items.some((i) => i.key === key))) source.moveCard(key, columnId, target);
    },
    end() {
      setSpot(null);
      setColumnOver(null);
    },
  };
}

// ---- Column header ----

export function ColumnHeader({
  column,
  count,
  view,
  collapsed,
  className = "",
}: {
  column: PipelineColumn;
  count: number;
  view: PipelineViewKind;
  collapsed: boolean;
  className?: string;
}) {
  const source = useSource();
  const toggleCollapsed = usePipelineView((s) => s.toggleCollapsed);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const startEditing = () => {
    if (!source.editable) return;
    cancelled.current = false;
    setEditing(true);
  };
  const columns = source.groups.map((g) => g.column);
  const index = columns.findIndex((c) => c.id === column.id);
  const removable = source.canRemove(column.id);
  const renamed = column.name.toLowerCase() !== stageLabel(column.stage).toLowerCase();
  const hasActions = source.editable || (column.stage === "creation" && !!source.newSong);
  const t = tr(T_PIPELINE);

  return (
    <div
      draggable={source.editable && !editing}
      onDragStart={(e) => startColumnDrag(e, column.id)}
      title={source.editable && !editing ? t.dragColumns : undefined}
      className={`group/col relative min-w-0 ${source.editable ? "cursor-grab active:cursor-grabbing" : ""} ${className}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          onClick={() => toggleCollapsed(source.scope, view, column.id)}
          aria-label={collapsed ? t.expand(column.name) : t.collapse(column.name)}
          aria-expanded={!collapsed}
          className="shrink-0 rounded text-engrave hover:text-cream"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <StatusDot color={stageColor(column.stage)} />
        {editing ? (
          <input
            autoFocus
            defaultValue={column.name}
            maxLength={NAME_MAX}
            aria-label={t.columnName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelled.current = true;
                setEditing(false);
              }
            }}
            onBlur={(e) => {
              if (!cancelled.current) source.rename(column.id, e.currentTarget.value);
              cancelled.current = false;
              setEditing(false);
            }}
            className="min-w-0 flex-1 rounded border border-hot bg-chassis px-1 py-0 text-xs font-medium text-cream focus:outline-none"
          />
        ) : (
          <button
            onDoubleClick={startEditing}
            onKeyDown={(e) => source.editable && (e.key === "Enter" || e.key === "F2") && (e.preventDefault(), startEditing())}
            title={source.editable ? t.renameHint : undefined}
            className="min-w-0 truncate text-left text-xs font-medium text-cream"
          >
            {column.name}
          </button>
        )}
        <span className="shrink-0 text-xs text-engrave">{count}</span>
      </div>
      {renamed && !editing && (
        <div className="mt-0.5 pl-[34px] font-mono text-[10.5px] uppercase tracking-wider text-engrave" title={t.stageCrewSees}>
          {stageLabel(column.stage)}
        </div>
      )}
      {/* Actions float over the header on hover/focus, so they never squeeze the name. */}
      {!editing && hasActions && (
        <span className="absolute right-0 top-0 flex items-center gap-0.5 rounded bg-panel pl-1 opacity-0 focus-within:opacity-100 group-hover/col:opacity-100">
          {column.stage === "creation" && source.newSong && (
            <button onClick={source.newSong} title={t.newSong} aria-label={t.newSong} className="rounded p-0.5 text-engrave hover:bg-rule hover:text-cream">
              <Plus size={13} />
            </button>
          )}
          {source.editable && (
            <>
              <button onClick={() => source.moveColumn(column.id, index - 1)} disabled={index <= 0} title={t.moveLeft} aria-label={t.moveEarlier(column.name)} className="rounded p-0.5 text-engrave hover:bg-rule hover:text-cream disabled:opacity-30">
                <ArrowLeft size={12} />
              </button>
              <button onClick={() => source.moveColumn(column.id, index + 1)} disabled={index >= columns.length - 1} title={t.moveRight} aria-label={t.moveLater(column.name)} className="rounded p-0.5 text-engrave hover:bg-rule hover:text-cream disabled:opacity-30">
                <ArrowRight size={12} />
              </button>
              <button onClick={startEditing} title={t.rename} aria-label={t.renameColumn(column.name)} className="rounded p-0.5 text-engrave hover:bg-rule hover:text-cream">
                <Pencil size={12} />
              </button>
              <span title={removable ? t.removeHint(stageLabel(column.stage)) : t.keepOne}>
                <ConfirmButton
                  disabled={!removable}
                  label={<Trash2 size={12} aria-label={t.removeColumn(column.name)} />}
                  confirmLabel={t.removeConfirm}
                  onConfirm={() => source.remove(column.id)}
                  className="rounded border border-transparent p-0.5 text-[10px] text-engrave hover:bg-rule hover:text-cream disabled:opacity-30"
                />
              </span>
            </>
          )}
        </span>
      )}
    </div>
  );
}

// ---- Add a column ----

export function AddColumn({ compact = false }: { compact?: boolean }) {
  const source = useSource();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [stage, setStage] = useState<SongStatus | null>("production");
  if (!source.editable || source.query) return null;
  const t = tr(T_PIPELINE);
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 rounded-lg border border-dashed border-rule px-3 py-2 text-xs text-engrave hover:border-rule-strong hover:text-cream ${compact ? "" : "h-fit min-w-[150px]"}`}
      >
        <Plus size={13} /> {t.addColumn}
      </button>
    );
  }
  const submit = () => {
    if (!name.trim()) return;
    source.add(name, stage);
    setName("");
    setOpen(false);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={`flex h-fit flex-col gap-2 rounded-lg border border-rule bg-panel p-3 ${compact ? "max-w-sm" : "min-w-[190px]"}`}
    >
      <input
        autoFocus
        value={name}
        maxLength={NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder={t.newColumnPlaceholder}
        aria-label={t.newColumnLabel}
        className="rounded border border-rule-strong bg-chassis px-2 py-1.5 text-xs text-cream placeholder:text-engrave focus:border-hot focus:outline-none"
      />
      <label className="flex flex-col gap-1 text-[11px] text-engrave">
        {t.stagePick}
        <select
          value={stage ?? ""}
          onChange={(e) => setStage((e.target.value || null) as SongStatus | null)}
          className="rounded border border-rule-strong bg-chassis px-2 py-1.5 text-xs text-cream"
        >
          {STAGE_ORDER.map((s) => (
            <option key={s ?? "unsorted"} value={s ?? ""}>
              {stageLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={!name.trim()} className="rounded bg-hot px-2.5 py-1 text-xs font-semibold text-chassis disabled:opacity-50">
          {t.add}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-2 text-xs text-engrave hover:text-cream">
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

// ---- Bits ----

export function ConflictDot({ on }: { on?: boolean }) {
  if (!on) return null;
  return (
    <span
      title={tr(T_PIPELINE).conflict}
      aria-label={tr(T_PIPELINE).conflictLabel}
      className="h-2 w-2 shrink-0 rounded-full bg-amber-400"
    />
  );
}

/** The orange line where a dragged song will land. */
export function DropLine() {
  return <div className="h-0.5 rounded-full bg-hot" aria-hidden />;
}

/** A source's error, above the views. */
export function SourceError() {
  const { error, clearError } = useSource();
  if (!error) return null;
  return (
    <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-cream">
      <span className="min-w-0 flex-1">{error}</span>
      {clearError && (
        <button onClick={clearError} aria-label={tr(T_PIPELINE).dismiss} className="shrink-0 rounded p-0.5 text-engrave hover:text-cream">
          <X size={12} />
        </button>
      )}
    </div>
  );
}
