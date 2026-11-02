import { afterEach, describe, expect, it } from "vitest";
import { applyLang, dict, resolveLang, tr } from ".";
import { formatBytes, formatRelative, trashName } from "../lib/format";
import { releaseLine } from "../lib/shorts";
import { STATUSES, UNSORTED, statusInfo } from "../lib/songs";

const DAY = 864e5;
afterEach(() => applyLang("en"));

describe("app language", () => {
  it("System follows the system; French and English are kept", () => {
    expect(resolveLang("fr")).toBe("fr");
    expect(resolveLang("en")).toBe("en");
    expect(["fr", "en"]).toContain(resolveLang("system"));
    expect(["fr", "en"]).toContain(resolveLang(undefined));
  });

  it("a dictionary gives the current language's words", () => {
    const T = dict({ hi: "Hi", n: (k: number) => `${k} songs` }, { hi: "Salut", n: (k: number) => `${k} sons` });
    applyLang("en");
    expect(tr(T).hi).toBe("Hi");
    applyLang("fr");
    expect(tr(T).hi).toBe("Salut");
    expect(tr(T).n(3)).toBe("3 sons");
  });

  it("stage names follow the language, read when shown", () => {
    applyLang("en");
    expect(STATUSES.map((s) => s.label)).toEqual(["Creation", "Production", "Prep", "Release", "Promotion"]);
    applyLang("fr");
    expect(STATUSES.map((s) => s.label)).toEqual(["Création", "Production", "Prépa", "Sortie", "Promo"]);
    expect(UNSORTED.label).toBe("Non classé");
    expect(statusInfo(undefined).label).toBe("Non classé");
    expect(statusInfo("prep").hint).toMatch(/Cover/);
  });

  it("dates, sizes and the trash in French", () => {
    applyLang("fr");
    const now = Date.now();
    expect(formatRelative(now)).toBe("aujourd'hui");
    expect(formatRelative(now - 3 * DAY)).toBe("il y a 3 jours");
    expect(formatRelative(now + DAY)).toBe("demain");
    expect(formatRelative(now - DAY)).toBe("hier");
    expect(formatRelative(now + 2 * DAY)).toBe("dans 2 jours");
    expect(formatRelative(now + 21 * DAY)).toBe("dans 3 semaines");
    expect(formatRelative(now - 90 * DAY)).toBe("il y a 3 mois");
    expect(formatBytes(1536)).toBe("1,5 Ko");
    expect(trashName()).toBe("Corbeille");
    applyLang("en");
    expect(formatRelative(now - 3 * DAY)).toBe("3 days ago");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("a short's release line follows the caption language, not the app's", () => {
    applyLang("en");
    const today = new Date(2026, 10, 2);
    expect(releaseLine("2026-11-06", today, "fr")).toBe("SORTIE VENDREDI · 6 NOV.");
    expect(releaseLine("2026-11-06", today, "en")).toBe("OUT FRIDAY · NOV 6");
    expect(releaseLine("2026-11-01", today, "fr")).toBe("DISPO MAINTENANT");
  });

  it("relative dates count calendar days, across midnight", () => {
    applyLang("en");
    const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
    // 23:50 the day before, seen at 00:10: yesterday, not today.
    expect(formatRelative(at(1, 23, 50), at(2, 0, 10))).toBe("yesterday");
    // 00:10 the next day, seen at 23:50: tomorrow.
    expect(formatRelative(at(3, 0, 10), at(2, 23, 50))).toBe("tomorrow");
    // Earlier the same day, 20 hours apart: still today.
    expect(formatRelative(at(2, 1), at(2, 21))).toBe("today");
    // Two calendar days back, 26 hours apart.
    expect(formatRelative(at(1, 22), at(3, 0))).toBe("2 days ago");
    applyLang("fr");
    expect(formatRelative(at(1, 23, 50), at(2, 0, 10))).toBe("hier");
    expect(formatRelative(at(1, 22), at(3, 0))).toBe("il y a 2 jours");
  });
});
