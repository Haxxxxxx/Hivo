import { describe, expect, it } from "vitest";
import {
  PANEL_MAX,
  PANEL_MIN,
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth,
  widthFromDrag,
  type PanelStore,
} from "./panelSize";

/** A localStorage stand-in, so these run in the repo's node test env. */
const fakeStore = (initial: Record<string, string> = {}): PanelStore => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
};

describe("clampPanelWidth", () => {
  it("keeps a width inside the range", () => {
    expect(clampPanelWidth(500, 380)).toBe(500);
    expect(clampPanelWidth(10, 380)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, 380)).toBe(PANEL_MAX);
  });

  it("falls back rather than collapsing the panel", () => {
    // A drag that left the window, or a corrupt saved value, must never end
    // up as a zero-width panel with no handle left to drag back.
    expect(clampPanelWidth(Number.NaN, 380)).toBe(380);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY, 380)).toBe(380);
  });

  it("rounds to whole pixels", () => {
    expect(clampPanelWidth(420.6, 380)).toBe(421);
  });
});

describe("widthFromDrag", () => {
  it("measures from the panel's right edge", () => {
    // Right edge at 1000, left edge dragged to 600 => 400 wide.
    expect(widthFromDrag(1000, 600, 380)).toBe(400);
  });

  it("clamps instead of inverting when dragged past either end", () => {
    expect(widthFromDrag(1000, 1200, 380)).toBe(PANEL_MIN);
    expect(widthFromDrag(1000, -500, 380)).toBe(PANEL_MAX);
  });
});

describe("loadPanelWidth / savePanelWidth", () => {
  it("returns the fallback when nothing is saved", () => {
    expect(loadPanelWidth("drawer", 380, fakeStore())).toBe(380);
  });

  it("round-trips a width", () => {
    const store = fakeStore();
    savePanelWidth("drawer", 512, store);
    expect(loadPanelWidth("drawer", 380, store)).toBe(512);
  });

  it("ignores a saved value that isn't a number", () => {
    expect(loadPanelWidth("drawer", 380, fakeStore({ "hivo.panel.drawer": "wide please" }))).toBe(380);
  });

  it("clamps a saved value that is out of range", () => {
    expect(loadPanelWidth("drawer", 380, fakeStore({ "hivo.panel.drawer": "99999" }))).toBe(PANEL_MAX);
  });

  it("keeps panels apart", () => {
    const store = fakeStore();
    savePanelWidth("drawer", 500, store);
    savePanelWidth("digger", 700, store);
    expect(loadPanelWidth("drawer", 380, store)).toBe(500);
    expect(loadPanelWidth("digger", 380, store)).toBe(700);
  });

  it("works when there is no storage at all", () => {
    // Some webview states make localStorage throw on access.
    expect(loadPanelWidth("drawer", 380, null)).toBe(380);
    expect(() => savePanelWidth("drawer", 500, null)).not.toThrow();
  });
});
