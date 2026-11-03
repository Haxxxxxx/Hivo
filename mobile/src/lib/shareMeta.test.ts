import { describe, expect, it } from "vitest";
import { bandlabLinkIn, cleanTitle, fileNameFor, isBandlabShare, isOpaqueName, nameFromFile, shareText, skippedLabel, titleFromShare } from "./shareMeta";

describe("isOpaqueName", () => {
  it("spots provider ids, numbers and uuids", () => {
    for (const n of ["msf:1000032969", "msf_1000032969.m4a", "msf 1000032969", "document:42", "1000032969.m4a", "3f2b9c1e-8a7d-4c2e-9b1f-0a1b2c3d4e5f.m4a", "shared-2", ".m4a"]) {
      expect(isOpaqueName(n), n).toBe(true);
    }
  });
  it("keeps real names", () => {
    for (const n of ["Night Drive.m4a", "Track 1.wav", "2024 demo.m4a", "Low Tide (Mixdown).mp3"]) {
      expect(isOpaqueName(n), n).toBe(false);
    }
  });
});

describe("cleanTitle", () => {
  it("drops links, app names and lead-ins", () => {
    expect(cleanTitle("https://www.bandlab.com/post/abc")).toBe("");
    expect(cleanTitle("Night Drive on BandLab")).toBe("Night Drive");
    expect(cleanTitle("Night Drive | BandLab")).toBe("Night Drive");
    expect(cleanTitle("Night Drive - BandLab https://bandlab.com/x")).toBe("Night Drive");
    expect(cleanTitle("Check out my new song Night Drive on BandLab!")).toBe("Night Drive");
    expect(cleanTitle("Écoute Night Drive sur BandLab")).toBe("Night Drive");
    expect(cleanTitle("Listen to “Night Drive” by Ana on BandLab: https://bandlab.com/x")).toBe("Night Drive");
    expect(cleanTitle("Night Drive by Ana")).toBe("Night Drive");
  });
  it("says nothing for generic words and ids", () => {
    for (const s of ["BandLab", "Shared", "Untitled", "BandLab - Song", "msf:1000032969", "  ", "Mixdown"]) {
      expect(cleanTitle(s), s).toBe("");
    }
  });
});

describe("titleFromShare", () => {
  it("prefers the subject, then a text line, then a real file name", () => {
    expect(titleFromShare({ subject: "Night Drive", text: "https://bandlab.com/x", fileNames: ["a.m4a"] })).toBe("Night Drive");
    expect(titleFromShare({ subject: "BandLab", text: "Low Tide on BandLab\nhttps://bandlab.com/x", fileNames: [] })).toBe("Low Tide");
    expect(titleFromShare({ subject: null, text: null, fileNames: ["msf_1000032969.m4a", "Glass_Roof (Mixdown).m4a"] })).toBe("Glass Roof");
  });
  it("gives nothing rather than an id or a link (the BandLab case that was reported)", () => {
    expect(titleFromShare({ subject: null, text: "https://www.bandlab.com/post/abc", fileNames: ["msf_1000032969.m4a"] })).toBe("");
  });
  it("skips a long line (lyrics, a sentence)", () => {
    const long = "a ".repeat(60).trim();
    expect(titleFromShare({ subject: null, text: `${long}\nShort title`, fileNames: [] })).toBe("Short title");
  });
});

describe("nameFromFile", () => {
  it("cleans a real name and refuses an id", () => {
    expect(nameFromFile("Night_Run (Mixdown).mp3")).toBe("Night Run");
    expect(nameFromFile("msf_1000032969.m4a")).toBe("");
  });
});

describe("bandlabLinkIn", () => {
  it("finds the link (any bandlab.com host), trims trailing punctuation", () => {
    expect(bandlabLinkIn("Listen: https://www.bandlab.com/post/abc-123).", null)).toBe("https://www.bandlab.com/post/abc-123");
    expect(bandlabLinkIn(null, "https://m.bandlab.com/track/x")).toBe("https://m.bandlab.com/track/x");
    expect(bandlabLinkIn("http://bandlab.com/x", "https://example.com/bandlab.com")).toBeNull();
  });
});

describe("fileNameFor", () => {
  it("keeps a real name, renames an id after the title", () => {
    expect(fileNameFor("Night Drive.m4a", true, "Other", 0, 1)).toBe("Night Drive.m4a");
    expect(fileNameFor("msf_1000032969.m4a", false, "Night Drive", 0, 1)).toBe("Night Drive.m4a");
    expect(fileNameFor("msf_1000032969.m4a", true, "Night Drive", 0, 1)).toBe("Night Drive.m4a");
    expect(fileNameFor("msf_1.m4a", false, "Night: Drive", 1, 3)).toBe("Night Drive 2.m4a");
    expect(fileNameFor("msf_1000032969.m4a", false, "", 0, 1)).toBe("BandLab export.m4a");
    expect(fileNameFor("msf_1000032969", false, "Night Drive", 0, 1)).toBe("Night Drive");
  });

  it("keeps a picked file's real name even without a display name (F3), renames a bare number", () => {
    expect(fileNameFor("Beat été test.wav", false, "", 0, 1, "Shared file")).toBe("Beat été test.wav");
    expect(fileNameFor("19.wav", false, "", 0, 1, "Shared file")).toBe("Shared file.wav");
  });
});

describe("share labels", () => {
  it("BandLab only when it is one", () => {
    expect(isBandlabShare("Listen on BandLab https://www.bandlab.com/track/x", null)).toBe(true);
    expect(isBandlabShare(null, "BandLab")).toBe(true);
    expect(isBandlabShare(null, null)).toBe(false);
    expect(isBandlabShare("my beat", "Files")).toBe(false);
  });

  it("an unreadable item shows its name or 'Unnamed file', never a content id (P6)", () => {
    expect(skippedLabel("19", false, "Unnamed file")).toBe("Unnamed file");
    expect(skippedLabel("19", undefined, "Unnamed file")).toBe("Unnamed file");
    expect(skippedLabel("", undefined, "Unnamed file")).toBe("Unnamed file");
    expect(skippedLabel("msf_1000032969", true, "Unnamed file")).toBe("Unnamed file");
    expect(skippedLabel("Night.wav", true, "Unnamed file")).toBe("Night.wav");
  });
});

describe("shareText", () => {
  it("keeps subject and text once, capped", () => {
    expect(shareText("Night Drive https://bandlab.com/x", "Night Drive")).toBe("Night Drive https://bandlab.com/x");
    expect(shareText("https://bandlab.com/x", "Night Drive")).toBe("Night Drive\nhttps://bandlab.com/x");
    expect(shareText(null, null)).toBe("");
    expect(shareText("x".repeat(5000), null)).toHaveLength(2000);
  });
  it("never cuts an emoji in half (half a pair breaks the computer's JSON)", () => {
    const text = `${"x".repeat(1999)}🔥 rest`;
    expect(JSON.stringify(shareText(text, null))).not.toMatch(/\\ud83d/);
    expect(JSON.stringify(cleanTitle(`${"a".repeat(119)}🔥`))).not.toMatch(/\\ud83d/);
  });
});
