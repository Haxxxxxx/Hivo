import { describe, expect, it } from "vitest";
import { clip, safeFileName, sentence } from "./text";

describe("sentence (smoke polish)", () => {
  it("adds the final period a message on its own needs", () => {
    expect(sentence("The desktop is busy (scan running or still loading). Try again in a few seconds")).toBe("The desktop is busy (scan running or still loading). Try again in a few seconds.");
    expect(sentence("Réessaie dans quelques secondes ")).toBe("Réessaie dans quelques secondes.");
    expect(sentence("show a new one on the computer (Settings → Phone sync)")).toBe("show a new one on the computer (Settings → Phone sync).");
  });
  it("leaves one that already ends a sentence", () => {
    for (const s of ["Done.", "Really?", "Go!", "Wait…", ""]) expect(sentence(s)).toBe(s);
  });
});

describe("safeFileName", () => {
  it("keeps the extension when a long title is cut", () => {
    const n = safeFileName(`${"a".repeat(130)}.m4a`);
    expect(n).toHaveLength(120);
    expect(n.endsWith(".m4a")).toBe(true);
  });
  it("removes separators and leading dots, never empty", () => {
    expect(safeFileName("../x/y:z.wav")).toBe("_x_y_z.wav");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName(".m4a")).toBe("m4a");
    expect(safeFileName("Beat été test.wav")).toBe("Beat été test.wav");
  });
});

describe("clip", () => {
  it("cuts to the limit", () => {
    expect(clip("abcdef", 3)).toBe("abc");
    expect(clip("abc", 3)).toBe("abc");
  });
  it("never leaves half an emoji (the result stays valid JSON for the computer)", () => {
    const s = "ab🔥cd"; // 🔥 is two UTF-16 units at 2-3
    expect(clip(s, 3)).toBe("ab");
    expect(clip(s, 4)).toBe("ab🔥");
    expect(JSON.stringify(clip(s, 3))).not.toMatch(/\\ud83d/);
  });
});
