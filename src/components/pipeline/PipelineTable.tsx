import { useMemo } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useCollapsed, usePipelineView } from "../../store/usePipelineView";
import { sortBy, stageColor, stageLabel, type SortKey } from "../../lib/pipeline";
import { formatRelative } from "../../lib/format";
import { formatBpm } from "../../lib/songs";
import { StatusDot } from "../ui";
import { CardTitle, ConflictDot, SourceError, T_PIPELINE, useSource, type PipelineItem } from "./shared";
import type { PipelineColumn } from "../../types";
import { tr } from "../../i18n";

const HEADERS: { key: SortKey; label: "song" | "column" | "saved" | "bpm" | "key"; className?: string }[] = [
  { key: "name", label: "song" },
  { key: "column", label: "column" },
  { key: "saved", label: "saved" },
  { key: "bpm", label: "bpm", className: "text-right" },
  { key: "key", label: "key" },
];

type Row = { item: PipelineItem; column: PipelineColumn; boardIndex: number };

/** One flat, sortable table over the same rows as the list. Its sort and
 * hidden columns are its own: they never reorder the board. Read-only: click
 * a row to open the song. */
export function PipelineTable() {
  const source = useSource();
  const { groups, query, scope } = source;
  const { key, dir } = usePipelineView((s) => s.tableSort[scope]);
  const setTableSort = usePipelineView((s) => s.setTableSort);
  const hidden = useCollapsed(scope, "table");
  const toggleCollapsed = usePipelineView((s) => s.toggleCollapsed);

  const rows = useMemo(() => {
    let i = 0;
    const flat: Row[] = groups
      .filter((g) => !hidden.includes(g.column.id))
      .flatMap((g) => g.items.map((item) => ({ item, column: g.column, boardIndex: i++ })));
    return sortBy(flat, (r) => ({ name: r.item.title, saved: r.item.savedMs, bpm: r.item.bpm, key: r.item.musicalKey, boardIndex: r.boardIndex }), key, dir);
  }, [groups, hidden, key, dir]);
  const t = tr(T_PIPELINE);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <SourceError />
      <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-6 py-2" role="group" aria-label={t.columnsShown}>
        <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.14em] text-engrave">{t.show}</span>
        {groups.map(({ column, items }) => {
          const on = !hidden.includes(column.id);
          return (
            <button
              key={column.id}
              aria-pressed={on}
              onClick={() => toggleCollapsed(scope, "table", column.id)}
              className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${on ? "border-rule-strong text-cream" : "border-rule text-engrave line-through"}`}
            >
              <StatusDot color={stageColor(column.stage)} size={6} glow={false} /> {column.name} <span className="text-engrave">{items.length}</span>
            </button>
          );
        })}
        {key !== "board" && (
          <button onClick={() => setTableSort(scope, "board")} className="ml-auto text-xs text-engrave underline hover:text-cream">
            {t.boardOrder}
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto px-6 pb-4">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-chassis">
            <tr>
              {HEADERS.map((h) => (
                <th
                  key={h.key}
                  scope="col"
                  aria-sort={key === h.key ? (dir === 1 ? "ascending" : "descending") : "none"}
                  className={`border-b border-rule px-2 py-2 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-engrave ${h.className ?? "text-left"}`}
                >
                  <button onClick={() => setTableSort(scope, h.key)} className="inline-flex items-center gap-1 uppercase hover:text-cream">
                    {t[h.label]}
                    {key === h.key && (dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>
                </th>
              ))}
              <th scope="col" className="border-b border-rule px-2 py-2 text-left font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-engrave">
                {t.tags}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-xs text-engrave">
                  {query ? t.noMatch : t.noSongs}
                </td>
              </tr>
            )}
            {rows.map(({ item, column }) => (
              <tr
                key={item.key}
                onClick={item.open}
                className={`border-b border-rule ${item.open ? "cursor-pointer" : ""} ${item.selected ? "bg-raised" : "hover:bg-panel"}`}
              >
                <td className="px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <CardTitle item={item} />
                    <ConflictDot on={item.conflict} />
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs text-body" title={t.stageOf(stageLabel(column.stage))}>
                    <StatusDot color={stageColor(column.stage)} size={6} glow={false} /> {column.name}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-xs text-engrave">{item.savedMs ? formatRelative(item.savedMs) : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-body">{formatBpm(item.bpm)}</td>
                <td className="px-2 py-1.5 font-mono text-xs text-body">{item.musicalKey || "—"}</td>
                <td className="max-w-[14rem] truncate px-2 py-1.5 text-xs text-engrave">{item.tags.map((tag) => `#${tag}`).join(" ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
