import { describe, expect, it } from "vitest";
import * as converters from "./converters";
import { converterTemplateFor, templateFromExample } from "./converters";

const video = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("templateFromExample", () => {
  it("swaps a plain or encoded video link for {url}", () => {
    expect(templateFromExample(`https://example.com/convert?u=${video}`)).toBe("https://example.com/convert?u={url}");
    expect(templateFromExample(`https://example.com/convert?u=${encodeURIComponent(video)}&f=mp3`)).toBe("https://example.com/convert?u={url}&f=mp3");
    expect(templateFromExample(`https://example.com/convert?u=${encodeURIComponent(`${video}&t=42s`)}&f=mp3`)).toBe("https://example.com/convert?u={url}&f=mp3");
    // Plain: what follows the id stays (a site's own parameter, or the
    // link's, which the site reads the same way).
    expect(templateFromExample("https://example.com/#https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe("https://example.com/#{url}?si=abc");
    expect(templateFromExample("https://example.com/x/https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("https://example.com/x/{url}");
    // Encoded differently from encodeURIComponent: rebuilt from the decoded form.
    expect(templateFromExample("https://example.com/?u=https%3A//www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://example.com/?u={url}");
  });

  it("gives null without a video link, a template already, or https", () => {
    expect(templateFromExample("https://converter.example/fr/app")).toBeNull();
    expect(templateFromExample("https://example.com/?u={url}")).toBeNull();
    expect(templateFromExample(`http://example.com/?u=${video}`)).toBeNull();
    expect(templateFromExample("https://example.com/?u=%E0%A4%A")).toBeNull();
  });
});

describe("converterTemplateFor", () => {
  it("names no built-in site: only the user's own link", () => {
    expect(Object.keys(converters).sort()).toEqual(["converterTemplateFor", "templateFromExample"]);
    // A site's home page is saved as typed (no preset fills a template in).
    expect(converterTemplateFor("https://converter.example/")).toEqual({ template: "https://converter.example/", recognized: null });
  });

  it("picks the template to save", () => {
    expect(converterTemplateFor(`https://converter.example/go?v=${video}`)).toEqual({ template: "https://converter.example/go?v={url}", recognized: "example" });
    expect(converterTemplateFor("  https://converter.example/page  ")).toEqual({ template: "https://converter.example/page", recognized: null });
  });

  it("keeps a template saved before the presets were removed", () => {
    // What a preset used to save is a plain {url} template: saved again, it stays the same.
    expect(converterTemplateFor("https://converter.example/#{url}")).toEqual({ template: "https://converter.example/#{url}", recognized: null });
  });
});
