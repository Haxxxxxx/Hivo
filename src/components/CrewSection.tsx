import { Disc3, KanbanSquare, Settings2, UserPlus } from "lucide-react";
import { useAppStore, type View } from "../store/useAppStore";
import { useCrewStore, useInCrew } from "../store/useCrewStore";
import { engrave } from "../ui";
import { StatusDot } from "./ui";
import { LeaveCrewButton } from "./CrewPanel";
import { T_CREW_PAGES, useIsCrewOwner } from "./CrewViews";
import { dict, tr } from "../i18n";

const T = dict(
  { activeCrew: "Active crew", syncProblem: "Sync problem", synced: "Synced", notSynced: "Not synced yet" },
  { activeCrew: "Crew actif", syncProblem: "Problème de synchro", synced: "Synchronisé", notSynced: "Pas encore synchronisé" },
);

// The crew's own part of the menu, under the main one: everything about the
// crew interface lives here. The owner manages (members, invites, settings);
// members get the board and a way out. Hidden when you're not in a crew.

export function CrewSection() {
  const inCrew = useInCrew();
  const owner = useIsCrewOwner();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const crews = useCrewStore((s) => s.crews);
  const activeCrewId = useCrewStore((s) => s.activeCrewId);
  const selectCrew = useCrewStore((s) => s.selectCrew);
  const sync = useCrewStore((s) => s.sync.kind);
  if (!inCrew) return null;
  const active = crews.find((c) => c.id === activeCrewId)!;
  const light = sync === "error" ? "var(--color-missing)" : sync === "synced" ? "var(--color-ok)" : "var(--color-engrave)";

  const t = tr(T);
  const pages = tr(T_CREW_PAGES);

  const items: { id: View; label: string; icon: typeof KanbanSquare }[] = [
    { id: "crewBoard", label: pages.board, icon: KanbanSquare },
    { id: "crewReleases", label: pages.releases, icon: Disc3 },
    ...(owner
      ? [
          { id: "crewMembers" as const, label: pages.members, icon: UserPlus },
          { id: "crewSettings" as const, label: pages.settings, icon: Settings2 },
        ]
      : []),
  ];

  return (
    <section aria-label="Crew" className="mx-2 mt-3 border-t-2 border-rule-strong pt-3">
      <div className="flex items-center gap-2 px-3 pb-2">
        <span className={`${engrave} shrink-0`}>Crew</span>
        {crews.length > 1 ? (
          <select
            value={active.id}
            onChange={(e) => void selectCrew(e.target.value)}
            aria-label={t.activeCrew}
            className="min-w-0 flex-1 truncate rounded border border-rule bg-chassis px-1.5 py-0.5 text-xs text-cream"
          >
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-cream">{active.name}</span>
        )}
        <span title={sync === "error" ? t.syncProblem : sync === "synced" ? t.synced : t.notSynced}>
          <StatusDot color={light} size={7} label={sync === "error" ? t.syncProblem : sync === "synced" ? t.synced : t.notSynced} />
        </span>
      </div>
      <nav aria-label="Crew" className="flex flex-col gap-0.5">
        {items.map(({ id, label, icon: Icon }) => {
          const on = view === id;
          return (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                on ? "bg-cream font-medium text-chassis" : "text-body hover:bg-raised hover:text-cream"
              }`}
            >
              <Icon size={16} strokeWidth={2} /> {label}
            </button>
          );
        })}
      </nav>
      {!owner && (
        <div className="px-3 pt-1.5">
          <LeaveCrewButton className="text-xs text-engrave hover:text-cream" />
        </div>
      )}
    </section>
  );
}
