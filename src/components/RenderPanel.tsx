import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle, Clock, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { dict, tr } from "../i18n";

const T = dict(
  {
    exporting: "Exporting projects...",
    complete: "Export complete",
    hideWhileRendering: "Hide (the render goes on)",
    stuckHint: "FL Studio stuck? Quit it: Hivo gives up on a render after 15 minutes.",
    finishedErrors: (n: number) => `Finished with ${n} error${n === 1 ? "" : "s"}`,
    summary: (done: number, failed: number) => `${done} done${failed > 0 ? `, ${failed} failed` : ""}`,
  },
  {
    exporting: "Export des projets...",
    complete: "Export terminé",
    hideWhileRendering: "Masquer (le rendu continue)",
    stuckHint: "FL Studio bloqué ? Quitte-le : Hivo abandonne un rendu au bout de 15 minutes.",
    finishedErrors: (n: number) => `Terminé avec ${n} erreur${n === 1 ? "" : "s"}`,
    summary: (done: number, failed: number) =>
      `${done} terminé${done > 1 ? "s" : ""}${failed > 0 ? `, ${failed} en échec` : ""}`,
  },
);

export function RenderPanel() {
  const renderJobs = useAppStore((s) => s.renderJobs);
  const rendering = useAppStore((s) => s.rendering);
  const dismiss = useAppStore((s) => s.dismissRenderPanel);
  // After a minute of rendering, the panel can be hidden and says what to do if FL is stuck.
  const [hideable, setHideable] = useState(false);
  useEffect(() => {
    if (!rendering) return setHideable(false);
    const id = setTimeout(() => setHideable(true), 60_000);
    return () => clearTimeout(id);
  }, [rendering]);

  if (renderJobs.size === 0) return null;

  const entries = Array.from(renderJobs.entries());
  const done = entries.filter(([, j]) => j.status === "done").length;
  const errored = entries.filter(([, j]) => j.status === "error").length;

  return (
    <div className="w-80 rounded-lg border border-rule bg-raised shadow-2xl">
      <div className="flex items-center justify-between border-b border-rule px-4 py-3">
        <div className="text-sm font-medium text-cream">
          {rendering ? tr(T).exporting : errored > 0 ? tr(T).finishedErrors(errored) : tr(T).complete}
        </div>
        {(!rendering || hideable) && (
          <button
            onClick={dismiss}
            title={rendering ? tr(T).hideWhileRendering : undefined}
            className="rounded p-1 text-engrave hover:bg-rule hover:text-cream"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="max-h-64 overflow-auto px-2 py-2">
        {entries.map(([path, job]) => (
          <div key={path} className="flex items-center gap-2 px-2 py-1.5 text-xs">
            {job.status === "queued" && <Clock size={13} className="shrink-0 text-engrave" />}
            {job.status === "rendering" && (
              <Loader2 size={13} className="shrink-0 animate-spin text-orange-400" />
            )}
            {job.status === "done" && (
              <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
            )}
            {job.status === "error" && (
              <XCircle size={13} className="shrink-0 text-red-400" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-body">{path.split(/[/\\]/).pop()}</div>
              {job.status === "error" && job.message && (
                <div className="truncate text-[11px] text-red-300/80" title={job.message}>{job.message}</div>
              )}
              {/* Rendered with a warning (samples that weren't found). */}
              {job.status === "done" && job.message && (
                <div className="truncate text-[11px] text-amber-300/80" title={job.message}>{job.message}</div>
              )}
            </div>
          </div>
        ))}
      </div>
      {!rendering && (
        <div className="border-t border-rule px-4 py-2 text-[11px] text-engrave">
          {tr(T).summary(done, errored)}
        </div>
      )}
      {rendering && hideable && <div className="border-t border-rule px-4 py-2 text-[11px] text-engrave">{tr(T).stuckHint}</div>}
    </div>
  );
}
