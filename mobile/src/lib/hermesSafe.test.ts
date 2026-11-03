import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// These tests run in Node, which has the whole Intl API. The release app runs
// on Hermes, which doesn't (no Intl.PluralRules: `plural()` threw and crashed
// 0.7.0). So the app's own code stays off Intl and locale-dependent calls.
const root = fileURLToPath(new URL("../../", import.meta.url));
const FORBIDDEN = /\bIntl\s*\.|\.toLocale(?:Date|Time)?String\s*\(|\.localeCompare\s*\(/;

function sources(dir: string): string[] {
  return (readdirSync(join(root, dir), { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.ts$/.test(f))
    .map((f) => `${dir}/${f.split(sep).join("/")}`);
}

describe("app code that Hermes can run", () => {
  it("uses no Intl or locale-dependent string methods", () => {
    const hits = ["App.tsx", "index.ts", ...sources("src"), ...sources("modules")].flatMap((file) =>
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
        .filter(({ text }) => !text.startsWith("//") && !text.startsWith("*") && FORBIDDEN.test(text)),
    );
    expect(hits.map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
  });
});
