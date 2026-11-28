import { createContext, useContext, type ReactNode } from "react";
import type { PipelineScope } from "../../store/usePipelineView";
import type { PipelineColumn, SongStatus } from "../../types";

// The pipeline source: what a page hands its board, list and table.
//
// This lives apart from `shared.tsx` ON PURPOSE. A module that exports
// components alongside anything else is not eligible for React Fast
// Refresh, so every edit to any component in that file invalidated the
// whole module and ran `createContext` again. The provider went on
// publishing to the old context object while its children read the new
// one, `useContext` came back null, and the pipeline threw
// "pipeline views need a PipelineSourceProvider" — a black screen in dev,
// from an edit that had nothing to do with the context.
//
// Nothing here renders, so a component edit never invalidates it and the
// context object outlives any number of refreshes. Keep it that way: no
// components in this file.

export interface PipelineItem {
  /** Your song's .flp path, or the crew song's id. */
  key: string;
  title: string;
  /** Last save, ms (0 = unknown). */
  savedMs: number;
  bpm: number | null;
  musicalKey: string;
  tags: string[];
  /** A crewmate moved it while your move was waiting. */
  conflict?: boolean;
  /** The board card's body (under the title). */
  card: ReactNode;
  /** The list row's last cell (mixdown badge, who). */
  extra?: ReactNode;
  open?: () => void;
  selected?: boolean;
}

export interface PipelineGroup {
  column: PipelineColumn;
  items: PipelineItem[];
}

export interface PipelineSource {
  scope: PipelineScope;
  groups: PipelineGroup[];
  query: string;
  /** Songs on the pipeline, and how many the query lets through. */
  total: number;
  shown: number;
  /** Columns can be renamed, added, removed, reordered here. */
  editable: boolean;
  canRemove: (columnId: string) => boolean;
  rename: (columnId: string, name: string) => void;
  add: (name: string, stage: SongStatus | null) => void;
  remove: (columnId: string) => void;
  /** Separate pipelines. Absent on the crew board, whose columns live on
   * the server and are shared by the whole crew. */
  boards?: {
    active: string;
    list: { id: string; name: string }[];
    setActive: (id: string) => void;
    add: (name: string) => void;
    rename: (id: string, name: string) => void;
    remove: (id: string) => void;
  };
  /** Absent where columns aren't the user's to colour (the crew board:
   * its columns live on the server and have no colour yet). */
  recolor?: (columnId: string, color: string | null) => void;
  moveColumn: (columnId: string, toIndex: number) => void;
  /** Put a song in a column, before another (or at the end). */
  moveCard: (key: string, columnId: string, beforeKey: string | null) => void;
  /** "New song" on the Creation column (your pipeline only). */
  newSong?: () => void;
  /** A filter set from elsewhere (the crew board scoped to one member):
   * what it shows, and how to lift it. */
  scoped?: { label: string; clear: () => void } | null;
  /** Shown above the views (a refused move, a failed save). */
  error?: string | null;
  clearError?: () => void;
}

const SourceContext = createContext<PipelineSource | null>(null);
export const PipelineSourceProvider = SourceContext.Provider;
export function useSource(): PipelineSource {
  const s = useContext(SourceContext);
  if (!s) throw new Error("pipeline views need a PipelineSourceProvider");
  return s;
}
