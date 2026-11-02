import { Fragment } from "react";
import { useCollapsed } from "../../store/usePipelineView";
import { formatRelative } from "../../lib/format";
import { formatBpm } from "../../lib/songs";
import { AddColumn, beforeKeyFor, CardTitle, ColumnHeader, ConflictDot, DropLine, MoveMenu, SourceError, startSongDrag, T_PIPELINE, usePipelineDrop, useSource } from "./shared";
import { tr } from "../../i18n";

const ROW = "grid grid-cols-[minmax(0,1fr)_7rem_4.5rem_5rem_minmax(0,10rem)_7rem] items-center gap-3";

/** The board as sections, one per column, one row per song. Same model and
 * drag rules as the board: drag rows to reorder or move them, drag a section
 * header to reorder columns. */
export function PipelineList() {
  const source = useSource();
  const { groups, query, scope } = source;
  const collapsed = useCollapsed(scope, "list");
  const dnd = usePipelineDrop();
  const t = tr(T_PIPELINE);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4" onDragEnd={dnd.end}>
      <SourceError />
      {/* Visual headers only: each row's cells carry their own label for screen readers. */}
      <div className={`${ROW} px-3 pb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave`} aria-hidden>
        <span>{t.song}</span>
        <span>{t.saved}</span>
        <span>{t.bpm}</span>
        <span>{t.key}</span>
        <span>{t.tags}</span>
        <span className="text-right">{scope === "crew" ? t.who : t.mixdown}</span>
      </div>
      <div className="flex flex-col gap-3">
        {groups.map(({ column, items }, colIndex) => {
          const isCollapsed = collapsed.includes(column.id);
          const active = dnd.spot?.columnId === column.id || dnd.columnOver === column.id;
          return (
            <section
              key={column.id}
              aria-label={column.name}
              onDragOver={(e) => dnd.over(e, column.id, null)}
              onDragLeave={dnd.leave}
              onDrop={(e) => dnd.drop(e, column.id, colIndex)}
              className={`rounded-lg border ${active ? "border-orange-400/50 bg-orange-500/[0.05]" : "border-rule bg-panel"}`}
            >
              <ColumnHeader column={column} count={items.length} view="list" collapsed={isCollapsed} className="px-3 py-2" />
              {!isCollapsed && (
                <div className="flex flex-col gap-px px-1.5 pb-1.5">
                  {items.length === 0 && <div className="px-3 py-2 text-xs text-engrave">{query ? t.noMatch : t.emptyColumn}</div>}
                  {items.map((item, i) => (
                    <Fragment key={item.key}>
                      {dnd.spot?.columnId === column.id && dnd.spot.beforeKey === item.key && <DropLine />}
                      <div
                        draggable
                        onDragStart={(e) => startSongDrag(e, item.key)}
                        onDragOver={(e) => dnd.over(e, column.id, query ? null : beforeKeyFor(e, items, i))}
                        onClick={item.open}
                        className={`${ROW} group/card cursor-grab rounded px-3 py-1.5 text-sm active:cursor-grabbing ${
                          item.selected ? "bg-raised ring-1 ring-orange-400/40" : "hover:bg-raised"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <CardTitle item={item} />
                          <ConflictDot on={item.conflict} />
                          <MoveMenu item={item} />
                        </span>
                        <span className="text-xs text-engrave">
                          <span className="sr-only">{t.saved}: </span>
                          {item.savedMs ? formatRelative(item.savedMs) : "—"}
                        </span>
                        <span className="font-mono text-xs text-body">
                          <span className="sr-only">{t.bpm}: </span>
                          {formatBpm(item.bpm)}
                        </span>
                        <span className="font-mono text-xs text-body">
                          <span className="sr-only">{t.key}: </span>
                          {item.musicalKey || "—"}
                        </span>
                        <span className="truncate text-xs text-engrave">
                          {item.tags.length > 0 && <span className="sr-only">{t.tags}: </span>}
                          {item.tags.map((tag) => `#${tag}`).join(" ")}
                        </span>
                        <span className="flex justify-end truncate text-xs text-body">{item.extra}</span>
                      </div>
                    </Fragment>
                  ))}
                  {dnd.spot?.columnId === column.id && dnd.spot.beforeKey === null && items.length > 0 && <DropLine />}
                </div>
              )}
            </section>
          );
        })}
        <AddColumn compact />
      </div>
    </div>
  );
}
