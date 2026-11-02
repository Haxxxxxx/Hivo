import { describe, expect, it } from "vitest";
import type { Album, Person, ProjectInfo, SongMeta } from "../types";
import { artistLine, buildKit, localDayMs, captionLanguageIssue, kitArtists, kitFiles, kitGuide, kitReadme, kitSnippets, kitTitleFor, masterBaseName, verify, type KitInput } from "./launchKit";

const today = new Date(2026, 9, 13); // Tue 13 Oct 2026
const people: Person[] = [
  { id: "a", name: "Ana", aliases: [], contact: "", notes: "" },
  { id: "b", name: "Ben", aliases: [], contact: "", notes: "" },
  { id: "c", name: "Cleo", aliases: [], contact: "", notes: "" },
];
const project = (over: Partial<ProjectInfo> = {}) =>
  ({
    path: "/p/Night Run v3.flp",
    name: "Night Run v3",
    tempoBpm: 140,
    genre: null,
    artist: null,
    trackNames: [],
    renders: [],
    ...over,
  }) as unknown as ProjectInfo;
const input = (meta: SongMeta = {}, over: Partial<KitInput> = {}): KitInput => ({
  project: project(),
  meta,
  people,
  albums: [],
  analysis: null,
  today,
  lastLanguage: "French",
  labelName: "Night Crew",
  ...over,
});
const value = (kit: ReturnType<typeof buildKit>, id: string) => kit.find((f) => f.id === id)!.value;

describe("artists and featuring", () => {
  const meta: SongMeta = {
    credits: [
      { personId: "a", role: "Lead rap", split: 50 },
      { personId: "b", role: "feat.", split: 20 },
      { personId: "c", role: "Producer", split: 30 },
    ],
  };
  it("keeps featured artists out of the main artist field", () => {
    const kit = buildKit(input(meta));
    expect(value(kit, "artists")).toBe("Ana");
    expect(value(kit, "featuring")).toBe("Ben");
    expect(artistLine("Ana", "Ben")).toBe("Ana feat. Ben");
    expect(masterBaseName(kit, "x")).toBe("Ana feat. Ben - Night Run");
  });

  it("puts the credited people's profile IDs in the kit only when opted in", () => {
    const withLinks: Person[] = people.map((p, i) =>
      i === 0
        ? { ...p, links: [{ platform: "spotify", label: "Spotify", category: "streaming", url: "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb", id: "4Z8W4fKeB5YxbusRsdQVPb", source: "musicbrainz" }, { platform: "website", label: "Website", category: "other", url: "https://example.com/", id: null, source: "musicbrainz" }] }
        : p,
    );
    const artists = kitArtists(meta, withLinks);
    expect(artists.length).toBeGreaterThan(1);
    expect(artists[0].profiles).toEqual([{ label: "Spotify", id: "4Z8W4fKeB5YxbusRsdQVPb", url: "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb" }]);
    expect(artists.slice(1).every((a) => a.profiles.length === 0)).toBe(true);
    const off = kitFiles(buildKit(input(meta)), [], []);
    expect(off.some((f) => f.name === "artist-ids.md")).toBe(false);
    expect(off.find((f) => f.name === "distributor-sheet.md")!.content).not.toContain("Artist profiles");
    const on = kitFiles(buildKit(input(meta)), [], [], "en", "wav", artists);
    const ids = on.find((f) => f.name === "artist-ids.md")!.content;
    expect(ids).toContain("Spotify: 4Z8W4fKeB5YxbusRsdQVPb");
    expect(ids).toContain("no profiles looked up yet");
    expect(on.find((f) => f.name === "distributor-sheet.md")!.content).toContain("## Artist profiles");
    expect(JSON.parse(on.find((f) => f.name === "metadata.json")!.content).artists[0].profiles[0].id).toBe("4Z8W4fKeB5YxbusRsdQVPb");
  });

  it("lists songwriters with roles and splits from the credits", () => {
    expect(value(buildKit(input(meta)), "songwriters")).toBe("Ana (Lead rap) 50%; Ben (feat.) 20%; Cleo (Producer) 30%");
  });

  it("falls back to the artist from FL Studio's project info", () => {
    expect(value(buildKit(input({}, { project: project({ artist: "Milo" }) })), "artists")).toBe("Milo");
  });

  it("prefers the title from FL Studio's project info over the file name", () => {
    expect(value(buildKit(input({}, { project: project({ flpTitle: "Night Run (Remix)" }) })), "title")).toBe("Night Run (Remix)");
    expect(value(buildKit(input()), "title")).toBe("Night Run");
  });
});

describe("songwriter splits", () => {
  it("must add up to 100%", () => {
    expect(verify("songwriters", "Ana 60%; Ben 30%")?.message).toMatch(/90%/);
    expect(verify("songwriters", "Ana 50%; Ben 50%")).toBeUndefined();
    expect(verify("songwriters", "Ana 50%; Ben")?.message).toMatch(/every writer/);
    expect(verify("songwriters", "")?.level).toBe("missing");
  });
});

describe("distribution defaults", () => {
  it("label is the crew, ℗ line is release year + label", () => {
    const kit = buildKit(input());
    expect(value(kit, "label")).toBe("Night Crew");
    expect(value(kit, "copyright")).toBe("℗ 2026 Night Crew");
  });

  it("never prefills the lyrics language: the last one used is only a hint (B12)", () => {
    const lang = buildKit(input({}, { captionLanguage: "en" })).find((f) => f.id === "language")!;
    expect(lang.value).toBe("");
    expect(lang.source).toBe("missing");
    expect(lang.check?.level).toBe("missing");
    expect(lang.note).toMatch(/mostly say French/);
  });

  it("a single is its own release, track 1", () => {
    const kit = buildKit(input());
    expect(value(kit, "releaseType")).toBe("Single");
    expect(value(kit, "releaseTitle")).toBe("Night Run");
    expect(value(kit, "trackNumber")).toBe("1");
  });

  it("an album track gets the album's title, type and position", () => {
    const album: Album = { id: "al", title: "Night EP", kind: "ep", color: "", releaseDate: null, notes: "", trackPaths: ["/p/x.flp", "/p/Night Run v3.flp"], createdAtMs: 0 };
    const kit = buildKit(input({}, { albums: [album] }));
    expect([value(kit, "releaseType"), value(kit, "releaseTitle"), value(kit, "trackNumber")]).toEqual(["EP", "Night EP", "2"]);
  });

  it("checks ISRC and UPC formats, but they're optional", () => {
    expect(verify("isrc", "")).toBeUndefined();
    expect(verify("isrc", "FR-AB1-26-00001")).toBeUndefined();
    expect(verify("isrc", "nope")?.level).toBe("warn");
    expect(verify("upc", "123")?.level).toBe("warn");
    expect(verify("upc", "0123456789012")).toBeUndefined();
  });
});

describe("release timing", () => {
  it("suggests the first Friday 28+ days out", () => {
    expect(value(buildKit(input()), "releaseDate")).toBe("2026-11-13");
  });

  it("skips Fridays that already have a release (yours or the crew's)", () => {
    const kit = buildKit(input({}, { busyDates: ["2026-11-13", "2026-11-20"] }));
    expect(value(kit, "releaseDate")).toBe("2026-11-27");
    expect(kit.find((f) => f.id === "releaseDate")!.note).toMatch(/Skipped 2 Fridays/);
  });
});

describe("distributor sheet", () => {
  it("lays out every value in upload-form order", () => {
    const meta: SongMeta = { credits: [{ personId: "a", role: "Lead rap", split: 100 }] };
    const sheet = kitFiles(buildKit(input(meta)), [{ label: "Hook 15s", startSec: 42, lengthSec: 15 }], []).find((f) => f.name === "distributor-sheet.md")!.content;
    expect(sheet).toContain("- Release type: Single");
    expect(sheet).toContain("- Primary artist(s): Ana");
    expect(sheet).toContain("  - Ana (Lead rap) 100%");
    expect(sheet).toContain("- Preview / TikTok start: 0:42 (the Hook 15s snippet)");
    expect(sheet).toContain("- ISRC: (leave empty: assigned for free)");
    expect(sheet).toContain("- ℗ / © line: ℗ 2026 Night Crew");
  });
});

describe("kitTitleFor", () => {
  // The Files panel finds the exported kit folder by this name, so it must
  // agree with the title field the export writes.
  it("matches the kit's title field in every case", () => {
    const cases: [Partial<ProjectInfo>, SongMeta][] = [
      [{}, {}],
      [{ flpTitle: "Night Run (Remix)" }, {}],
      [{ flpTitle: "  " }, {}],
      [{ flpTitle: "Night Run (Remix)" }, { launchKit: { edits: { title: "Night Run" } } }],
    ];
    for (const [over, meta] of cases) {
      const p = project(over);
      expect(kitTitleFor(p, meta)).toBe(value(buildKit(input(meta, { project: p })), "title"));
    }
  });
});

describe("kitSnippets", () => {
  const analysis = {
    durationSec: 120,
    windowSec: 0.5,
    energy: [],
    snippets: [
      { label: "Hook 15s", startSec: 40, lengthSec: 15, reason: "comes back 2 times" },
      { label: "Teaser 30s", startSec: 32, lengthSec: 30 },
    ],
  } as unknown as Parameters<typeof kitSnippets>[0];

  it("keeps the detected snippets when nothing was edited", () => {
    const s = kitSnippets(analysis, {});
    expect(s.map((x) => [x.label, x.startSec, x.lengthSec, x.key])).toEqual([
      ["Hook 15s", 40, 15, "Hook 15s"],
      ["Teaser 30s", 32, 30, "Teaser 30s"],
    ]);
    expect(s[0].reason).toBe("comes back 2 times");
  });

  it("applies moves and lengths, renames by length, and stays inside the track", () => {
    const s = kitSnippets(analysis, { launchKit: { snippetStarts: { "Hook 15s": 110 }, snippetLengths: { "Hook 15s": 30 } } });
    // 110 + 30 would run past 2:00: pulled back to end at the last second.
    expect(s[0]).toMatchObject({ label: "Hook 30s", key: "Hook 15s", startSec: 90, lengthSec: 30 });
    expect(s[1]).toMatchObject({ label: "Teaser 30s", startSec: 32 });
  });
});

describe("README in every kit", () => {
  const snippets = [{ label: "Hook 15s", startSec: 42, lengthSec: 15 }];
  it("is written first, in the kit's language, naming the real master file", () => {
    const en = kitFiles(buildKit(input()), snippets, [], "en", "mp3");
    expect(en[0].name).toBe("README.md");
    expect(en[0].content).toContain("# Launch kit: Night Run");
    expect(en[0].content).toContain("**distributor-sheet.md**");
    expect(en[0].content).toContain(".mp3**");
    expect(en[0].content).toContain("Hook 15s");
    const fr = kitFiles(buildKit(input()), snippets, [], "fr", null)[0].content;
    expect(fr).toContain("# Kit de sortie\u202f: Night Run");
    expect(fr).toContain("## Dans l'ordre");
    expect(fr).not.toContain("mixdown final");
  });

  it("the popup and the README list the same files", () => {
    const g = kitGuide("en", { title: "X", master: "X.wav", snippets: [] });
    const readme = kitReadme(g, "en");
    for (const item of g.items) expect(readme).toContain(item.file);
  });
});

describe("caption language", () => {
  const meta: SongMeta = { credits: [{ personId: "a", role: "Lead rap", split: 100 }], launchKit: { edits: { releaseDate: "2026-11-20" } } };
  const captions = (lang?: "fr" | "en") => value(buildKit(input(meta, lang ? { captionLanguage: lang } : {})), "captions");

  it("defaults to French, every caption fully French", () => {
    const fr = captions();
    expect(fr).toContain("ANNONCE");
    expect(fr).toContain("Lien en bio");
    expect(fr).toContain("vendredi 20 novembre");
    expect(fr).not.toMatch(/\b(out|link|drops|ANNOUNCE)\b/);
    expect(captionLanguageIssue(fr, "fr")).toBeUndefined();
  });

  it("English kits are fully English", () => {
    const en = captions("en");
    expect(en).toContain("RELEASE DAY");
    expect(en).toContain("Friday 20 November");
    expect(en).not.toMatch(/\b(dispo|lien|sort)\b/);
    expect(captionLanguageIssue(en, "en")).toBeUndefined();
  });

  it("flags a caption that mixes in the other language", () => {
    const mixed = 'ANNONCE\n"Night Run" de Ana, dispo vendredi.\nPre-save link in bio.';
    expect(captionLanguageIssue(mixed, "fr")).toMatch(/Not all in French: .*link/);
    const field = buildKit(input({ ...meta, launchKit: { edits: { ...meta.launchKit!.edits, captions: mixed } } })).find((f) => f.id === "captions")!;
    expect(field.check?.message).toMatch(/Not all in French/);
    // Titles, names and hashtags don't count.
    expect(captionLanguageIssue('ANNONCE\n"Out Now In The Bio" dispo partout. #linkinbio #thenewone', "fr")).toBeUndefined();
  });

  it("AI drafts written in the other language are flagged for a rewrite", () => {
    const drafts = { captions: "ANNOUNCE\nOut now.", coverBrief: "x", model: "m", atMs: 1, basis: { title: "Night Run", artists: "Ana", releaseDate: "2026-11-20", language: "en" as const } };
    const kit = buildKit(input({ ...meta, launchKit: { ...meta.launchKit, ai: { drafts } } }, { captionLanguage: "fr" }));
    expect(kit.find((f) => f.id === "captions")!.check?.message).toMatch(/another title, artist, date or language/);
  });
});

describe("localDayMs", () => {
  it("reads YYYY-MM-DD as local midnight, not UTC", () => {
    const ms = localDayMs("2026-11-06") as number;
    const d = new Date(ms);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 10, 6, 0]);
  });
  it("is null for nothing or a malformed date", () => {
    expect(localDayMs(undefined)).toBeNull();
    expect(localDayMs("")).toBeNull();
    expect(localDayMs("2026-02-30")).toBeNull();
    expect(localDayMs("6 Nov")).toBeNull();
  });
});

describe("pre-save line", () => {
  it("captions mention a pre-save only when a link is set", () => {
    for (const captionLanguage of ["fr", "en"] as const) {
      const without = value(buildKit(input({}, { captionLanguage })), "captions");
      const withLink = value(buildKit(input({ launchKit: { preSaveUrl: "https://example.com/presave" } }, { captionLanguage })), "captions");
      expect(without).not.toMatch(/pr[eé]-save/i);
      expect(withLink).toMatch(/pr[eé]-save/i);
    }
  });
});
