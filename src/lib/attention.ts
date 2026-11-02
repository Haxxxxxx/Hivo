import type { ProjectInfo, SongStatus, Workspace } from "../types";
import { dict, plural, tr } from "../i18n";
import { isFinished, missingPlugins, missingSamples, renderFreshness } from "./songs";

// The dashboard's "Needs attention" carousel: songs with something to fix,
// and why. Stalled songs live on the crew cards, not here.

export type AttentionKind = "stale-mixdown" | "no-mixdown" | "missing-samples" | "missing-plugins";

export interface AttentionReason {
  kind: AttentionKind;
  text: string;
}

export interface AttentionItem {
  song: ProjectInfo;
  status: SongStatus | undefined;
  reasons: AttentionReason[];
  /** Last save of the project (or its newest mixdown). */
  lastActivityMs: number;
}

const T = dict(
  {
    noMixdown: "Finished, but no mixdown yet",
    staleMixdown: "Mixdown is older than the project",
    missingSamples: (n: number) => `${n} sample${plural(n, "", "s")} missing`,
    missingPlugins: (n: number) => `${n} plugin${plural(n, "", "s")} not installed here`,
  },
  {
    noMixdown: "Fini, mais pas encore de mixdown",
    staleMixdown: "Le mixdown est plus vieux que le projet",
    missingSamples: (n: number) => `${n} sample${plural(n, "", "s")} manquant${plural(n, "", "s")}`,
    missingPlugins: (n: number) => `${n} plugin${plural(n, "", "s")} pas installé${plural(n, "", "s")} ici`,
  },
);

/** Why a song needs attention, most urgent first; empty if it doesn't. */
export function attentionReasons(song: ProjectInfo, status: SongStatus | undefined): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  const freshness = renderFreshness(song);
  if (isFinished(status) && freshness === "none") reasons.push({ kind: "no-mixdown", text: tr(T).noMixdown });
  if (freshness === "stale") reasons.push({ kind: "stale-mixdown", text: tr(T).staleMixdown });
  const samples = missingSamples(song).length;
  if (samples) reasons.push({ kind: "missing-samples", text: tr(T).missingSamples(samples) });
  const plugins = missingPlugins(song).length;
  if (plugins) reasons.push({ kind: "missing-plugins", text: tr(T).missingPlugins(plugins) });
  return reasons;
}

const RANK: Record<AttentionKind, number> = { "no-mixdown": 0, "stale-mixdown": 1, "missing-samples": 2, "missing-plugins": 3 };

/** Songs needing attention: the most urgent reason first, then the most recently worked on. */
export function attentionItems(songs: ProjectInfo[], ws: Workspace): AttentionItem[] {
  return songs
    .map((song) => {
      const status = ws.songs[song.path]?.status;
      const lastActivityMs = Math.max(song.modifiedAtMs, ...song.renders.map((r) => r.modifiedAtMs));
      return { song, status, reasons: attentionReasons(song, status), lastActivityMs };
    })
    .filter((i) => i.reasons.length > 0)
    .sort((a, b) => RANK[a.reasons[0].kind] - RANK[b.reasons[0].kind] || b.lastActivityMs - a.lastActivityMs);
}
