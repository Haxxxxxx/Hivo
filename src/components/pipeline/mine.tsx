import { useMemo } from "react";
import { useAppStore } from "../../store/useAppStore";
import { usePipelineView } from "../../store/usePipelineView";
import { canRemoveColumn, crewMovedAway, filterSongs, groupSongs, resolvePipeline } from "../../lib/pipeline";
import { formatRelative } from "../../lib/format";
import { albumsOf, formatBpm, lastSaveMs } from "../../lib/songs";
import type { ProjectInfo, Workspace } from "../../types";
import { useVisibleSongs } from "../LibraryView";
import { MixdownBadge } from "../../ui";
import type { PipelineItem, PipelineSource } from "./shared";

// Your pipeline: your songs and your columns (workspace.json).

function Card({ song, workspace }: { song: ProjectInfo; workspace: Workspace }) {
  const albums = albumsOf(workspace, song.path);
  const tags = workspace.songs[song.path]?.tags ?? [];
  return (
    <>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-engrave">
        <span>{formatRelative(lastSaveMs(song))}</span>
        {song.tempoBpm && <span>· {formatBpm(song.tempoBpm)} BPM</span>}
      </div>
      {(albums.length > 0 || tags.length > 0 || song.renders.length > 0) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {albums.map((a) => (
            <span key={a.id} title={a.title} className="h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />
          ))}
          <span className="min-w-0 flex-1 truncate text-[11px] text-engrave">{tags.map((t) => `#${t}`).join(" ")}</span>
          {song.renders.length > 0 && <MixdownBadge project={song} compact />}
        </div>
      )}
    </>
  );
}

export function useMineSource(): PipelineSource {
  const songs = useVisibleSongs();
  const workspace = useAppStore((s) => s.workspace);
  const detailPath = useAppStore((s) => s.detailPath);
  const openDetail = useAppStore((s) => s.openDetail);
  const openNewProject = useAppStore((s) => s.openNewProject);
  const rename = useAppStore((s) => s.renamePipelineColumn);
  const add = useAppStore((s) => s.addPipelineColumn);
  const remove = useAppStore((s) => s.removePipelineColumn);
  const moveColumn = useAppStore((s) => s.movePipelineColumn);
  const moveCard = useAppStore((s) => s.movePipelineCard);
  const query = usePipelineView((s) => s.query.mine);

  return useMemo(() => {
    const cfg = resolvePipeline(workspace);
    const item = (song: ProjectInfo): PipelineItem => {
      const meta = workspace.songs[song.path];
      return {
        key: song.path,
        title: song.name,
        savedMs: lastSaveMs(song),
        bpm: song.tempoBpm,
        musicalKey: meta?.key ?? "",
        tags: meta?.tags ?? [],
        conflict: !!meta?.stageConflict,
        card: <Card song={song} workspace={workspace} />,
        extra: song.renders.length > 0 ? <MixdownBadge project={song} compact /> : null,
        open: () => openDetail(detailPath === song.path ? null : song.path),
        selected: detailPath === song.path,
      };
    };
    const shown = filterSongs(songs, workspace, query);
    return {
      scope: "mine",
      query,
      total: songs.length,
      shown: shown.length,
      editable: true,
      groups: groupSongs(shown, workspace, cfg).map((g) => ({
        column: g.column,
        // crewMovedAway needs the column the card actually sits in, which the
        // item builder doesn't see.
        items: g.songs.map((s) => ({ ...item(s), crewMoved: crewMovedAway(workspace.songs[s.path], g.column) })),
      })),
      canRemove: (id) => canRemoveColumn(cfg, id),
      rename,
      add,
      remove,
      moveColumn,
      // The board's full song list, so hidden (filtered) songs keep their order.
      moveCard: (key, columnId, beforeKey) => moveCard(songs, key, columnId, beforeKey),
      newSong: () => openNewProject({ status: "creation" }),
    } satisfies PipelineSource;
  }, [songs, workspace, query, detailPath, openDetail, openNewProject, rename, add, remove, moveColumn, moveCard]);
}
