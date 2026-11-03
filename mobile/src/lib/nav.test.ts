import { describe, expect, it } from "vitest";
import { backAction, canShowShare, filterStack, pop, push, replaceTop, showsUpdateBanner, toTab, top, type Nav } from "./nav";

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
