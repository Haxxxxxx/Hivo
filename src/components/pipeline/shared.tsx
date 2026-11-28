import { useRef, useState, type DragEvent } from "react";
import { useSource, type PipelineItem, type PipelineSource } from "./source";
import { ArrowLeft, ArrowRight, ArrowRightLeft, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { usePipelineView, type PipelineViewKind } from "../../store/usePipelineView";
import { cardMoves, columnColor, columnTint, COLUMN_COLORS, stageLabel, STAGE_ORDER, NAME_MAX } from "../../lib/pipeline";
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
    emptyBoard: "Nothing on this pipeline yet — your songs are on another one. Pick them in the Library and move them here.",
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
    pipelines: "Pipelines",
    newPipeline: "New pipeline",
    newPipelineName: "Name of the new pipeline",
    renamePipeline: (name: string) => `Rename ${name}`,
    removePipeline: (name: string) => `Delete ${name} (its songs move to the first pipeline)`,
    color: "Colour",
    colorOf: (name: string) => `Colour of ${name}`,
    stageColour: "Stage colour",
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
    toPipeline: "To pipeline",
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
    emptyBoard: "Rien sur ce pipeline pour l'instant — tes sons sont sur un autre. Sélectionne-les dans la Bibliothèque et déplace-les ici.",
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
    pipelines: "Pipelines",
    newPipeline: "Nouveau pipeline",
    newPipelineName: "Nom du nouveau pipeline",
    renamePipeline: (name: string) => `Renommer ${name}`,
    removePipeline: (name: string) => `Supprimer ${name} (ses sons passent au premier pipeline)`,
    color: "Couleur",
    colorOf: (name: string) => `Couleur de ${name}`,
    stageColour: "Couleur de l'étape",
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
    toPipeline: "Vers le pipeline",
    moveUp: "Monter",
    moveDown: "Descendre",
    toColumn: "Vers la colonne",
  },
);

// Pieces shared by the board, list and table, for any pipeline: yours
// (src/components/pipeline/mine.tsx) or the crew's (crew.tsx). A pipeline is
// a `PipelineSource`: its columns with their items, and what you may do.
// One place, so the views (and the two pipelines) can't drift apart.
//
// The source itself — its types, the context and useSource — lives in
// ./source, and is imported from there, not re-exported through here.
// This file exports components, so React Fast Refresh invalidates it on
// every edit; a context created here would be a new object each time and
// the provider would stop matching its own children. See ./source.

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

/** Marks a board option, so it cannot collide with a cardMoves id. */
const BOARD_OPT = "board:";

/** The keyboard way to move a card (dragging is mouse only): a native menu
 * with up / down in its column and every other column, like the column
 * picker on the website's crew board. Shown on hover and on focus. */
export function MoveMenu({ item }: { item: PipelineItem }) {
  const source = useSource();
  const t = tr(T_PIPELINE);
  const moves = cardMoves(source.groups, item.key, !source.query);
  // Other pipelines this song could go to. Moving one used to mean finding
  // it in the Library, selecting it and using the bulk bar — not something
  // anyone discovers, and not where you are when you decide to move it.
  const others = source.moveToBoard && source.boards ? source.boards.list.filter((b) => b.id !== source.boards!.active) : [];
  if (moves.length === 0 && others.length === 0) return null;
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
          const board = e.target.value.startsWith(BOARD_OPT) ? e.target.value.slice(BOARD_OPT.length) : null;
          if (board) {
            source.moveToBoard?.(item.key, board);
            return;
          }
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
        {others.length > 0 && (
          <optgroup label={t.toPipeline}>
            {others.map((b) => (
              <option key={b.id} value={`${BOARD_OPT}${b.id}`}>
                {b.name}
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
      style={{ backgroundColor: columnTint(column.color, 0.18) }}
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
        <ColumnColor column={column} />
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

/** Pick the pipeline, and manage the list.
 *
 * Only where `boards` is provided — the crew board has one shared set of
 * columns on the server, so it has no pipelines to switch between. */
export function BoardSwitcher({ boards }: { boards?: PipelineSource["boards"] }) {
  // Takes `boards` as a prop, NOT useSource(): this renders in the page
  // header, which is outside PipelineSourceProvider. Reading the context
  // here threw and took the whole app down to a black screen.
  //
  // Names are edited INLINE, like a column's. window.prompt is not
  // implemented in Tauri's webview — it returns null, so the + button and
  // rename silently did nothing at all. (window.confirm does work, which is
  // what made the gap easy to miss.)
  const [editing, setEditing] = useState<string | null>(null);
  const cancelled = useRef(false);
  const t = tr(T_PIPELINE);
  if (!boards || boards.list.length === 0) return null;
  const current = boards.list.find((b) => b.id === boards.active) ?? boards.list[0];

  const commit = (value: string) => {
    const name = value.trim();
    if (!cancelled.current && name) {
      if (editing === "+") boards.add(name);
      else if (editing) boards.rename(editing, name);
    }
    cancelled.current = false;
    setEditing(null);
  };

  const nameInput = (defaultValue: string, label: string) => (
    <input
      autoFocus
      defaultValue={defaultValue}
      maxLength={NAME_MAX}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          setEditing(null);
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      className="w-28 rounded border border-hot bg-chassis px-1.5 py-1 text-xs text-cream focus:outline-none"
    />
  );

  return (
    <div className="flex items-center gap-1" role="group" aria-label={t.pipelines}>
      <div className="flex items-center rounded-md border border-rule p-0.5 text-xs" role="tablist" aria-label={t.pipelines}>
        {boards.list.map((b) =>
          editing === b.id ? (
            <span key={b.id}>{nameInput(b.name, t.renamePipeline(b.name))}</span>
          ) : (
            <button
              key={b.id}
              role="tab"
              aria-selected={b.id === boards.active}
              onClick={() => boards.setActive(b.id)}
              onDoubleClick={() => setEditing(b.id)}
              title={t.renameHint}
              className={`rounded px-2.5 py-1 ${b.id === boards.active ? "bg-rule-strong text-cream" : "text-engrave hover:text-cream"}`}
            >
              {b.name}
            </button>
          ),
        )}
        {editing === "+" && <span>{nameInput("", t.newPipelineName)}</span>}
      </div>
      <button
        onClick={() => setEditing("+")}
        aria-label={t.newPipeline}
        title={t.newPipeline}
        className="rounded p-1 text-engrave hover:text-cream"
      >
        <Plus size={13} />
      </button>
      {boards.list.length > 1 && (
        <ConfirmButton
          label={<Trash2 size={13} aria-label={t.removePipeline(current.name)} />}
          confirmLabel={t.removeConfirm}
          onConfirm={() => boards.remove(current.id)}
          className="rounded border border-transparent p-1 text-[10px] text-engrave hover:bg-rule hover:text-red-300"
        />
      )}
    </div>
  );
}

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

/** The column's dot, and — on your own pipeline — a palette behind it.
 *
 * The dot stays a dot: the stage NAME is always rendered next to it, so a
 * recoloured column never makes colour the only carrier of meaning. The
 * palette deliberately excludes the stage ramp, so a custom colour cannot
 * impersonate a lifecycle stage the crew reads. */
function ColumnColor({ column }: { column: PipelineColumn }) {
  const source = useSource();
  const [open, setOpen] = useState(false);
  const t = tr(T_PIPELINE);
  const recolor = source.editable ? source.recolor : undefined;

  if (!recolor) return <StatusDot color={columnColor(column)} />;
  return (
    <span className="relative flex shrink-0 items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={t.colorOf(column.name)}
        aria-expanded={open}
        className="flex items-center rounded p-0.5 hover:bg-rule"
      >
        <StatusDot color={columnColor(column)} />
      </button>
      {open && (
        <span
          className="absolute left-0 top-5 z-20 flex flex-wrap items-center gap-1 rounded border border-rule-strong bg-raised p-1.5 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {COLUMN_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => {
                recolor(column.id, c);
                setOpen(false);
              }}
              aria-label={c}
              style={{ background: c }}
              className={`h-4 w-4 rounded-full ${column.color === c ? "ring-2 ring-cream" : ""}`}
            />
          ))}
          <button
            onClick={() => {
              recolor(column.id, null);
              setOpen(false);
            }}
            className="rounded border border-dashed border-rule-strong px-1.5 py-0.5 text-[10px] text-engrave hover:text-cream"
          >
            {t.stageColour}
          </button>
        </span>
      )}
    </span>
  );
}
