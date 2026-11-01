import { useEffect, useMemo, useRef, useState } from "react";
import { Wordmark } from "./LogoMark";
import { CalendarDays, CheckCircle2, Disc3, KanbanSquare, LogOut, Users } from "lucide-react";
import { STATUSES, UNSORTED, isFinished, statusInfo } from "@shared/lib/songs";
import { formatRelative } from "@shared/lib/format";
import { crewPipeline, groupCrewSongs } from "@shared/lib/crewBoard";
import { releaseTracks, sortCrewReleases } from "@shared/lib/crewSync";
import { localDay } from "@shared/lib/crewStats";
import type { CrewSongRow, SongStatus } from "@shared/types";
import { useWeb } from "./store";
import { Landing } from "./Landing";
import { crewText, setUiLang } from "@shared/lib/crewMessages";
import { SIGN_IN } from "./landingCopy";
import { cleanCode, isCodeComplete } from "@shared/lib/signInCode";
import { pageLang, type Lang } from "./lang";
import { W } from "./dashboardCopy";
import { LeaveCrew, MakeOwner, OwnerTools, RemoveMember } from "./OwnerTools";
import { locale, tr } from "@shared/i18n";

const input =
  "w-full rounded-lg border border-rule-strong bg-chassis px-3 py-2.5 text-base text-cream placeholder:text-engrave shadow-[inset_0_2px_3px_rgb(0_0_0/0.5)] focus:border-hot focus:outline-none sm:text-sm";
const primary = "rounded bg-hot px-4 py-2.5 font-display uppercase tracking-[0.06em] text-[15px] font-bold text-chassis hover:bg-hot-hover disabled:cursor-not-allowed disabled:opacity-70";
type Tab = "board" | "releases" | "calendar" | "crew";

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function App() {
  const { ready, userId, crews, init, error, loadError } = useWeb();
  useEffect(() => {
    void init();
  }, [init]);

  // The whole site follows the page's language (/fr, /en, else the browser):
  // landing, sign-in and the crew dashboard, shared stage names included.
  const lang = pageLang();
  setUiLang(lang);
  if (!ready) return <Centered>{tr(W).loading}</Centered>;
  if (!userId) return <Landing lang={lang} signIn={<SignIn lang={lang} />} />;
  if (crews.length === 0 && loadError) return <Shell><LoadFailed message={loadError} /></Shell>;
  if (crews.length === 0) return <Shell><Join /></Shell>;
  return <Dashboard topError={error} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center text-sm text-body">{children}</div>;
}

function Logo() {
  return (
    <div className="flex items-end gap-2.5">
      <Wordmark size={26} />
      <div className="pb-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-engrave">{tr(W).crewTag}</div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 px-5 py-10">
      <Logo />
      {children}
      <p className="mt-auto text-[11px] leading-relaxed text-engrave">
        {tr(W).footer}
      </p>
    </div>
  );
}

function SignIn({ lang }: { lang: Lang }) {
  const t = SIGN_IN[lang];
  const { sendCode, verifyCode, error: storeError } = useWeb();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">{t.title}</h2>
      {/* No crew server in this deployment (missing env vars): say so before anyone types. */}
      {storeError && <p role="alert" className="text-sm text-red-300">{storeError}</p>}
      {!sentTo ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => sendCode(email)).then((ok) => ok && setSentTo(email.trim()));
          }}
        >
          <input type="email" name="email" id="signin-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t.email} autoComplete="email" autoCapitalize="none" spellCheck={false} className={input} />
          <button disabled={busy || !/^\S+@\S+\.\S+$/.test(email.trim())} className={primary}>
            {busy ? t.sending : t.send}
          </button>
          <p className="text-xs text-engrave">{crewText("signInHint", lang)}</p>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => verifyCode(sentTo, code));
          }}
        >
          <p className="text-sm text-body">
            {t.enterCode} <b className="text-cream">{sentTo}</b>.
          </p>
          <input
            value={code}
            onChange={(e) => setCode(cleanCode(e.target.value))}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label={t.code}
            className={`${input} text-center font-mono text-2xl tracking-[0.4em]`}
          />
          <button disabled={busy || !isCodeComplete(code)} className={primary}>
            {busy ? t.checking : t.signIn}
          </button>
          <button type="button" onClick={() => (setSentTo(null), setCode(""))} className="text-xs text-engrave hover:text-cream">
            {t.other}
          </button>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </div>
  );
}

/** Loading the crew list failed: say so (an empty list isn't "no crews"). */
function LoadFailed({ message }: { message: string }) {
  const { loadCrews, signOut } = useWeb();
  const { busy, error, run } = useAction();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{tr(W).loadFailed}</h1>
      <p role="alert" className="text-sm text-red-300">{error ?? message}</p>
      <button onClick={() => void run(loadCrews)} disabled={busy} className={primary}>
        {busy ? tr(W).trying : tr(W).tryAgain}
      </button>
      <button onClick={() => void signOut()} className="self-start text-xs text-engrave hover:text-cream">
        {tr(W).signOut}
      </button>
    </div>
  );
}

/** Same limits as the database checks (crews.name, crew_members.display_name). */
const CREW_NAME_MAX = 80;
const DISPLAY_NAME_MAX = 60;
/** create_crew / join_crew refuse an 11th crew. */
const MAX_CREWS = 10;

/** First crew, or (`another`) one more next to the crews I'm already in. */
function Join({ another = false, onDone }: { another?: boolean; onDone?: () => void }) {
  const { joinCrew, createCrew, email, signOut } = useWeb();
  const lastName = useWeb((s) => s.crews.find((c) => c.id === s.activeCrewId)?.displayName ?? "");
  const [displayName, setDisplayName] = useState(another ? lastName : "");
  const [code, setCode] = useState("");
  const [crewName, setCrewName] = useState("");
  const { busy, error, run } = useAction();
  const done = (ok: boolean) => ok && onDone?.();
  return (
    <div className="flex flex-col gap-4">
      {!another && (
        <>
          <h1 className="text-xl font-semibold">{tr(W).joinTitle}</h1>
          <p className="text-sm text-body" role="status">{crewText("noCrew", undefined, { email: email ?? "" })}</p>
          <p className="text-xs text-engrave">{crewText("noInviteYet")}</p>
        </>
      )}
      <input
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        maxLength={DISPLAY_NAME_MAX}
        placeholder={tr(W).yourName}
        aria-label={tr(W).yourNameLabel}
        className={input}
      />
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
        placeholder={tr(W).inviteCode}
        aria-label={tr(W).inviteCodeLabel}
        className={`${input} text-center font-mono tracking-widest`}
      />
      <button onClick={() => void run(() => joinCrew(code, displayName)).then(done)} disabled={busy || code.length !== 8 || !displayName.trim()} className={primary}>
        {tr(W).joinCrew}
      </button>
      <details className="text-sm text-engrave">
        <summary className="cursor-pointer text-body">{tr(W).newCrewInstead}</summary>
        <div className="mt-3 flex flex-col gap-3">
          <input value={crewName} onChange={(e) => setCrewName(e.target.value)} maxLength={CREW_NAME_MAX} placeholder={tr(W).crewName} aria-label={tr(W).crewName} className={input} />
          <button onClick={() => void run(() => createCrew(crewName, displayName)).then(done)} disabled={busy || !crewName.trim() || !displayName.trim()} className="rounded-lg border border-rule-strong px-4 py-2.5 text-sm text-cream hover:bg-raised disabled:opacity-40">
            {tr(W).createCrew}
          </button>
        </div>
      </details>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {!another && (
        <button onClick={() => void signOut()} className="self-start text-xs text-engrave hover:text-cream">
          {tr(W).signOut}
        </button>
      )}
    </div>
  );
}

function Dashboard({ topError }: { topError: string | null }) {
  const { crews, activeCrewId, selectCrew, signOut, songs, live } = useWeb();
  const [tab, setTab] = useState<Tab>("board");
  const active = crews.find((c) => c.id === activeCrewId) ?? crews[0];
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "board", label: tr(W).tabBoard, icon: <KanbanSquare size={15} /> },
    { id: "releases", label: tr(W).tabReleases, icon: <Disc3 size={15} /> },
    { id: "calendar", label: tr(W).tabCalendar, icon: <CalendarDays size={15} /> },
    { id: "crew", label: tr(W).tabCrew, icon: <Users size={15} /> },
  ];
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3 sm:px-6">
        <Logo />
        {!live && <span role="status" className="order-last basis-full text-[11px] text-warn">{tr(W).livePaused}</span>}
        <div className="ml-auto flex items-center gap-2">
          {crews.length > 1 ? (
            <select value={active.id} onChange={(e) => void selectCrew(e.target.value)} aria-label={tr(W).activeCrew} className="rounded-md border border-rule bg-raised px-2 py-1.5 text-sm">
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-sm font-medium text-cream">{active.name}</span>
          )}
          <DashLangSwitch />
          <button onClick={() => void signOut()} aria-label={tr(W).signOut} className="rounded p-1.5 text-engrave hover:bg-rule hover:text-cream">
            <LogOut size={15} />
          </button>
        </div>
      </header>
      <nav className="flex gap-1 border-b border-rule px-3 sm:px-5" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm ${tab === t.id ? "border-orange-400 text-cream" : "border-transparent text-engrave hover:text-cream"}`}
          >
            {t.icon} {t.label}
            {t.id === "board" && <span className="text-engrave">{songs.length}</span>}
          </button>
        ))}
      </nav>
      {topError && <div role="alert" className="mx-4 mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{topError}</div>}
      <main className="flex min-h-0 flex-1 flex-col">
        {tab === "board" && <Board />}
        {tab === "releases" && <Releases />}
        {tab === "calendar" && <Calendar />}
        {tab === "crew" && <Crew />}
      </main>
    </div>
  );
}

function useNames() {
  const members = useWeb((s) => s.members);
  return useMemo(() => new Map(members.map((m) => [m.user_id, m.display_name])), [members]);
}

/** The crew board, in the crew's columns (the owner sets them in the app).
 * Same rules as the app: moving a card to a column of another stage moves
 * the song to that stage. */
function Board() {
  const songs = useWeb((s) => s.songs);
  const columns = useWeb((s) => s.columns);
  const moveCard = useWeb((s) => s.moveCard);
  const userId = useWeb((s) => s.userId);
  const names = useNames();
  const [spot, setSpot] = useState<{ col: string; before: string | null } | null>(null);
  const spotRef = useRef(spot);
  const { cfg } = useMemo(() => crewPipeline(columns), [columns]);
  const groups = useMemo(() => groupCrewSongs(songs, cfg), [songs, cfg]);

  if (songs.length === 0) {
    return <div className="p-8 text-center text-sm text-body">{tr(W).nothingShared}</div>;
  }
  const mark = (next: { col: string; before: string | null } | null) => {
    if (spotRef.current?.col === next?.col && spotRef.current?.before === next?.before) return;
    spotRef.current = next;
    setSpot(next);
  };
  const card = (s: CrewSongRow) => (
    <SongCard
      key={s.id}
      s={s}
      columns={cfg.columns}
      columnId={groups.find((g) => g.songs.includes(s))!.column.id}
      you={s.owner_id === userId}
      owner={names.get(s.owner_id)}
      mover={s.stage_updated_by ? (s.stage_updated_by === userId ? tr(W).youLower : names.get(s.stage_updated_by)) : undefined}
      onMove={(col) => void moveCard(s.id, col, null).catch(() => {})}
    />
  );
  const hint = (c: (typeof cfg.columns)[number]) => (c.name.toLowerCase() === statusInfo(c.stage ?? undefined).label.toLowerCase() ? statusInfo(c.stage ?? undefined).hint : statusInfo(c.stage ?? undefined).label);
  const empty = groups.filter((g) => !g.songs.length);
  return (
    <>
      {/* Phones: one list grouped by column (columns don't fit a narrow screen). */}
      <div className="flex flex-col gap-5 p-4 sm:hidden">
        {groups
          .filter((g) => g.songs.length)
          .map(({ column, songs: items }) => (
            <section key={column.id} aria-label={column.name} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <span className="h-2 w-2 self-center rounded-full" style={{ background: statusInfo(column.stage ?? undefined).color }} />
                <span className="text-sm font-medium text-cream">{column.name}</span>
                <span className="text-sm text-engrave">{items.length}</span>
                <span className="truncate text-[11px] text-engrave">{hint(column)}</span>
              </div>
              {items.map(card)}
            </section>
          ))}
        {empty.length > 0 && <p className="text-[11px] text-engrave">{tr(W).empty(empty.map((g) => g.column.name).join(", "))}</p>}
      </div>
      <div className="hidden flex-1 gap-3 overflow-x-auto p-5 sm:flex" onDragEnd={() => mark(null)}>
        {groups.map(({ column, songs: items }) => (
          <section
            key={column.id}
            aria-label={column.name}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              // Not over a card (cards stop the event): the end of the column.
              mark({ col: column.id, before: null });
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) mark(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const target = spotRef.current?.col === column.id ? spotRef.current.before : null;
              mark(null);
              const id = e.dataTransfer.getData("application/x-crew-song");
              if (id) void moveCard(id, column.id, target).catch(() => {});
            }}
            className={`flex min-w-[200px] flex-1 basis-0 flex-col rounded-xl border ${spot?.col === column.id ? "border-orange-400/50 bg-orange-500/[0.05]" : "border-rule bg-panel"}`}
          >
            <div className="px-3 pb-2 pt-3">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: statusInfo(column.stage ?? undefined).color }} />
                <span className="truncate text-sm font-medium text-cream">{column.name}</span>
                <span className="text-sm text-engrave">{items.length}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-engrave">{hint(column)}</p>
            </div>
            <div className="flex flex-col gap-2 px-2 pb-2">
              {items.map((s, i) => (
                <div
                  key={s.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    const before = e.clientY < r.top + r.height / 2 ? s.id : (items[i + 1]?.id ?? null);
                    mark({ col: column.id, before });
                  }}
                >
                  {spot?.col === column.id && spot.before === s.id && <div className="mb-2 h-0.5 rounded-full bg-hot" aria-hidden />}
                  {card(s)}
                </div>
              ))}
              {spot?.col === column.id && spot.before === null && items.length > 0 && <div className="h-0.5 rounded-full bg-hot" aria-hidden />}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function SongCard({
  s,
  columns,
  columnId,
  you,
  owner,
  mover,
  onMove,
}: {
  s: CrewSongRow;
  columns: { id: string; name: string }[];
  columnId: string;
  you: boolean;
  owner?: string;
  mover?: string;
  onMove: (columnId: string) => void;
}) {
  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-crew-song", s.id);
      }}
      className="rounded-lg border border-rule bg-raised px-3 py-2.5"
    >
      <div className="truncate text-sm font-medium text-cream">{s.title}</div>
      <div className="mt-1 text-xs text-body">
        {you ? tr(W).you : (owner ?? tr(W).crewmate)}
        {s.bpm != null && ` · ${Math.round(s.bpm)} BPM`}
        {s.musical_key && ` · ${s.musical_key}`}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-engrave">
        {s.last_saved_at && <span>{tr(W).saved(formatRelative(Date.parse(s.last_saved_at)))}</span>}
        {s.release_date && (
          <span>
            {s.last_saved_at ? "· " : ""}
            {tr(W).out(new Date(`${s.release_date}T00:00:00`).toLocaleDateString(locale(), { day: "numeric", month: "short" }))}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {s.has_mixdown && <Disc3 size={11} aria-label={tr(W).hasMixdown} />}
          {s.kit_accepted && <CheckCircle2 size={11} className="text-emerald-300/80" aria-label={tr(W).kitAccepted} />}
        </span>
      </div>
      {/* Touch screens can't drag: a column picker on every card. */}
      <label className="mt-2 flex items-center gap-2 text-[11px] text-engrave">
        {tr(W).column}
        <select
          value={columnId}
          onChange={(e) => onMove(e.target.value)}
          aria-label={tr(W).columnOf(s.title)}
          className="flex-1 rounded border border-rule bg-raised px-1.5 py-1.5 text-sm text-cream sm:py-1 sm:text-xs"
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {mover && s.stage_updated_by !== s.owner_id && <div className="mt-1 text-[10px] text-engrave">{tr(W).movedBy(mover)}</div>}
    </article>
  );
}

const kindLabel = (kind: string) => ({ album: tr(W).kindAlbum, ep: tr(W).kindEp, single: tr(W).kindSingle, mixtape: tr(W).kindMixtape })[kind] ?? kind;

/** Releases the crew shares from the app: title, date, tracks and where each track is. */
function Releases() {
  const releases = useWeb((s) => s.releases);
  const songs = useWeb((s) => s.songs);
  const userId = useWeb((s) => s.userId);
  const names = useNames();
  const list = sortCrewReleases(releases, localDay(Date.now()));
  if (list.length === 0) return <div className="p-8 text-center text-sm text-body">{tr(W).noReleases}</div>;
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 sm:p-6 md:grid-cols-2">
      {list.map((r) => {
        const tracks = releaseTracks(r, songs);
        const done = tracks.filter((t) => isFinished(t.stage ?? undefined)).length;
        const dateMs = r.release_date ? new Date(`${r.release_date}T00:00:00`).getTime() : null;
        return (
          <article key={r.id} aria-label={r.title} className="rounded-xl border border-rule bg-panel p-4">
            <div className="flex items-start gap-3">
              <span className="mt-1 h-8 w-8 shrink-0 rounded" style={{ background: r.color ?? "var(--color-raised)" }} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-engrave">
                  {kindLabel(r.kind)} · {r.owner_id === userId ? tr(W).you : (names.get(r.owner_id) ?? tr(W).formerMember)}
                </div>
                <h2 className="truncate text-base font-semibold text-cream">{r.title}</h2>
                <div className="text-xs text-body">
                  {dateMs ? `${new Date(dateMs).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" })} · ${formatRelative(dateMs)}` : tr(W).noDate}
                </div>
              </div>
              <span className="shrink-0 text-xs text-engrave">{tr(W).finished(done, tracks.length)}</span>
            </div>
            {tracks.length > 0 && (
              <ol className="mt-3 flex flex-col gap-1 border-t border-rule pt-3">
                {tracks.map((t, i) => (
                  <li key={t.id} className="flex items-center gap-2 text-xs">
                    <span className="w-4 text-right font-mono text-engrave">{i + 1}</span>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: statusInfo(t.stage ?? undefined).color }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-cream">{t.title}</span>
                    <span className="text-engrave">{statusInfo(t.stage ?? undefined).label}</span>
                  </li>
                ))}
              </ol>
            )}
          </article>
        );
      })}
    </div>
  );
}

function Calendar() {
  const songs = useWeb((s) => s.songs);
  const names = useNames();
  const userId = useWeb((s) => s.userId);
  const today = new Date();
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dated = songs
    .filter((s) => s.release_date)
    .map((s) => {
      const [y, m, d] = s.release_date!.split("-").map(Number);
      return { s, date: new Date(y, m - 1, d) };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  // "Released" means the date has passed AND the song moved on to Release or
  // Promotion. A past date on an earlier stage is a dropped ball: it stays in
  // the upcoming list (first, since it's overdue) with a warning, like the
  // desktop calendar's "still in Prep" check.
  const released = (x: { s: CrewSongRow; date: Date }) => x.date.getTime() < todayMs && (x.s.stage === "release" || x.s.stage === "promotion");
  const upcoming = dated.filter((x) => !released(x));
  const past = dated.filter(released).reverse();

  if (dated.length === 0) return <div className="p-8 text-center text-sm text-body">{tr(W).noDates}</div>;
  const Row = ({ s, date }: { s: CrewSongRow; date: Date }) => (
    <div className="flex items-center gap-3 rounded-xl border border-rule bg-panel p-3">
      <div className="flex w-12 shrink-0 flex-col items-center rounded-lg bg-raised py-1">
        <span className="text-[10px]  text-body">{date.toLocaleDateString(locale(), { weekday: "short" })}</span>
        <span className="text-lg font-semibold leading-tight">{date.getDate()}</span>
        <span className="text-[10px]  text-body">{date.toLocaleDateString(locale(), { month: "short" })}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{s.title}</div>
        <div className="text-xs text-body">
          {s.owner_id === userId ? tr(W).you : (names.get(s.owner_id) ?? tr(W).crewmate)} · {statusInfo(s.stage ?? undefined).label}
          {s.kit_accepted ? tr(W).kitReady : ""}
          {date.getTime() < todayMs && !released({ s, date }) && <span className="text-warn">{tr(W).stillIn(statusInfo(s.stage ?? undefined).label)}</span>}
        </div>
      </div>
      <span className="shrink-0 text-xs text-body">{formatRelative(date.getTime())}</span>
    </div>
  );
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4 sm:p-6">
      <h2 className="text-xs font-medium  text-engrave">{tr(W).comingUp}</h2>
      {upcoming.length ? upcoming.map((x) => <Row key={x.s.id} {...x} />) : <p className="text-sm text-body">{tr(W).nothingPlanned}</p>}
      {past.length > 0 && <h2 className="mt-4 text-xs font-medium  text-engrave">{tr(W).released}</h2>}
      {past.slice(0, 10).map((x) => (
        <Row key={x.s.id} {...x} />
      ))}
    </div>
  );
}

function Crew() {
  const { members, songs, userId, crews, activeCrewId } = useWeb();
  const isOwner = crews.find((c) => c.id === activeCrewId)?.role === "owner";
  const [adding, setAdding] = useState(false);
  // Built here, not at module level: stage names follow the language.
  const stages = [{ id: undefined as SongStatus | undefined, ...UNSORTED }, ...STATUSES];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {members.map((m) => {
          const theirs = songs.filter((s) => s.owner_id === m.user_id);
          const active = theirs.filter((s) => s.stage === "creation" || s.stage === "production").length;
          const last = Math.max(0, ...theirs.map((s) => (s.last_saved_at ? Date.parse(s.last_saved_at) : 0)));
          return (
            <div key={m.user_id} className="rounded-xl border border-rule bg-panel p-4">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{m.display_name}</span>
                {m.role === "owner" && <span className="text-xs text-engrave">{tr(W).owner}</span>}
                {m.user_id === userId && <span className="text-xs text-engrave">{tr(W).youLower}</span>}
                {isOwner && m.user_id !== userId && (
                  <span className="ml-auto flex items-start gap-3">
                    <MakeOwner userId={m.user_id} name={m.display_name} />
                    <RemoveMember userId={m.user_id} name={m.display_name} />
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-body">
                {tr(W).memberLine(theirs.length, active, last ? formatRelative(last) : null)}
              </div>
              <div className="mt-3 flex h-1.5 gap-px overflow-hidden rounded-full bg-raised">
                {stages.map((c) => {
                  const n = theirs.filter((s) => (s.stage ?? undefined) === c.id).length;
                  return n ? <span key={c.label} style={{ flexGrow: n, background: c.color }} title={`${c.label}: ${n}`} /> : null;
                })}
              </div>
            </div>
          );
        })}
      </div>
      {adding ? (
        <div className="max-w-md rounded-xl border border-rule p-4">
          <div className="mb-3 flex items-center text-sm font-medium text-cream">
            {tr(W).anotherCrew}
            <button onClick={() => setAdding(false)} className="ml-auto text-xs text-engrave hover:text-cream">
              {tr(W).cancel}
            </button>
          </div>
          <Join another onDone={() => setAdding(false)} />
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={crews.length >= MAX_CREWS}
          title={crews.length >= MAX_CREWS ? tr(W).tenCrews : undefined}
          className="self-start text-sm text-body hover:text-cream disabled:opacity-40"
        >
          {tr(W).addCrew}
        </button>
      )}
      <OwnerTools />
      <LeaveCrew />
    </div>
  );
}

/** FR | EN for the signed-in site: real links (/fr, /en), same as the landing. */
function DashLangSwitch() {
  const lang = pageLang();
  return (
    <nav aria-label={tr(W).language} className="flex items-center gap-1 font-mono text-xs">
      {(["fr", "en"] as const).map((l, i) => (
        <span key={l} className="flex items-center gap-1">
          {i > 0 && (
            <span className="text-engrave" aria-hidden>
              |
            </span>
          )}
          <a href={`/${l}`} hrefLang={l} lang={l} aria-current={l === lang ? "page" : undefined} className={`rounded px-1 py-1 uppercase ${l === lang ? "text-cream" : "text-engrave hover:text-cream"}`}>
            {l}
          </a>
        </span>
      ))}
    </nav>
  );
}
