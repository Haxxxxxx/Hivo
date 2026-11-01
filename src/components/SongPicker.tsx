import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Disc3, Search, Sparkles } from "lucide-react";
import { formatRelative } from "../lib/format";
import { isKitAccepted } from "../lib/kitState";
import { formatBpm, lastSaveMs, renderFreshness, songLabel, stageRank, statusInfo } from "../lib/songs";
import type { ProjectInfo, Workspace } from "../types";
import { StatusDot } from "./ui";
import { dict, tr } from "../i18n";

// Launch Kit song picker: the current song as a readable card, and a
// searchable list grouped by how ready each song is to launch.

const T = dict(
  {
    freshLabel: "Mixdown up to date",
    freshHint: "Rendered after the last save in FL",
    staleLabel: "Mixdown outdated",
    staleHint: "Saved in FL after the last mixdown",
    noneLabel: "No mixdown yet",
    noneHint: "Render one to get snippets and a master",
    mixdownReady: "Mixdown ready",
    mixdownOutdated: "Mixdown outdated",
    noMixdown: "No mixdown",
    kitAccepted: "Kit accepted",
    kitInProgress: "Kit in progress",
    changeSong: "Change song",
    searchPlaceholder: "Search songs, stage, key or tag",
    searchLabel: "Search songs",
    songs: "Songs",
    noMatch: (q: string) => `No song matches “${q}”.`,
    saved: (when: string) => `saved ${when}`,
    keys: "↑ ↓ to move · Enter to open · Esc to close",
  },
  {
    freshLabel: "Mixdown à jour",
    freshHint: "Rendu après la dernière sauvegarde dans FL",
    staleLabel: "Mixdown pas à jour",
    staleHint: "Sauvegardé dans FL après le dernier mixdown",
    noneLabel: "Pas encore de mixdown",
    noneHint: "Fais-en le rendu pour avoir des extraits et un master",
    mixdownReady: "Mixdown prêt",
    mixdownOutdated: "Mixdown pas à jour",
    noMixdown: "Pas de mixdown",
    kitAccepted: "Kit validé",
    kitInProgress: "Kit en cours",
    changeSong: "Changer de son",
    searchPlaceholder: "Cherche un son, une étape, une tonalité ou un tag",
    searchLabel: "Chercher des sons",
    songs: "Sons",
    noMatch: (q: string) => `Aucun son ne correspond à « ${q} ».`,
    saved: (when: string) => `sauvegardé ${when}`,
    keys: "↑ ↓ pour bouger · Entrée pour ouvrir · Échap pour fermer",
  },
);

const GROUPS = ["fresh", "stale", "none"] as const;

function groupText(id: (typeof GROUPS)[number]): { label: string; hint: string } {
  const t = tr(T);
  if (id === "fresh") return { label: t.freshLabel, hint: t.freshHint };
  if (id === "stale") return { label: t.staleLabel, hint: t.staleHint };
  return { label: t.noneLabel, hint: t.noneHint };
}

function MixdownState({ song }: { song: ProjectInfo }) {
  const f = renderFreshness(song);
  const t = tr(T);
  if (f === "fresh") {
    return (
      <span className="flex items-center gap-1 text-emerald-300/90">
        <Disc3 size={11} /> {t.mixdownReady}
      </span>
    );
  }
  if (f === "stale") {
    return (
      <span className="flex items-center gap-1 text-amber-300/90">
        <AlertTriangle size={11} /> {t.mixdownOutdated}
      </span>
    );
  }
  return <span className="text-engrave">{t.noMixdown}</span>;
}

function KitState({ song, workspace }: { song: ProjectInfo; workspace: Workspace }) {
  const kit = workspace.songs[song.path]?.launchKit;
  const t = tr(T);
  if (isKitAccepted(song, workspace.songs[song.path], workspace.albums)) {
    return (
      <span className="flex items-center gap-1 text-emerald-300/90">
        <CheckCircle2 size={11} /> {t.kitAccepted}
      </span>
    );
  }
  if (kit?.ai?.review || kit?.ai?.drafts) {
    return (
      <span className="flex items-center gap-1 text-body">
        <Sparkles size={11} /> {t.kitInProgress}
      </span>
    );
  }
  if (kit?.edits && Object.keys(kit.edits).length) return <span className="text-engrave">{t.kitInProgress}</span>;
  return null;
}

export function SongPicker({
  songs,
  current,
  workspace,
  onSelect,
}: {
  songs: ProjectInfo[];
  current: ProjectInfo;
  workspace: Workspace;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Grouped by mixdown readiness, then closest to release, then last save.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = songs.filter((s) => {
      if (!q) return true;
      const meta = workspace.songs[s.path];
      return [s.name, statusInfo(meta?.status).label, meta?.key ?? "", ...(meta?.tags ?? [])].some((t) => t.toLowerCase().includes(q));
    });
    const rank = (s: ProjectInfo) => stageRank(workspace.songs[s.path]?.status);
    return GROUPS.map((id) => ({
      id,
      ...groupText(id),
      songs: matches.filter((s) => renderFreshness(s) === id).sort((a, b) => rank(a) - rank(b) || lastSaveMs(b) - lastSaveMs(a)),
    })).filter((g) => g.songs.length);
  }, [songs, workspace.songs, query]);
  const flat = groups.flatMap((g) => g.songs);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, flat.findIndex((s) => s.path === current.path)));
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the highlighted row in view while arrowing through the list.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(song: ProjectInfo) {
    onSelect(song.path);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const meta = workspace.songs[current.path];
  const status = statusInfo(meta?.status);
  let index = -1;
  const t = tr(T);

  return (
    <div ref={root} className="relative min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="group flex min-w-0 max-w-[34rem] items-center gap-3 rounded-lg border border-rule bg-panel px-3.5 py-2 text-left hover:border-rule-strong hover:bg-raised"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-cream">{songLabel(current, songs)}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-engrave">
            <span className="flex items-center gap-1.5">
              <StatusDot color={status.color} size={7} /> {status.label}
            </span>
            {current.tempoBpm != null && <span>{formatBpm(current.tempoBpm)} BPM</span>}
            {meta?.key && <span>{meta.key}</span>}
            <MixdownState song={current} />
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-engrave group-hover:text-body">
          {t.changeSong} <ChevronDown size={14} className={open ? "rotate-180" : ""} />
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 flex max-h-[70vh] w-[30rem] flex-col overflow-hidden rounded-xl border border-rule bg-panel shadow-2xl">
          <div className="flex items-center gap-2 border-b border-rule px-3 py-2.5">
            <Search size={14} className="text-engrave" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={t.searchPlaceholder}
              aria-label={t.searchLabel}
              aria-controls="launch-song-list"
              aria-activedescendant={flat[active] ? `song-opt-${active}` : undefined}
              className="flex-1 bg-transparent text-sm text-cream placeholder:text-engrave focus:outline-none"
            />
            <kbd className="rounded border border-rule px-1 text-[10px] text-engrave">esc</kbd>
          </div>
          <div ref={listRef} id="launch-song-list" role="listbox" aria-label={t.songs} className="overflow-y-auto py-1">
            {groups.length === 0 && <div className="px-4 py-6 text-center text-xs text-engrave">{t.noMatch(query)}</div>}
            {groups.map((g) => (
              <div key={g.id} role="group" aria-label={g.label}>
                <div className="sticky top-0 flex items-baseline gap-2 bg-panel px-4 pb-1 pt-2.5">
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">{g.label}</span>
                  <span className="text-[10px] text-body">
                    {g.songs.length} · {g.hint}
                  </span>
                </div>
                {g.songs.map((s) => {
                  index += 1;
                  const i = index;
                  const st = statusInfo(workspace.songs[s.path]?.status);
                  const selected = s.path === current.path;
                  return (
                    <div
                      key={s.path}
                      id={`song-opt-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(s)}
                      className={`mx-1.5 cursor-pointer rounded-lg px-3 py-2 ${i === active ? "bg-raised" : ""} ${selected ? "ring-1 ring-orange-400/40" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-cream">{songLabel(s, songs)}</span>
                        <span className="shrink-0 text-[11px] text-engrave">{t.saved(formatRelative(lastSaveMs(s)))}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-engrave">
                        <span className="flex items-center gap-1.5">
                          <StatusDot color={st.color} size={6} /> {st.label}
                        </span>
                        <MixdownState song={s} />
                        <KitState song={s} workspace={workspace} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="border-t border-rule px-4 py-2 text-[10px] text-engrave">{t.keys}</div>
        </div>
      )}
    </div>
  );
}
