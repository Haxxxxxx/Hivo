import { Fragment } from "react";
import { ChevronRight } from "lucide-react";
import { useCollapsed, usePipelineView } from "../../store/usePipelineView";
import { stageColor } from "../../lib/pipeline";
import { StatusDot } from "../ui";
import { AddColumn, beforeKeyFor, CardTitle, ColumnHeader, ConflictDot, DropLine, MoveMenu, SourceError, startSongDrag, T_PIPELINE, usePipelineDrop, useSource } from "./shared";
import { tr } from "../../i18n";

/** Kanban: one column per pipeline column. Drag cards between and within
 * columns; where columns are editable, drag a header to reorder them. */
export function PipelineBoard() {
  const source = useSource();
  const { groups, query, scope } = source;
  const collapsed = useCollapsed(scope, "board");
  const toggleCollapsed = usePipelineView((s) => s.toggleCollapsed);
  const dnd = usePipelineDrop();

  // Nothing on the pipeline at all: one line instead of six empty columns,
  // but columns stay editable (AddColumn renders nothing where they aren't).
  if (source.total === 0 && !query) {
    return (
      <>
        <SourceError />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-sm text-engrave">
          <span>{scope === "crew" ? tr(T_PIPELINE).emptyCrew : tr(T_PIPELINE).emptyMine}</span>
          <AddColumn compact />
        </div>
      </>
    );
  }

  return (
    <>
      <SourceError />
      <div className="flex flex-1 gap-3 overflow-x-auto p-4" onDragEnd={dnd.end}>
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
              className={`flex flex-col rounded-lg border ${isCollapsed ? "w-11 shrink-0" : "min-w-[190px] flex-1 basis-0"} ${
                active ? "border-orange-400/50 bg-orange-500/[0.05]" : "border-rule bg-panel"
              }`}
            >
              {isCollapsed ? (
                <button
                  onClick={() => toggleCollapsed(scope, "board", column.id)}
                  aria-label={tr(T_PIPELINE).expand(column.name)}
                  aria-expanded={false}
                  className="flex flex-1 flex-col items-center gap-2 py-2.5 text-engrave hover:text-cream"
                >
                  <ChevronRight size={13} />
                  <StatusDot color={stageColor(column.stage)} />
                  <span className="text-xs text-cream [writing-mode:vertical-rl]">{column.name}</span>
                  <span className="text-xs">{items.length}</span>
                </button>
              ) : (
                <>
                  <ColumnHeader column={column} count={items.length} view="board" collapsed={false} className="px-2.5 pb-2 pt-2.5" />
                  <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
                    {items.map((item, i) => (
                      <Fragment key={item.key}>
                        {dnd.spot?.columnId === column.id && dnd.spot.beforeKey === item.key && <DropLine />}
                        <div onDragOver={(e) => dnd.over(e, column.id, query ? null : beforeKeyFor(e, items, i))}>
                          {/* The card is a mouse target; the title button and the
                              move menu are its keyboard controls. */}
                          <div
                            draggable
                            onDragStart={(e) => startSongDrag(e, item.key)}
                            onClick={item.open}
                            className={`group/card cursor-grab rounded-md border px-3 py-2 active:cursor-grabbing ${
                              item.selected ? "border-orange-400/40 bg-raised" : "border-rule bg-raised hover:border-rule-strong"
                            }`}
                          >
                            <div className="flex items-center gap-1.5">
                              <CardTitle item={item} className="text-sm" />
                              <ConflictDot on={item.conflict} />
                              <span className="ml-auto" />
                              <MoveMenu item={item} />
                            </div>
                            {item.card}
                          </div>
                        </div>
                      </Fragment>
                    ))}
                    {dnd.spot?.columnId === column.id && dnd.spot.beforeKey === null && items.length > 0 && <DropLine />}
                  </div>
                </>
              )}
            </section>
          );
        })}
        <AddColumn />
      </div>
    </>
  );
}
