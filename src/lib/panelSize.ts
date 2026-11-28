// Side panels the user can drag wider or narrower (the song drawer, the
// Digger's panels). The width is a per-panel preference kept in
// localStorage, like the crew's remembered names: it is this machine's
// comfort setting, not project data, so it never goes in workspace.json and
// never syncs to the crew.

/** Narrow enough to stay useful, wide enough that the song form still fits. */
export const PANEL_MIN = 300;
export const PANEL_MAX = 900;

/** Just the two methods used here, so the tests can pass a plain object and
 * this file stays testable in the repo's node test environment (no DOM, and
 * no jsdom dependency added for one feature). */
export type PanelStore = Pick<Storage, "getItem" | "setItem">;

const KEY = (name: string) => `hivo.panel.${name}`;

/** localStorage when there is one. A webview can be in a state where
 * touching it throws, and a panel that cannot remember its width is still a
 * working panel. */
export function browserPanelStore(): PanelStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** A width inside the allowed range. Anything unusable (NaN, Infinity, a
 * negative from a drag that left the window) falls back rather than
 * collapsing the panel to nothing the user cannot drag back. */
export function clampPanelWidth(px: number, fallback: number, min = PANEL_MIN, max = PANEL_MAX): number {
  const n = Number.isFinite(px) ? px : fallback;
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));
}

/** The saved width for this panel, or `fallback`. Never throws: a
 * hand-edited or corrupt value must not stop the panel rendering. */
export function loadPanelWidth(name: string, fallback: number, store: PanelStore | null = browserPanelStore()): number {
  if (!store) return fallback;
  try {
    const raw = store.getItem(KEY(name));
    if (raw === null) return fallback;
    const px = Number(raw);
    return Number.isFinite(px) ? clampPanelWidth(px, fallback) : fallback;
  } catch {
    return fallback;
  }
}

/** Remembers the width. Silent on failure, for the same reason. */
export function savePanelWidth(name: string, px: number, store: PanelStore | null = browserPanelStore()): void {
  if (!store) return;
  try {
    store.setItem(KEY(name), String(Math.round(px)));
  } catch {
    // Nothing to do, and nothing worth interrupting the user for.
  }
}

/** Width of a RIGHT-hand panel while its left edge is dragged to `clientX`.
 * Pure, so the drag maths is tested without a DOM. */
export function widthFromDrag(panelRight: number, clientX: number, fallback: number): number {
  return clampPanelWidth(panelRight - clientX, fallback);
}
