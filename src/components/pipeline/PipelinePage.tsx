import type { ReactNode } from "react";
import { Columns3, List, Search, Table2, X } from "lucide-react";
import { usePipelineView, type PipelineViewKind } from "../../store/usePipelineView";
import { PipelineBoard } from "./PipelineBoard";
import { PipelineList } from "./PipelineList";
import { PipelineTable } from "./PipelineTable";
import { PipelineSourceProvider, T_PIPELINE, type PipelineSource } from "./shared";
import { tr } from "../../i18n";

// A pipeline page: title, search, Board / List / Table, over a source. Your
// Pipeline and the crew board are the same page with different sources.

const VIEWS: { id: PipelineViewKind; icon: typeof List }[] = [
  { id: "board", icon: Columns3 },
  { id: "list", icon: List },
  { id: "table", icon: Table2 },
];

export function PipelinePage({ title, sub, source, empty }: { title: string; sub?: ReactNode; source: PipelineSource; empty?: ReactNode }) {
  const view = usePipelineView((s) => s.view[source.scope]);
  const setView = usePipelineView((s) => s.setView);
  const setQuery = usePipelineView((s) => s.setQuery);
  const t = tr(T_PIPELINE);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-6 py-3">
        <div className="mr-auto">
          <h1 className="font-display text-3xl uppercase leading-none tracking-tight text-cream">{title}</h1>
          {sub && <p className="mt-1 text-xs text-engrave">{sub}</p>}
        </div>
        <label className="flex items-center gap-1.5 rounded-md border border-rule bg-chassis px-2 py-1 text-xs focus-within:border-hot">
          <Search size={12} className="text-engrave" aria-hidden />
          <input
            value={source.query}
            onChange={(e) => setQuery(source.scope, e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery(source.scope, "")}
            placeholder={t.filterPlaceholder}
            aria-label={t.filterLabel}
            className="w-44 bg-transparent text-cream placeholder:text-engrave focus:outline-none"
          />
          {source.query && (
            <button type="button" onClick={() => setQuery(source.scope, "")} aria-label={t.clearFilter} className="rounded text-engrave hover:text-cream">
              <X size={12} />
            </button>
          )}
        </label>
        <div className="flex rounded-md border border-rule p-0.5 text-xs" role="tablist" aria-label={t.viewLabel}>
          {VIEWS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(source.scope, id)}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 ${view === id ? "bg-rule-strong text-cream" : "text-engrave hover:text-cream"}`}
            >
              <Icon size={12} aria-hidden /> {t[id]}
            </button>
          ))}
        </div>
      </div>
      {source.scoped && (
        <div className="flex items-center gap-1.5 border-b border-rule px-6 py-1.5 text-xs text-engrave">
          <span className="text-cream">{source.scoped.label}</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={source.scoped.clear} className="underline hover:text-cream">
            {t.showAll}
          </button>
        </div>
      )}
      {source.query && (
        <div className="flex items-center gap-1.5 border-b border-rule px-6 py-1.5 text-xs text-engrave">
          <span>{t.matching(source.shown, source.total)}</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={() => setQuery(source.scope, "")} className="underline hover:text-cream">
            {t.clear}
          </button>
        </div>
      )}
      <PipelineSourceProvider value={source}>
        {empty ?? (view === "list" ? <PipelineList /> : view === "table" ? <PipelineTable /> : <PipelineBoard />)}
      </PipelineSourceProvider>
    </div>
  );
}
