import { describe, expect, it } from "vitest";
import { analyzeLyrics, guessLang, isHeader, lineAt, lineSyllables, syllablesPerBar } from "./lyrics";

describe("syllables", () => {
  it("counts English lines within a syllable", () => {
    expect(lineSyllables("I make it rain", "en")).toBe(4);
    expect(lineSyllables("little wanted named", "en")).toBe(5); // lit-tle want-ed named
    expect(lineSyllables("the city never sleeps", "en")).toBe(6);
    expect(lineSyllables("", "en")).toBe(0);
  });

  it("counts French lines, mute endings left out", () => {
    expect(lineSyllables("je suis dans le monde", "fr")).toBe(5); // je suis dans le monde
    expect(lineSyllables("la rue me parle", "fr")).toBe(4);
    expect(lineSyllables("j'ai toujours été là", "fr")).toBe(6); // j'ai tou-jours é-té là
  });

  it("skips section headers", () => {
    expect(isHeader("[Verse 1]")).toBe(true);
    expect(isHeader("(Refrain)")).toBe(true);
    expect(isHeader("[Hook] and a line")).toBe(false);
    expect(lineSyllables("[Hook]", "en")).toBe(0);
  });

  it("guesses the language from the text", () => {
    expect(guessLang("je suis dans la rue avec les miens")).toBe("fr");
    expect(guessLang("j'ai été là")).toBe("fr");
    expect(guessLang("I been on the road all night")).toBe("en");
  });
});

describe("bars from the BPM", () => {
  it("holds more syllables per bar at a slower tempo", () => {
    expect(syllablesPerBar(90)).toBeCloseTo(12, 5);
    expect(syllablesPerBar(180)).toBeCloseTo(6, 5);
  });

  it("estimates the bars a verse fills, to the half bar", () => {
    const verse = ["[Verse 1]", "I make it rain", "the city never sleeps"].join("\n");
    const r = analyzeLyrics(verse, 90, "en");
    expect(r.lines.map((l) => l.syllables)).toEqual([0, 4, 6]);
    expect(r.lines[0].header).toBe(true);
    expect(r.syllables).toBe(10);
    expect(r.bars).toBe(1); // 10 / 12 → 0.83 → 1
    expect(analyzeLyrics(verse, null, "en").bars).toBeNull();
    expect(analyzeLyrics("", 90).bars).toBeNull();
  });

  it("finds the cursor's line", () => {
    expect(lineAt("a\nbb\nc", 0)).toBe(0);
    expect(lineAt("a\nbb\nc", 3)).toBe(1);
    expect(lineAt("a\nbb\nc", 6)).toBe(2);
  });
});
