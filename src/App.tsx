import { DiggerView } from "./components/DiggerView";
import { applyLang, dict, resolveLang, tr } from "./i18n";
import { CrewBoardView, CrewMembersView, CrewReleasesView, CrewSettingsView } from "./components/CrewViews";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./components/Dashboard";
import { LibraryView } from "./components/LibraryView";
import { PipelineView } from "./components/PipelineView";
import { AlbumsView } from "./components/AlbumsView";
import { PeopleView } from "./components/PeopleView";
import { SettingsView } from "./components/SettingsView";
import { LaunchKitView } from "./components/LaunchKitView";
import { CalendarView } from "./components/CalendarView";
import { RenderPanel } from "./components/RenderPanel";
import { PackageConfirm, PackagePanel } from "./components/PackagePanel";
import { ProjectDrawer } from "./components/ProjectDrawer";
import { NewProjectModal } from "./components/NewProjectModal";
import { FeedbackModal } from "./components/FeedbackModal";
import { InboxView } from "./components/InboxView";
import { supabase } from "./lib/supabase";
import { updateErrorKind } from "./lib/updaterErrors";
import { scrubPaths } from "./lib/feedback";
import { appLocation } from "./lib/tauri";
import { UPDATES_ENABLED } from "./lib/updater";
import { flushWorkspace, useAppStore } from "./store/useAppStore";
import { startPhoneSyncBridge } from "./store/phoneSyncBridge";
import { startSessionBridge } from "./store/sessionBridge";
import { useCrewStore, useInCrew } from "./store/useCrewStore";
import { ConfirmButton, StatusDot, btnPrimary, btnQuiet } from "./ui";
import { RemovedNotice } from "./components/CrewPanel";

const fileName = (p: string) => p.split(/[/\\]/).pop() ?? p;

const T = dict(
  {
    kept: (n: number) => `Kept the details of ${n} renamed or moved song${n === 1 ? "" : "s"}`,
    ok: "OK",
    moved: (file: string) => `moved (${file})`,
    more: (n: number) => `+${n} more`,
    loading: "Loading...",
    browserBefore: "This is the app's UI in a browser tab, so nothing can load or save here (no folders, settings or AI key). Run",
    browserAfter: "and use the Hivo window that opens.",
    dismiss: "Dismiss",
    reportThis: "Report this",
    updateReady: (v: string) => `Hivo ${v} is ready`,
    updateDownloading: (v: string, pct: number | null) => `Downloading Hivo ${v}${pct === null ? "…" : ` · ${pct}%`}`,
    updateRestarting: (v: string) => `Hivo ${v} is installed, restarting…`,
    updateReadOnly: "Hivo is running from a read-only place (the disk image, or the copy macOS makes of a downloaded app). Move it to Applications with Finder, open it from there, and try again.",
    locationDmg: "Hivo is running from the disk image: updates can't install here. Drag it to Applications in Finder and open it from there.",
    locationTranslocated: "macOS is running a quarantine copy of Hivo: updates can't install here. Move it to Applications with Finder (or run the fix command in Terminal) and reopen it.",
    copyFix: "Copy fix command",
    copied: "Copied",
    updateNow: "Update and restart",
    retry: "Retry",
    sampleData: "Sample data: nothing is saved and export is off. Link a real folder anytime.",
    exitSample: "Exit sample data",
    later: "Later",
    notSaving: "Changes aren't being saved",
    updateOffline: "Couldn't reach the update server. Check your internet connection and try again.",
    updateFailedPlain: (v: string) => `Couldn't update to Hivo ${v}. Try again later.`,
    unreadable: "Your workspace (stages, notes, releases) couldn't be read. Changes made now are only kept if you start fresh.",
    unreadableBackup: "Your workspace (stages, notes, releases) couldn't be read. You can put back its last backup.",
    newer: (v: number) => `This workspace was saved by a newer Hivo (format ${v}). It's shown read-only: update Hivo to edit it.`,
    restoreBackup: "Restore backup",
    startFresh: "Start fresh",
    startFreshConfirm: "Start fresh? The unreadable file is kept as workspace.json.bad.",
    showFolder: "Show folder",
    actionFailed: (e: string) => `That didn't work: ${e}`,
    closeSaveFailed: (e: string) => `${e} Hivo stayed open so nothing is lost: try Retry, or close again to quit without these changes.`,
  },
  {
    kept: (n: number) =>
      n === 1 ? "Infos gardées pour 1 son renommé ou déplacé" : `Infos gardées pour ${n} sons renommés ou déplacés`,
    ok: "OK",
    moved: (file: string) => `déplacé (${file})`,
    more: (n: number) => `+${n} autres`,
    loading: "Chargement...",
    browserBefore:
      "C'est l'interface de l'app dans un onglet de navigateur, donc rien ne peut se charger ni s'enregistrer ici (pas de dossiers, de réglages ni de clé IA). Lance",
    browserAfter: "et utilise la fenêtre Hivo qui s'ouvre.",
    dismiss: "Fermer",
    reportThis: "Signaler",
    updateReady: (v: string) => `Hivo ${v} est prêt`,
    updateDownloading: (v: string, pct: number | null) => `Téléchargement de Hivo ${v}${pct === null ? "…" : ` · ${pct} %`}`,
    updateRestarting: (v: string) => `Hivo ${v} est installé, redémarrage…`,
    updateReadOnly: "Hivo tourne depuis un emplacement en lecture seule (l'image disque, ou la copie que macOS fait d'une appli téléchargée). Déplace-le dans Applications avec le Finder, ouvre-le de là et réessaie.",
    locationDmg: "Hivo tourne depuis l'image disque : les mises à jour ne peuvent pas s'installer ici. Glisse-le dans Applications avec le Finder et ouvre-le de là.",
    locationTranslocated: "macOS exécute une copie en quarantaine de Hivo : les mises à jour ne peuvent pas s'installer ici. Déplace-le dans Applications avec le Finder (ou lance la commande de réparation dans le Terminal) et rouvre-le.",
    copyFix: "Copier la commande de réparation",
    copied: "Copié",
    updateNow: "Mettre à jour et redémarrer",
    retry: "Réessayer",
    sampleData: "Données d'exemple : rien n'est enregistré et l'export est coupé. Lie un vrai dossier quand tu veux.",
    exitSample: "Quitter les données d'exemple",
    later: "Plus tard",
    notSaving: "Les modifications ne sont pas enregistrées",
    updateOffline: "Impossible de joindre le serveur de mises à jour. Vérifie ta connexion internet et réessaie.",
    updateFailedPlain: (v: string) => `Impossible de passer à Hivo ${v}. Réessaie plus tard.`,
    unreadable: "Ton espace de travail (étapes, notes, sorties) est illisible. Les modifications faites maintenant ne sont gardées que si tu repars de zéro.",
    unreadableBackup: "Ton espace de travail (étapes, notes, sorties) est illisible. Tu peux remettre sa dernière sauvegarde.",
    newer: (v: number) => `Cet espace de travail a été enregistré par un Hivo plus récent (format ${v}). Il est affiché en lecture seule : mets Hivo à jour pour le modifier.`,
    restoreBackup: "Remettre la sauvegarde",
    startFresh: "Repartir de zéro",
    startFreshConfirm: "Repartir de zéro ? Le fichier illisible est gardé sous workspace.json.bad.",
    showFolder: "Afficher le dossier",
    actionFailed: (e: string) => `Ça n'a pas marché : ${e}`,
    closeSaveFailed: (e: string) => `${e} Hivo est resté ouvert pour ne rien perdre : essaie Réessayer, ou ferme encore pour quitter sans ces modifications.`,
  },
);

/** A newer Hivo is ready: one strip above the view, one orange action. Only
 * shown once a version is known (check failures stay in Settings). */
function UpdateNotice() {
  const update = useAppStore((s) => s.update);
  const install = useAppStore((s) => s.installUpdate);
  const check = useAppStore((s) => s.checkUpdate);
  const dismiss = useAppStore((s) => s.dismissUpdate);
  const { status, version } = update;
  if (!version || status === "idle" || status === "checking") return null;
  const pct = update.progress === undefined ? null : Math.round(update.progress * 100);
  const led = status === "error" ? "var(--color-missing)" : status === "available" ? "var(--color-hot)" : "var(--color-ok)";
  const text =
    status === "available"
      ? tr(T).updateReady(version)
      : status === "downloading"
        ? tr(T).updateDownloading(version, pct)
        : status === "ready"
          ? tr(T).updateRestarting(version)
          : updateErrorKind(update.error) === "readOnly"
            ? tr(T).updateReadOnly
            : updateErrorKind(update.error) === "network"
              ? tr(T).updateOffline
              : tr(T).updateFailedPlain(version);
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-rule bg-panel px-5 py-2 text-xs">
      <StatusDot color={led} size={7} />
      <span className={`min-w-0 flex-1 truncate ${status === "error" ? "text-missing" : "text-cream"}`} title={status === "error" && update.error ? `${text} (${update.error})` : text}>
        {text}
      </span>
      {status === "downloading" && pct !== null && (
        <span className="h-1 w-32 shrink-0 overflow-hidden rounded bg-rule" aria-hidden>
          <span className="block h-full bg-cream" style={{ width: `${pct}%` }} />
        </span>
      )}
      {status === "available" && (
        <button onClick={() => void install()} className={btnPrimary}>
          {tr(T).updateNow}
        </button>
      )}
      {/* After a failure the downloaded update is gone: look again first. */}
      {status === "error" && (
        <button onClick={() => void check()} className={btnPrimary}>
          {tr(T).retry}
        </button>
      )}
      {(status === "available" || status === "error") && (
        <button onClick={dismiss} className={btnQuiet}>
          {tr(T).later}
        </button>
      )}
    </div>
  );
}


/** The fix Terminal command for a quarantined copy (what the strip copies). */
const FIX_COMMAND = "xattr -cr /Applications/Hivo.app";

/** On macOS, a warning when Hivo runs from the disk image or from Gatekeeper's
 * quarantine copy: in-app updates would fail there (see updaterErrors.ts). */
function LocationNotice() {
  const [kind, setKind] = useState<"dmg" | "translocated" | null>(null);
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!UPDATES_ENABLED) return;
    let live = true;
    appLocation()
      .then((l) => live && setKind(l.readOnly))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!kind || dismissed) return null;
  const copy = () => {
    void navigator.clipboard.writeText(FIX_COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-cream">
      <StatusDot color="var(--color-warn)" size={6} />
      <span className="flex-1">{kind === "dmg" ? tr(T).locationDmg : tr(T).locationTranslocated}</span>
      {kind === "translocated" && (
        <button onClick={copy} className="rounded border border-rule-strong px-2 py-0.5 font-mono text-[11px] text-body hover:bg-raised hover:text-cream">
          {copied ? tr(T).copied : tr(T).copyFix}
        </button>
      )}
      <button onClick={() => setDismissed(true)} aria-label={tr(T).dismiss} className="text-engrave hover:text-cream">
        ✕
      </button>
    </div>
  );
}

/** Stays up while the workspace can't be read or saved (the red banner
 * above is one-off and dismissable; this one isn't). */
/** Sample data on screen: says so on every page, with the way out. */
function DemoStrip() {
  const demoMode = useAppStore((s) => s.demoMode);
  const exitDemoMode = useAppStore((s) => s.exitDemoMode);
  if (!demoMode) return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-hot/40 bg-hot/10 px-4 py-1.5 text-xs text-cream">
      <StatusDot color="var(--color-hot)" size={6} />
      <span className="flex-1">{tr(T).sampleData}</span>
      <button onClick={() => void exitDemoMode()} className="rounded border border-rule-strong px-2 py-0.5 text-body hover:bg-raised hover:text-cream">
        {tr(T).exitSample}
      </button>
    </div>
  );
}

const stripBtn = "rounded border border-rule-strong px-2 py-0.5 text-body hover:bg-raised hover:text-cream";

/** Stays up while the workspace can't be read or saved (the red banner is
 * one-off and dismissable; this one isn't), with the ways out: retry,
 * restore the backup, start fresh (the broken file is kept), show the folder. */
function NotSavingStrip() {
  const writable = useAppStore((s) => s.workspaceWritable);
  const saveError = useAppStore((s) => s.saveError);
  const issue = useAppStore((s) => s.workspaceIssue);
  const demoMode = useAppStore((s) => s.demoMode);
  const retrySave = useAppStore((s) => s.retrySave);
  const restoreBackup = useAppStore((s) => s.restoreWorkspaceBackup);
  const startFresh = useAppStore((s) => s.startFreshWorkspace);
  const showFolder = useAppStore((s) => s.showConfigFolder);
  const [busy, setBusy] = useState(false);
  if (demoMode || (writable && !saveError)) return null;
  const t = tr(T);
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn()
      .catch((e) => useAppStore.setState({ actionError: t.actionFailed(e instanceof Error ? e.message : String(e)) }))
      .finally(() => setBusy(false));
  };
  const text =
    issue?.kind === "newer" ? t.newer(issue.version) : issue?.kind === "unreadable" ? (issue.hasBackup ? t.unreadableBackup : t.unreadable) : t.notSaving;
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-cream">
      <StatusDot color="var(--color-warn)" size={6} />
      <span className="min-w-0 flex-1" title={issue?.kind === "unreadable" ? issue.detail : (saveError ?? undefined)}>
        {text}
      </span>
      {issue?.kind === "unreadable" && issue.hasBackup && (
        <button onClick={() => run(restoreBackup)} disabled={busy} className={stripBtn}>
          {t.restoreBackup}
        </button>
      )}
      {issue?.kind !== "newer" && (
        <button onClick={() => run(retrySave)} disabled={busy} className={stripBtn}>
          {t.retry}
        </button>
      )}
      {issue?.kind === "unreadable" && (
        <ConfirmButton label={t.startFresh} confirmLabel={t.startFreshConfirm} onConfirm={() => run(startFresh)} disabled={busy} className={stripBtn} />
      )}
      {issue && (
        <button onClick={() => run(showFolder)} disabled={busy} className={stripBtn}>
          {t.showFolder}
        </button>
      )}
    </div>
  );
}

/** After a scan: which songs kept their stage, notes, crew share… across a rename/move. */
function RelinkNotice() {
  const relinked = useAppStore((s) => s.relinked);
  const dismiss = useAppStore((s) => s.dismissRelinked);
  if (!relinked.length) return null;
  return (
    <div role="status" className="max-w-sm rounded-md border border-rule bg-raised px-4 py-3 text-xs text-body shadow-xl">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="font-medium text-cream">
          {tr(T).kept(relinked.length)}
        </span>
        <button onClick={dismiss} className="text-body hover:text-cream">
          {tr(T).ok}
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {relinked.slice(0, 5).map((r) => (
          <li key={r.to} className="truncate" title={`${r.from} → ${r.to}`}>
            {fileName(r.from)} → <span className="text-cream">{r.reason === "moved" ? tr(T).moved(fileName(r.to)) : fileName(r.to)}</span>
          </li>
        ))}
        {relinked.length > 5 && <li className="text-engrave">{tr(T).more(relinked.length - 5)}</li>}
      </ul>
    </div>
  );
}

export default function App() {
  const init = useAppStore((s) => s.init);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const inCrew = useInCrew();
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const detailPath = useAppStore((s) => s.detailPath);
  // One banner, but separate slots: a failed action never hides a load error
  // (dismissing clears them all). The most urgent one shows.
  const bannerError = useAppStore((s) => s.saveError ?? s.actionError ?? s.scanError ?? s.startupError);
  const dismissErrors = useAppStore((s) => s.dismissErrors);
  const openFeedback = useAppStore((s) => s.openFeedback);
  // The app's language. Set before rendering; the root is keyed on it, so a
  // change remounts every screen in the new language (src/i18n).
  const lang = resolveLang(useAppStore((s) => s.settings.uiLanguage));
  applyLang(lang);

  useEffect(() => {
    init();
    void useCrewStore.getState().init();
  }, [init]);

  // Left or removed from the crew (or signed out) while on a crew page: that
  // page has nothing to show any more.
  useEffect(() => {
    if (!inCrew && view.startsWith("crew")) setView("dashboard");
  }, [inCrew, view, setView]);

  // Phone sync: answer the requests Rust forwards (only arrive while it's on).
  useEffect(() => {
    if (!isTauri()) return;
    return startPhoneSyncBridge();
  }, []);

  // The session view's window gets its lyrics from here.
  useEffect(() => startSessionBridge(), []);

  // Closing the window right after an edit: write the pending save first.
  useEffect(() => {
    if (!isTauri()) return;
    // A failed save keeps the window open once, with the reason in the
    // banner; closing again quits without those changes.
    let warned = false;
    const off = getCurrentWindow().onCloseRequested(async (event) => {
      if (warned) return;
      if (await flushWorkspace()) return;
      warned = true;
      event.preventDefault();
      const why = useAppStore.getState().saveError ?? "";
      useAppStore.setState({ saveError: tr(T).closeSaveFailed(why) });
    });
    return () => void off.then((unlisten) => unlisten());
  }, []);

  // Coming back from FL Studio: pick up new saves, backups and mixdowns.
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      const { scanning, rendering, demoMode, rescanOrReport } = useAppStore.getState();
      if (scanning || rendering || demoMode || Date.now() - last < 15_000) return;
      last = Date.now();
      // A failure shows in the error banner (a linked folder that stops
      // answering, a settings file that can't be read).
      void rescanOrReport();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!settingsLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-chassis text-sm text-engrave">
        {tr(T).loading}
      </div>
    );
  }

  return (
    <div key={lang} className="relative flex h-screen bg-chassis text-cream">
      <Sidebar />
      {/* A column, so the strips sit above the view (every view is flex-1
          with its own overflow, so it still scrolls). */}
      <div className="flex min-w-0 flex-1 flex-col">
        <UpdateNotice />
        <DemoStrip />
        <NotSavingStrip />
        <LocationNotice />
        {view === "dashboard" && <Dashboard />}
        {view === "library" && <LibraryView />}
        {view === "pipeline" && <PipelineView />}
        {view === "albums" && <AlbumsView />}
        {view === "people" && <PeopleView />}
        {view === "launch" && <LaunchKitView />}
        {view === "calendar" && <CalendarView />}
        {view === "settings" && <SettingsView />}
        {view === "digger" && <DiggerView />}
        {view === "inbox" && <InboxView />}
        {view === "crewBoard" && <CrewBoardView />}
        {view === "crewReleases" && <CrewReleasesView />}
        {view === "crewMembers" && <CrewMembersView />}
        {view === "crewSettings" && <CrewSettingsView />}
      </div>
      {/* Keyed so per-song drawer state (messages, inputs) resets on switch. Settings and the
          Launch Kit only hide it, so its tab and edits are still there on the way back. */}
      <div className="contents" hidden={view === "settings" || view === "launch"}>
        <ProjectDrawer key={detailPath ?? ""} />
      </div>
      <NewProjectModal />
      <FeedbackModal />
      <PackagePanel />
      <PackageConfirm />
      {!isTauri() && (
        <div className="absolute bottom-3 left-1/2 z-40 max-w-xl -translate-x-1/2 rounded-md border border-amber-400/40 bg-[#2a2112] px-4 py-2 text-xs text-amber-100 shadow-xl">
          {tr(T).browserBefore}{" "}
          <code className="rounded bg-black/30 px-1">npm run tauri dev</code> {tr(T).browserAfter}
        </div>
      )}
      {/* Bottom-right notices share one column so they never overlap. */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-40 flex flex-col items-end gap-2 [&>*]:pointer-events-auto">
        <RelinkNotice />
        <RemovedNotice floating />
        <RenderPanel />
      </div>
      {bannerError && (
        <div role="alert" className="absolute left-1/2 top-3 z-40 flex max-w-xl -translate-x-1/2 items-start gap-3 rounded-md border border-red-500/40 bg-[#2a1215] px-4 py-2 text-xs text-red-200 shadow-xl">
          <span>{bannerError}</span>
          {/* The in-app form, with this error as the message (only when this build has a backend). */}
          {supabase && (
            <button
              onClick={() => openFeedback({ category: "bug", message: scrubPaths(bannerError) })}
              className="shrink-0 whitespace-nowrap text-red-200/70 underline hover:text-red-100"
            >
              {tr(T).reportThis}
            </button>
          )}
          <button onClick={dismissErrors} aria-label={tr(T).dismiss} className="shrink-0 text-red-200/70 hover:text-red-100">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
