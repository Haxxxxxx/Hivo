import { afterEach, describe, expect, it } from "vitest";
import { applyLang, plural } from "../i18n";
import { detailBehind, errorDetail, errorReason, errorText, errorTextOr, parseError, untranslatedCodes } from "./errors";

afterEach(() => applyLang("en"));

const coded = (code: string, params?: Record<string, string | number>, detail = "raw English") => JSON.stringify({ code, params, detail });

describe("errors from Rust commands", () => {
  it("a coded error is translated, with its params", () => {
    const e = coded("scope.denied", { what: "project", path: "/m/Envy.flp" }, "That project isn't inside a folder linked in Settings: /m/Envy.flp");
    applyLang("en");
    expect(errorText(e)).toBe("That project isn't inside a folder linked in Settings: /m/Envy.flp");
    applyLang("fr");
    expect(errorText(e)).toBe("Ce projet n'est pas dans un dossier lié dans les Réglages : /m/Envy.flp");
    expect(errorDetail(e)).toBe("That project isn't inside a folder linked in Settings: /m/Envy.flp");
  });

  it("an unknown code falls back to its English detail", () => {
    const e = coded("future.thing", undefined, "Something new happened");
    applyLang("fr");
    expect(errorReason(e)).toBe("Something new happened");
    expect(errorText(e)).toBe("Ça n'a pas marché : Something new happened");
    expect(parseError(e)?.code).toBe("future.thing");
  });

  it("a plain string from Rust gets a translated lead; the app's own Error stays as is", () => {
    applyLang("fr");
    expect(errorText("could not open the thing")).toBe("Ça n'a pas marché : could not open the thing");
    expect(errorReason("could not open the thing")).toBe("could not open the thing");
    expect(errorText(new Error("Déjà traduit."))).toBe("Déjà traduit.");
    expect(errorText("{not json")).toBe("Ça n'a pas marché : {not json");
    expect(errorTextOr(null)).toBeNull();
    expect(errorTextOr("")).toBeNull();
  });

  it("a param that is a coded error is translated too", () => {
    applyLang("fr");
    const e = coded("sketch.notInProject", { reason: coded("template.noVersion") });
    expect(errorText(e)).toMatch(/^L'audio BandLab n'est pas dans le projet \(Le modèle n'a pas de version de FL Studio/);
  });

  it("the raw English behind a shown sentence is kept for Report this", () => {
    applyLang("fr");
    const shown = `Échec${" "}: ${errorReason(coded("render.timeout", undefined, "render timed out and no output was produced"))}`;
    expect(detailBehind(shown)).toBe("render timed out and no output was produced");
    expect(detailBehind("nothing translated here")).toBeNull();
  });

  it("every code has both languages", () => {
    expect(untranslatedCodes()).toEqual([]);
  });
});

describe("plural", () => {
  it("French takes the singular for 0 and 1", () => {
    applyLang("fr");
    expect([0, 1, 2].map((n) => `${n} ${plural(n, "son", "sons")}`)).toEqual(["0 son", "1 son", "2 sons"]);
  });

  it("English takes it for 1 only", () => {
    applyLang("en");
    expect([0, 1, 2].map((n) => `${n} ${plural(n, "song", "songs")}`)).toEqual(["0 songs", "1 song", "2 songs"]);
  });

  it("a language can be forced", () => {
    applyLang("en");
    expect(plural(0, "son", "sons", "fr")).toBe("son");
    expect(plural(0, "song", "songs", "en")).toBe("songs");
  });
});
