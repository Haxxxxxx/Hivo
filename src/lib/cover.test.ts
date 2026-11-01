import { describe, expect, it } from "vitest";
import { buildCoverPrompt, mentions, scrub } from "./cover";

const strip = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

describe("cover prompt title scrub", () => {
  it("removes accented titles, whatever their case or accents", () => {
    for (const text of ["A summer called Été, warm and gold", "ÉTÉ in neon", "ete at dusk", "Été decomposed"]) {
      expect(strip(scrub(text, ["Été"]))).not.toMatch(/\bete\b/);
    }
  });

  it("keeps words that only contain the title", () => {
    expect(scrub("A skeleton on a beach", ["Été"])).toBe("A skeleton on a beach");
  });

  it("no title reaches the prompt, even from the tags or the free text", () => {
    const brief = ["Concept: Été under a broken streetlight", "- Tags: été, night", "Imagery: Ça Va in the rain"].join("\n");
    for (const title of ["Été", "Ça Va"]) {
      const prompt = buildCoverPrompt({ brief, title, artists: "Ana", variant: 0 });
      expect(mentions(prompt, title)).toBe(false);
    }
  });

  it("names the release type", () => {
    expect(buildCoverPrompt({ brief: "Concept: a car", title: "X Y", artists: "", variant: 0, releaseType: "EP" })).toMatch(/^Square cover artwork for a rap EP/);
    expect(buildCoverPrompt({ brief: "Concept: a car", title: "X Y", artists: "", variant: 0 })).toMatch(/for a rap single/);
  });
});
