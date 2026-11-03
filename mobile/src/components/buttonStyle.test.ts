import { describe, expect, it } from "vitest";
import { C, TAP } from "../tokens";
import { buttonColors, resolveSize, slopTo, type ButtonVariant } from "./buttonStyle";

describe("buttonColors", () => {
  it("keeps orange for primary only", () => {
    const variants: ButtonVariant[] = ["primary", "secondary", "quiet", "danger"];
    for (const v of variants) {
      for (const pressed of [false, true]) {
        const c = buttonColors(v, pressed);
        const orange = [c.background, c.border, c.text].some((x) => x === C.hot || x === C.hotHover);
        expect(orange, `${v} pressed=${pressed}`).toBe(v === "primary");
      }
    }
  });
  it("draws danger in the desktop's missing red, filled while pressed", () => {
    expect(buttonColors("danger", false)).toEqual({ background: C.panel, border: C.missing, text: C.missing });
    expect(buttonColors("danger", true)).toEqual({ background: C.missing, border: C.missing, text: C.chassis });
  });
  it("makes danger look different from Cancel (quiet) and from secondary", () => {
    expect(buttonColors("danger", false).text).not.toBe(buttonColors("quiet", false).text);
    expect(buttonColors("danger", false).border).not.toBe(buttonColors("secondary", false).border);
  });
  it("gives quiet no border or fill until pressed", () => {
    expect(buttonColors("quiet", false)).toMatchObject({ background: "transparent", border: "transparent" });
    expect(buttonColors("quiet", true).background).toBe(C.raised);
  });
  it("outlines secondary on the panel", () => {
    expect(buttonColors("secondary", false)).toEqual({ background: C.panel, border: C.ruleStrong, text: C.cream });
  });
  it("keeps the spinner colour neutral", () => {
    expect([C.hot, C.hotHover]).not.toContain(C.busy);
  });
});

describe("resolveSize", () => {
  it("is regular by default, compact when the screen passed its own hitSlop", () => {
    expect(resolveSize(undefined, undefined)).toBe("regular");
    expect(resolveSize(undefined, { top: 9, bottom: 9 })).toBe("compact");
  });
  it("follows an explicit size", () => {
    expect(resolveSize("regular", { top: 9 })).toBe("regular");
    expect(resolveSize("compact", undefined)).toBe("compact");
  });
});

describe("slopTo", () => {
  it("grows a small box to 48 dp each way", () => {
    expect(slopTo(40, 30)).toEqual({ top: 9, bottom: 9, left: 4, right: 4 });
    const s = slopTo(31, 27);
    expect(27 + s.top + s.bottom).toBeGreaterThanOrEqual(TAP);
    expect(31 + s.left + s.right).toBeGreaterThanOrEqual(TAP);
  });
  it("adds nothing to a box already big enough", () => {
    expect(slopTo(120, 48)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
  it("never shrinks what the caller asked for", () => {
    expect(slopTo(120, 40, { top: 12, left: 6 })).toEqual({ top: 12, bottom: 4, left: 6, right: 0 });
  });
});
