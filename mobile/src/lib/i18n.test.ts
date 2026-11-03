import { describe, expect, it } from "vitest";
import { isOne, plural, sizeText } from "./i18n";

describe("sizeText", () => {
  it("speaks the app's language (F3: '345 KB' in French)", () => {
    expect(sizeText(345 * 1024, "en")).toBe("345 KB");
    expect(sizeText(345 * 1024, "fr")).toBe("345 Ko");
    expect(sizeText(1.3 * 1024 * 1024, "fr")).toBe("1,3 Mo");
    expect(sizeText(1.3 * 1024 * 1024, "en")).toBe("1.3 MB");
    expect(sizeText(10, "en")).toBe("1 KB");
  });
});

describe("plural", () => {
  it("matches Intl.PluralRules without needing it (Hermes has none)", () => {
    const values = [0, 0.5, 1, 1.5, 1.99, 2, 2.5, 3, 10, 21, 100, 1000];
    for (const n of values) {
      expect(isOne(n, "en"), `en ${n}`).toBe(new Intl.PluralRules("en-US").select(n) === "one");
      expect(isOne(n, "fr"), `fr ${n}`).toBe(new Intl.PluralRules("fr-FR").select(n) === "one");
    }
    expect(plural(1, "bar", "bars", "en")).toBe("bar");
    expect(plural(0, "mesure", "mesures", "fr")).toBe("mesure");
    expect(plural(2, "mesure", "mesures", "fr")).toBe("mesures");
  });
});
