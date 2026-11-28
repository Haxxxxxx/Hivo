import { useMemo } from "react";
import { useAppStore } from "../../store/useAppStore";
import { usePipelineView } from "../../store/usePipelineView";
import { boardOfSong, canRemoveColumn, filterSongs, groupSongs, resolveBoards, resolvePipeline } from "../../lib/pipeline";
import { formatRelative } from "../../lib/format";
import { albumsOf, formatBpm, lastSaveMs } from "../../lib/songs";
import type { ProjectInfo, Workspace } from "../../types";
import { useVisibleSongs } from "../LibraryView";
import { MixdownBadge } from "../../ui";
import type { PipelineItem, PipelineSource } from "./source";

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
  const recolor = useAppStore((s) => s.recolorPipelineColumn);
  const moveColumn = useAppStore((s) => s.movePipelineColumn);
  const moveCard = useAppStore((s) => s.movePipelineCard);
  const moveCardFromBoard = useAppStore((s) => s.movePipelineCardFromBoard);
  const setActiveBoardAction = useAppStore((s) => s.setActivePipelineBoard);
  const addBoardAction = useAppStore((s) => s.addPipelineBoard);
  const renameBoardAction = useAppStore((s) => s.renamePipelineBoard);
  const removeBoardAction = useAppStore((s) => s.removePipelineBoard);
  const moveSongToBoardAction = useAppStore((s) => s.moveSongToPipelineBoard);
  const query = usePipelineView((s) => s.query.mine);

  return useMemo(() => {
    const cfg = resolvePipeline(workspace);
    // Each pipeline shows only its own songs. Anything from before
    // pipelines existed has no board and belongs to the first one, so it
    // stays visible instead of disappearing on upgrade.
    const { active, boards } = resolveBoards(workspace);
    const onThisBoard = songs.filter((s) => boardOfSong(workspace.songs[s.path], boards) === active);
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
    const shown = filterSongs(onThisBoard, workspace, query);
    return {
      scope: "mine",
      query,
      total: onThisBoard.length,
      shown: shown.length,
      libraryTotal: songs.length,
      editable: true,
      groups: groupSongs(shown, workspace, cfg).map((g) => ({ column: g.column, items: g.songs.map(item) })),
      boards: { active, list: boards.map((b) => ({ id: b.id, name: b.name })), setActive: setActiveBoardAction, add: addBoardAction, rename: renameBoardAction, remove: removeBoardAction },
      moveToBoard: moveSongToBoardAction,
      canRemove: (id) => canRemoveColumn(cfg, id),
      rename,
      add,
      remove,
      recolor,
      moveColumn,
      // This pipeline's full song list, so hidden (filtered) songs keep
      // their order and a move never reorders another board.
      moveCard: (key, columnId, beforeKey) => {
        // A song already here moves within this pipeline. One still on the
        // pipeline you dragged it from — the tab sprang open mid-drag —
        // joins this one and lands where you dropped it. Its own row has
        // to be in the list, or the placement has nothing to order it in.
        if (onThisBoard.some((s) => s.path === key)) return moveCard(onThisBoard, key, columnId, beforeKey);
        const song = songs.find((s) => s.path === key);
        if (song) moveCardFromBoard([...onThisBoard, song], key, columnId, beforeKey);
      },
      newSong: () => openNewProject({ status: "creation" }),
    } satisfies PipelineSource;
  }, [songs, workspace, query, detailPath, openDetail, openNewProject, rename, add, remove, moveColumn, moveCard, setActiveBoardAction, addBoardAction, renameBoardAction, removeBoardAction, moveSongToBoardAction, moveCardFromBoard, recolor]);
}
