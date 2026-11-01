import { describe, expect, it } from "vitest";
import { clip } from "./text";

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
