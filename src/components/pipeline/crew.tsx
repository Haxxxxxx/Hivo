import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Disc3 } from "lucide-react";
import { useCrewStore } from "../../store/useCrewStore";
import { useAppStore } from "../../store/useAppStore";
import { usePipelineView } from "../../store/usePipelineView";
import { crewEdits, crewPipeline, groupCrewSongs } from "../../lib/crewBoard";
import { crewCreditsText, crewMixdown, nameOf, pathsByShareId } from "../../lib/crewSync";
import { songsOfMember } from "../../lib/crewStats";
import { formatRelative } from "../../lib/format";
import type { CrewSongRow, PipelineConfig } from "../../types";
import { T_PIPELINE, type PipelineItem, type PipelineSource } from "./shared";
import { tr } from "../../i18n";

// The crew's pipeline: every song the crew shares, in the crew's columns
// (crew_columns on the server, the same on the website). The owner edits
// the columns; anyone moves cards.

const newUuid = () => crypto.randomUUID();

function matches(s: CrewSongRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [s.title, s.musical_key ?? "", ...s.tags.map((t) => `#${t}`)].join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export function useCrewSource(): PipelineSource {
  const songs = useCrewStore((s) => s.songs);
  const columns = useCrewStore((s) => s.columns);
  const members = useCrewStore((s) => s.members);
  const knownNames = useCrewStore((s) => s.knownNames);
  const userId = useCrewStore((s) => s.userId);
  const owner = useCrewStore((s) => s.crews.find((c) => c.id === s.activeCrewId)?.role === "owner");
  const saveCrewColumns = useCrewStore((s) => s.saveCrewColumns);
  const moveCrewCard = useCrewStore((s) => s.moveCrewCard);
  const workspace = useAppStore((s) => s.workspace);
  const openDetail = useAppStore((s) => s.openDetail);
  const query = usePipelineView((s) => s.query.crew);
  const member = usePipelineView((s) => s.crewMember);
  const setCrewMember = usePipelineView((s) => s.setCrewMember);
  const [error, setError] = useState<string | null>(null);
  const activeCrewId = useCrewStore((s) => s.activeCrewId);
  // A refused move in one crew isn't news in another.
  useEffect(() => setError(null), [activeCrewId]);

  return useMemo(() => {
    const { cfg } = crewPipeline(columns);
    // Current members first, else the last name seen here (a former member).
    const name = (id: string | null | undefined) => nameOf(id, members, knownNames);
    const localPath = pathsByShareId(workspace);
    const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
    const save = (next: PipelineConfig) => {
      setError(null);
      saveCrewColumns(next).catch(fail);
    };
    const t = tr(T_PIPELINE);
    const item = (s: CrewSongRow): PipelineItem => {
      const mine = s.owner_id === userId;
      const path = mine ? localPath.get(s.id) : undefined;
      const who = mine ? t.you : (name(s.owner_id) ?? t.crewmate);
      const mix = crewMixdown(s);
      const credits = crewCreditsText(s.credits);
      return {
        key: s.id,
        title: s.title,
        savedMs: s.last_saved_at ? Date.parse(s.last_saved_at) : 0,
        bpm: s.bpm,
        musicalKey: s.musical_key ?? "",
        tags: s.tags,
        card: (
          <>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-body">
              <span className={mine ? "text-orange-200/80" : ""}>{who}</span>
              {s.bpm != null && <span>· {Math.round(s.bpm)} BPM</span>}
              {s.musical_key && <span>· {s.musical_key}</span>}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-engrave">
              {s.last_saved_at && <span>{t.savedAgo(formatRelative(Date.parse(s.last_saved_at)))}</span>}
              {s.release_date && <span>{t.out(s.release_date)}</span>}
              <span className="ml-auto flex items-center gap-1">
                {mix !== "none" && (
                  <Disc3
                    size={10}
                    className={mix === "stale" ? "text-warn" : undefined}
                    aria-label={mix === "fresh" ? t.mixdownFresh : mix === "stale" ? t.mixdownStale : t.hasMixdown}
                  >
                    <title>{mix === "fresh" ? t.mixdownFresh : mix === "stale" ? t.mixdownStale : t.hasMixdown}</title>
                  </Disc3>
                )}
                {s.kit_accepted && <CheckCircle2 size={10} className="text-emerald-300/80" aria-label={t.kitAccepted} />}
              </span>
            </div>
            {s.stage_updated_by && s.stage_updated_by !== s.owner_id && (
              <div className="mt-1 text-[10px] text-engrave">{t.movedBy(s.stage_updated_by === userId ? t.youLower : (name(s.stage_updated_by) ?? t.aCrewmate))}</div>
            )}
            {credits && (
              <div className="mt-1 truncate text-[10px] text-engrave" title={credits}>
                {t.credits}: {credits}
              </div>
            )}
          </>
        ),
        extra: <span className={mine ? "text-orange-200/80" : ""}>{who}</span>,
        open: path ? () => openDetail(path) : undefined,
      };
    };
    // A member of another crew (after switching crews) scopes nothing.
    const scopedTo = member && members.some((m) => m.user_id === member) ? member : null;
    const mineOnly = songsOfMember(songs, scopedTo);
    const shown = mineOnly.filter((s) => matches(s, query));
    return {
      scope: "crew",
      query,
      total: songs.length,
      shown: shown.length,
      editable: owner,
      scoped: scopedTo ? { label: scopedTo === userId ? t.onlyYours : t.onlyOf(name(scopedTo) ?? t.crewmate), clear: () => setCrewMember(null) } : null,
      error,
      clearError: () => setError(null),
      groups: groupCrewSongs(shown, cfg).map((g) => ({ column: g.column, items: g.songs.map(item) })),
      canRemove: (id) => crewEdits.canRemove(cfg, id),
      rename: (id, name) => save(crewEdits.rename(cfg, id, name)),
      add: (name, stage) => save(crewEdits.add(cfg, name, stage, newUuid())),
      remove: (id) => save(crewEdits.remove(cfg, id)),
      moveColumn: (id, toIndex) => save(crewEdits.move(cfg, id, toIndex)),
      moveCard: (key, columnId, beforeKey) => {
        setError(null);
        moveCrewCard(key, columnId, beforeKey).catch(fail);
      },
    } satisfies PipelineSource;
  }, [songs, columns, members, knownNames, userId, owner, workspace, query, member, setCrewMember, error, saveCrewColumns, moveCrewCard, openDetail]);
}
