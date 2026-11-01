import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Workspace } from "../types";

// The store talks to Rust only through these modules: they're replaced, so
// the workspace and settings logic runs here without Tauri.
vi.mock("../lib/tauri", () => ({
  getWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  workspaceFiles: vi.fn(),
  restoreWorkspaceBackup: vi.fn(),
  setAsideWorkspace: vi.fn(),
  showConfigFolder: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  scanProjects: vi.fn(),
  removeWatchedFolder: vi.fn(),
  detectDawFolders: vi.fn(),
}));
vi.mock("../lib/updater", () => ({ UPDATES_ENABLED: false, checkForUpdate: vi.fn(), installUpdate: vi.fn(), discardUpdate: vi.fn() }));

import * as api from "../lib/tauri";
import { applyLang } from "../i18n";
import { EMPTY_WORKSPACE } from "../lib/songs";
import { flushWorkspace, fromStored, useAppStore } from "./useAppStore";

const mocked = vi.mocked(api);
const initial = useAppStore.getState();
const REAL: Workspace = { ...EMPTY_WORKSPACE, albums: [{ id: "a1", title: "Real EP", kind: "ep", color: "#000", trackPaths: [], releaseDate: null, notes: "", createdAtMs: 1 } as unknown as Workspace["albums"][number]] };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}


/** Every workspace saveWorkspace was asked to write. */
const saved = () => mocked.saveWorkspace.mock.calls.map(([ws]) => ws as Workspace);
const last = (): Workspace | undefined => saved()[saved().length - 1];

beforeEach(() => {
  vi.resetAllMocks();
  applyLang("en");
  mocked.saveWorkspace.mockResolvedValue(undefined);
  mocked.workspaceFiles.mockResolvedValue({ hasBackup: false, backupSavedAtMs: null });
  mocked.scanProjects.mockResolvedValue({ projects: [], unreachable: [] });
  useAppStore.setState(initial, true);
});

afterEach(async () => {
  await flushWorkspace();
});

describe("loading the workspace (B2)", () => {
  it("an unreadable workspace is read-only, with the backup offered, and never saved over", async () => {
    mocked.getWorkspace.mockRejectedValue("could not parse workspace: EOF");
    mocked.workspaceFiles.mockResolvedValue({ hasBackup: true, backupSavedAtMs: 1 });
    await useAppStore.getState().retrySave();
    const s = useAppStore.getState();
    expect(s.workspaceWritable).toBe(false);
    expect(s.workspaceIssue).toEqual({ kind: "unreadable", detail: "could not parse workspace: EOF", hasBackup: true });

    s.createAlbum("While broken");
    await flushWorkspace();
    expect(mocked.saveWorkspace).not.toHaveBeenCalled();
  });

  it("a retry that reads drops the edits made meanwhile, and says so", async () => {
    mocked.getWorkspace.mockRejectedValueOnce("unreadable").mockResolvedValueOnce(REAL);
    await useAppStore.getState().retrySave();
    useAppStore.getState().createAlbum("While broken");
    await useAppStore.getState().retrySave();
    const s = useAppStore.getState();
    expect(s.workspaceWritable).toBe(true);
    expect(s.workspaceIssue).toBeNull();
    expect(s.workspace.albums.map((a) => a.title)).toEqual(["Real EP"]);
    expect(s.actionError).toMatch(/weren't kept|were not kept/);
  });

  it("a retry that still fails keeps the edits in memory", async () => {
    mocked.getWorkspace.mockRejectedValue("unreadable");
    await useAppStore.getState().retrySave();
    useAppStore.getState().createAlbum("While broken");
    await useAppStore.getState().retrySave();
    expect(useAppStore.getState().workspace.albums.map((a) => a.title)).toEqual(["While broken"]);
  });

  it("start fresh sets the file aside and saves what's in memory", async () => {
    mocked.getWorkspace.mockRejectedValue("unreadable");
    mocked.setAsideWorkspace.mockResolvedValue(undefined);
    await useAppStore.getState().retrySave();
    useAppStore.getState().createAlbum("Kept");
    await useAppStore.getState().startFreshWorkspace();
    expect(mocked.setAsideWorkspace).toHaveBeenCalledOnce();
    expect(useAppStore.getState().workspaceWritable).toBe(true);
    expect(last()?.albums.map((a) => a.title)).toEqual(["Kept"]);
  });

  it("restore puts the backup on screen and saving resumes", async () => {
    mocked.getWorkspace.mockRejectedValue("unreadable");
    mocked.restoreWorkspaceBackup.mockResolvedValue(REAL);
    await useAppStore.getState().retrySave();
    await useAppStore.getState().restoreWorkspaceBackup();
    const s = useAppStore.getState();
    expect(s.workspaceWritable).toBe(true);
    expect(s.workspace.albums[0].title).toBe("Real EP");
    s.createAlbum("After");
    await flushWorkspace();
    expect(last()?.albums.map((a) => a.title)).toEqual(["Real EP", "After"]);
  });

  it("a workspace from a newer Hivo opens read-only and is never re-stamped", async () => {
    mocked.getWorkspace.mockResolvedValue({ ...REAL, version: 3 } as unknown as Workspace);
    await useAppStore.getState().retrySave();
    const s = useAppStore.getState();
    expect(s.workspaceIssue).toEqual({ kind: "newer", version: 3 });
    expect(s.workspaceWritable).toBe(false);
    expect((s.workspace as { version: number }).version).toBe(3);
    s.createAlbum("Nope");
    await flushWorkspace();
    expect(mocked.saveWorkspace).not.toHaveBeenCalled();
  });

  it("fromStored never carries the sample flag from disk", () => {
    const r = fromStored({ ...REAL, sample: true });
    expect(r.ok && r.workspace.sample).toBeFalsy();
  });
});

describe("leaving sample data (B3)", () => {
  it("loads the real workspace before turning demo mode off, so nothing sample is saved", async () => {
    useAppStore.setState({ workspace: REAL, workspaceWritable: true });
    useAppStore.getState().loadDemoData();
    expect(useAppStore.getState().workspace.sample).toBe(true);

    const read = deferred<Workspace>();
    mocked.getWorkspace.mockReturnValue(read.promise);
    const leaving = useAppStore.getState().exitDemoMode();
    // While the real workspace is being read: still sample data, still unsaved.
    expect(useAppStore.getState().demoMode).toBe(true);
    useAppStore.getState().createAlbum("Edited during the swap");
    await flushWorkspace();
    expect(mocked.saveWorkspace).not.toHaveBeenCalled();

    read.resolve(REAL);
    await leaving;
    const s = useAppStore.getState();
    expect(s.demoMode).toBe(false);
    expect(s.workspace.sample).toBeUndefined();
    expect(s.workspace.albums.map((a) => a.title)).toEqual(["Real EP"]);
    s.createAlbum("Real edit");
    await flushWorkspace();
    expect(saved().every((ws) => !ws.sample && !ws.albums.some((a) => a.title === "Night Shift"))).toBe(true);
    expect(last()?.albums.map((a) => a.title)).toEqual(["Real EP", "Real edit"]);
  });

  it("a workspace marked as sample data is never written, even with demo mode off", async () => {
    useAppStore.setState({ workspace: { ...REAL, sample: true }, workspaceWritable: true, demoMode: false });
    useAppStore.getState().createAlbum("x");
    await flushWorkspace();
    expect(mocked.saveWorkspace).not.toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("a failed save on close is reported (flush says false)", async () => {
    useAppStore.setState({ workspace: REAL, workspaceWritable: true });
    mocked.saveWorkspace.mockRejectedValue("disk full");
    useAppStore.getState().createAlbum("x");
    expect(await flushWorkspace()).toBe(false);
    expect(useAppStore.getState().saveError).toMatch(/disk full/);
    mocked.saveWorkspace.mockResolvedValue(undefined);
    await useAppStore.getState().retrySave();
    expect(useAppStore.getState().saveError).toBeNull();
  });

  it("a settings save that fails goes back to what's saved, and says so", async () => {
    const onDisk = { ...initial.settings, renderFormat: "wav" } as Settings;
    useAppStore.setState({ settings: onDisk });
    mocked.saveSettings.mockRejectedValue("could not write settings.json: read-only");
    mocked.getSettings.mockResolvedValue(onDisk);
    await useAppStore.getState().updateSettings({ renderFormat: "mp3" });
    const s = useAppStore.getState();
    expect(s.settings.renderFormat).toBe("wav");
    expect(s.actionError).toMatch(/read-only/);
    // The caller can handle it instead.
    await expect(useAppStore.getState().updateSettings({ renderFormat: "mp3" }, { report: false })).rejects.toBe("could not write settings.json: read-only");
  });

  it("scan errors have their own slot, cleared by the next scan that works", async () => {
    const linked = { ...initial.settings, watchedFolders: ["/music/a", "/music/b"] };
    useAppStore.setState({ settings: linked, startupError: "settings reset" });
    mocked.removeWatchedFolder.mockResolvedValue({ ...linked, watchedFolders: ["/music/a"] });
    mocked.detectDawFolders.mockResolvedValue([]);
    mocked.scanProjects.mockRejectedValueOnce("drive gone");
    await useAppStore.getState().removeWatchedFolder("/music/b");
    expect(useAppStore.getState().scanError).toMatch(/drive gone/);
    expect(useAppStore.getState().startupError).toBe("settings reset");
    await useAppStore.getState().removeWatchedFolder("/music/b");
    expect(useAppStore.getState().scanError).toBeNull();
    expect(useAppStore.getState().startupError).toBe("settings reset");
  });

  it("a failed DAW-folder lookup isn't reported as 'none found'", async () => {
    mocked.detectDawFolders.mockRejectedValue("could not read settings: permission denied");
    await useAppStore.getState().detectFolders();
    expect(useAppStore.getState().detectedFolders).toEqual([]);
    expect(useAppStore.getState().detectError).toMatch(/permission denied/);
  });
});
