import { describe, expect, it } from "vitest";
import { clip, safeFileName } from "./text";

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
