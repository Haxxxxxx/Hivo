import { describe, expect, it } from "vitest";
import { backAction, canShowShare, filterStack, pairLinkGate, pop, popRoute, push, replaceRoute, replaceTop, showsUpdateBanner, toTab, top, type Nav } from "./nav";

type R = { name: "note" | "settings" | "idea" | "record" | "share" | "pair"; id?: string };
const base: Nav<R> = { tab: "capture", stack: [] };

describe("nav stack", () => {
  it("pushes over the current screen and pops back to it", () => {
    const a = push({ ...base, tab: "library" }, { name: "note", id: "n" });
    const b = push(a, { name: "record" });
    expect(top(b)?.name).toBe("record");
    expect(pop(b)).toEqual(a);
    expect(pop(pop(b)).tab).toBe("library");
    expect(pop(base)).toBe(base);
  });

  it("replaces a share by the idea it became, keeping what's under it", () => {
    const n = push(push(base, { name: "note", id: "n" }), { name: "share" });
    expect(replaceTop(n, { name: "idea", id: "i" }).stack.map((r) => r.name)).toEqual(["note", "idea"]);
  });

  it("goes to a tab with nothing over it", () => {
    expect(toTab(push(base, { name: "settings" }), "library")).toEqual({ tab: "library", stack: [] });
  });

  it("filters routes out", () => {
    const n = push(push(base, { name: "note" }), { name: "share" });
    expect(filterStack(n, (r) => r.name === "share").stack).toEqual([{ name: "share" }]);
  });
});

describe("hardware Back", () => {
  it("cancels a pairing waiting for its code first", () => {
    expect(backAction(push(base, { name: "pair" }), { confirming: true })).toBe("cancel-pairing");
  });
  it("lets record and share decide (a take, shared files)", () => {
    expect(backAction(push(base, { name: "record" }), { confirming: false })).toBe("screen");
    expect(backAction(push(base, { name: "share" }), { confirming: false })).toBe("screen");
  });
  it("pops other screens", () => {
    expect(backAction(push(base, { name: "note" }), { confirming: false })).toBe("pop");
    expect(backAction(push(base, { name: "pair" }), { confirming: false })).toBe("pop");
  });
  it("goes from Library to Capture, then exits", () => {
    expect(backAction({ tab: "library", stack: [] }, { confirming: false })).toBe("to-capture");
    expect(backAction(base, { confirming: false })).toBe("exit");
  });
});

describe("shares and the update banner", () => {
  it("a share waits during a take, another share or pairing", () => {
    expect(canShowShare(base, { confirming: false })).toBe(true);
    expect(canShowShare(push(base, { name: "note" }), { confirming: false })).toBe(true);
    expect(canShowShare(push(base, { name: "record" }), { confirming: false })).toBe(false);
    expect(canShowShare(push(base, { name: "share" }), { confirming: false })).toBe(false);
    expect(canShowShare(push(base, { name: "pair" }), { confirming: false })).toBe(false);
    expect(canShowShare(base, { confirming: true })).toBe(false);
  });
  it("the update banner shows on the tabs and Settings only", () => {
    expect(showsUpdateBanner(base, { confirming: false })).toBe(true);
    expect(showsUpdateBanner(push(base, { name: "settings" }), { confirming: false })).toBe(true);
    expect(showsUpdateBanner(push(base, { name: "record" }), { confirming: false })).toBe(false);
    expect(showsUpdateBanner(push(base, { name: "note" }), { confirming: false })).toBe(false);
    expect(showsUpdateBanner(base, { confirming: true })).toBe(false);
  });
});

describe("a screen pops only itself (review #2)", () => {
  it("removes its own route, even when something was pushed over it", () => {
    const share: R = { name: "share" };
    const n = push(push(base, { name: "note" }), share);
    expect(popRoute(n, share).stack.map((r) => r.name)).toEqual(["note"]);
    // A pairing link pushed the pair screen over a busy share: its Send pops the share, not the pair screen.
    const over = push(n, { name: "pair" });
    expect(popRoute(over, share).stack.map((r) => r.name)).toEqual(["note", "pair"]);
  });
  it("a share kept as an idea becomes that idea where it is", () => {
    const share: R = { name: "share" };
    const n = push(push(base, share), { name: "pair" });
    expect(replaceRoute(n, share, { name: "idea", id: "i" }).stack.map((r) => r.name)).toEqual(["idea", "pair"]);
    expect(replaceRoute(base, share, { name: "idea" })).toBe(base);
  });
  it("leaves the stack alone when its route is already gone", () => {
    const rec: R = { name: "record" };
    const n = push(base, { name: "settings" });
    expect(popRoute(n, rec)).toBe(n);
    // Same name, another route: not it.
    expect(popRoute(push(base, { name: "record" }), rec).stack).toHaveLength(1);
  });
});

describe("pairing links (review #2, #6, #14)", () => {
  const free = { confirming: false, pairBusy: false, unreadable: false };
  it("waits while a take or a share is on screen", () => {
    expect(pairLinkGate(push(base, { name: "record" }), free)).toBe("wait");
    expect(pairLinkGate(push(base, { name: "share" }), free)).toBe("wait");
    expect(pairLinkGate(push(push(base, { name: "record" }), { name: "note" }), free)).toBe("ask");
  });
  it("asks on the tabs and the other screens", () => {
    expect(pairLinkGate(base, free)).toBe("ask");
    expect(pairLinkGate({ tab: "library", stack: [] }, free)).toBe("ask");
    expect(pairLinkGate(push(base, { name: "pair" }), free)).toBe("ask");
    expect(pairLinkGate(push(base, { name: "settings" }), free)).toBe("ask");
  });
  it("refuses while a pairing is checked or the saved pairing can't be read", () => {
    expect(pairLinkGate(base, { ...free, pairBusy: true })).toBe("busy");
    expect(pairLinkGate(base, { ...free, confirming: true })).toBe("busy");
    expect(pairLinkGate(push(base, { name: "record" }), { ...free, unreadable: true })).toBe("unreadable");
  });
});

describe("Back while a code is checked (review #4)", () => {
  it("stays on the pair screen while busy; the code check is cancelled first", () => {
    expect(backAction(push(base, { name: "pair" }), { confirming: false, pairBusy: true })).toBe("ignore");
    expect(backAction(push(base, { name: "pair" }), { confirming: true, pairBusy: true })).toBe("cancel-pairing");
    expect(backAction(push(base, { name: "pair" }), { confirming: false, pairBusy: false })).toBe("pop");
    // Busy only matters on the pair screen.
    expect(backAction(push(base, { name: "note" }), { confirming: false, pairBusy: true })).toBe("pop");
  });
});
