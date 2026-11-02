import { afterEach, describe, expect, it } from "vitest";
import { applyLang } from "../i18n";
import { renderSampleNote } from "./renderNotes";

describe("renderSampleNote", () => {
  afterEach(() => applyLang("en"));

  it("says nothing when every sample was where the project says", () => {
    expect(renderSampleNote(0, [])).toBeNull();
    expect(renderSampleNote(undefined, undefined)).toBeNull();
  });

  it("names the first missing samples by file name and counts the rest", () => {
    const note = renderSampleNote(0, ["C:\\Packs\\Kick.wav", "/Users/x/Snare.wav", "Audio/Hat.wav", "Clap.wav", "Perc.wav"])!;
    expect(note).toContain("5 samples weren't found");
    expect(note).toContain("Kick.wav, Snare.wav, Hat.wav (+2)");
    expect(note).not.toContain("C:\\Packs");
  });

  it("tells moved samples apart, in the app's language", () => {
    expect(renderSampleNote(1, [])).toContain("1 sample the project stores");
    applyLang("fr");
    expect(renderSampleNote(2, ["Kick.wav"])).toMatch(/1 sample n'a pas été trouvé.*2 samples que le projet range/);
  });
});
