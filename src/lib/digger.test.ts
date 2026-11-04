import { describe, expect, it } from "vitest";
import { MAX_EXCLUDE, MAX_FOUND_TITLES, MAX_LIKED, MAX_QUERY_CHARS, beatFactsLine, beatQuery, canonicalUrl, converterLink, converterNeedsPaste, deeperExclude, embedUrl, foundKey, matchBeat, nameQueries, relinkBeatNotes, restoreDig, sortBeats, titleFacts, titleKey, foundTitles, googleSearchUrl, leadFacts, leadHash, likedTitles, searchesDone, seedList, toggleLiked, withFallbackQueries, youtubeId, youtubeSearchUrl } from "./digger";

describe("digger links", () => {
  it("builds a YouTube search page link", () => {
    expect(youtubeSearchUrl("  dark  trap & rain ")).toBe("https://www.youtube.com/results?search_query=dark%20trap%20%26%20rain");
  });

  it("builds Google links and a facts line", () => {
    expect(googleSearchUrl("dark trap  beat")).toBe("https://www.google.com/search?q=dark%20trap%20beat");
    expect(beatFactsLine({ bpm: 140, bpmSource: "name", key: "Am", durationSec: 185.4 })).toBe("140 BPM · Am · 3:05");
    expect(beatFactsLine({ bpm: 69.5, bpmSource: "audio", key: null, durationSec: 59.6 })).toBe("≈70 BPM · 1:00");
    // The analysis stops at 10 minutes: the length is a floor.
    expect(beatFactsLine({ bpm: null, bpmSource: null, key: null, durationSec: 600, durationCapped: true })).toBe("10:00+");
  });

  it("turns beat file names into searches", () => {
    expect(beatQuery('[FREE] Dark Trap Type Beat - "Night" (prod. X) 140bpm')).toBe("Dark Trap Type Beat Night");
    expect(beatQuery("Chill Lofi Type Beat")).toBe("Chill Lofi Type Beat");
    expect(beatQuery("night_drive_2026")).toBe("night drive type beat");
    expect(beatQuery("Melodic Drill Instrumental prod. by Someone")).toBe("Melodic Drill type beat");
    expect(beatQuery("[FREE] (prod. X)")).toBe("");
    expect(beatQuery("x".repeat(300)).length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });

  it("lists the beats a deeper round must skip by title and site, once each, capped", () => {
    const l = (text: string, site = "BeatStars") => ({ text, site });
    expect(foundKey(l(" Night Drive ", " beatstars.com "))).toBe("night drive | beatstars.com");
    // Untitled links key on their url (same as found_key in Rust), never on " | site" alone.
    expect(foundKey({ text: " ", site: "youtube.com", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" })).toBe("https://www.youtube.com/watch?v=aaaaaaaaaaa | youtube.com");
    expect(deeperExclude([{ text: "", site: "youtube.com", url: "https://a.example/1" }, { text: "", site: "youtube.com", url: "https://a.example/2" }], []).length).toBe(2);
    expect(foundKey(l("x".repeat(300))).length).toBe(120);
    // Shared with `long_keys_match_the_webview` in digger.rs: code points, no ellipsis.
    const long = foundKey({ text: `${"A".repeat(100)}\u{1F525}${"b".repeat(29)}`, site: "YouTube.com" });
    expect(long).toBe(`${"a".repeat(100)}\u{1F525}${"b".repeat(19)}`);
    expect(Array.from(long).length).toBe(120);
    expect(deeperExclude([l("A"), l("B")], [[l("b"), l("C")], [l("D")]])).toEqual(["a | beatstars", "b | beatstars", "c | beatstars", "d | beatstars"]);
    const many = Array.from({ length: 70 }, (_, i) => l(`Beat ${i}`));
    expect(deeperExclude(many, []).length).toBe(MAX_EXCLUDE);
    expect(deeperExclude([], [])).toEqual([]);
  });

  it("lists the titles already shown, once each, clipped and capped", () => {
    expect(foundTitles([" Night  Drive ", "", "night drive", "Cold Room", "x".repeat(300)])).toEqual(["Night Drive", "Cold Room", "x".repeat(120)]);
    expect(foundTitles(Array.from({ length: 70 }, (_, i) => `Beat ${i}`)).length).toBe(MAX_FOUND_TITLES);
    expect(foundTitles([])).toEqual([]);
  });

  it(`picks results for the next round, at most ${MAX_LIKED}, titles cleaned; picking again unpicks`, () => {
    let liked = toggleLiked([], "v1", "  Night  Drive ");
    liked = toggleLiked(liked, "https://www.beatstars.com/beat/x", "");
    expect(liked).toEqual([
      { id: "v1", title: "Night Drive" },
      { id: "https://www.beatstars.com/beat/x", title: "https://www.beatstars.com/beat/x" },
    ]);
    expect(toggleLiked(liked, "v1", "Night Drive")).toEqual([{ id: "https://www.beatstars.com/beat/x", title: "https://www.beatstars.com/beat/x" }]);
    expect(toggleLiked([], "v2", "x".repeat(300))[0].title.length).toBe(120);
    let full: ReturnType<typeof toggleLiked> = [];
    for (let i = 0; i < MAX_LIKED + 5; i++) full = toggleLiked(full, `v${i}`, `Beat ${i}`);
    expect(full.length).toBe(MAX_LIKED);
    expect(toggleLiked(full, "v0", "Beat 0").length).toBe(MAX_LIKED - 1);
  });

  it("lists the picks' titles for the round, once each, capped, and sums them up for a tooltip", () => {
    expect(likedTitles([{ id: "a", title: "Night Drive" }, { id: "b", title: "night drive" }, { id: "c", title: "Cold Room" }])).toEqual(["Night Drive", "Cold Room"]);
    expect(likedTitles(Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, title: `Beat ${i}` }))).length).toBe(MAX_LIKED);
    expect(likedTitles([])).toEqual([]);
    expect(seedList(["A", "B"])).toBe("A, B");
    expect(seedList(["A", "B", "C", "D", "E"])).toBe("A, B, C +2");
    expect(seedList([])).toBe("");
  });

  it("lists the searches earlier rounds ran, once each, capped", () => {
    expect(searchesDone([{ queries: ["a", " b "] }, { queries: ["b", "", "c"] }])).toEqual(["a", "b", "c"]);
    expect(searchesDone(Array.from({ length: 9 }, (_, i) => ({ queries: Array.from({ length: 8 }, (_, j) => `q${i}-${j}`) }))).length).toBe(50);
    expect(searchesDone([])).toEqual([]);
  });

  it("matches a saved lead to a downloaded beat by title", () => {
    const beats = [
      { name: "[FREE] Dark Trap Type Beat - Night (prod. X)" },
      { name: "Night_Dark_Trap_Type_Beat_prod_X_FREE_128k" },
      { name: "Kick 808" },
      { name: "Sun" },
    ];
    expect(matchBeat({ title: '[FREE] Dark Trap Type Beat - "Night" (prod. X)' }, beats)).toBe(beats[0]);
    expect(matchBeat({ title: "Kick 808" }, beats)).toBe(beats[2]);
    // Containment only when the lengths are close: a converter's suffix…
    expect(matchBeat({ title: "Night Drive Dark Trap Beat" }, [{ name: "Night Drive Dark Trap Beat (128k)" }])).not.toBeNull();
    // …not a generic name inside a longer title (the W4 false positive).
    expect(matchBeat({ title: "[FREE] Dark Trap Type Beat - Night (prod. X)" }, [{ name: "dark trap type beat" }])).toBeNull();
    expect(matchBeat({ title: "Dark Trap Type Beat - Night" }, beats)).toBeNull();
    // Short keys only match exactly: "Sun" is not "Sunday Beat".
    expect(matchBeat({ title: "Sun" }, [{ name: "Sunday Beat" }])).toBeNull();
    expect(matchBeat({ title: "Something else entirely" }, beats)).toBeNull();
    expect(matchBeat({ title: "" }, beats)).toBeNull();
    expect(titleKey("Éclair_Prod (2024)!")).toBe("éclair prod 2024");
  });

  it("matches a decomposed (macOS) file name to a composed title", () => {
    const nfd = "Été Beat";
    const nfc = "Été Beat";
    expect(titleKey(nfd)).toBe(titleKey(nfc));
    expect(titleKey(nfd)).toBe("été beat");
    expect(matchBeat({ title: nfc }, [{ name: nfd }])).toEqual({ name: nfd });
  });

  it("lets the user's own link win over the name match", () => {
    const beats = [{ name: "Night", path: "/b/night.mp3" }, { name: "Other", path: "/b/other.mp3" }];
    expect(matchBeat({ title: "Night" }, beats)).toBe(beats[0]);
    expect(matchBeat({ title: "Night" }, beats, null)).toBeNull();
    expect(matchBeat({ title: "Night" }, beats, "/b/other.mp3")).toBe(beats[1]);
    // The linked file is gone from the scan: back to the name match.
    expect(matchBeat({ title: "Night" }, beats, "/b/gone.mp3")).toBe(beats[0]);
    expect(matchBeat({ title: "Elsewhere" }, beats, "/b/gone.mp3")).toBeNull();
  });

  it("normalises YouTube addresses so one video is one lead", () => {
    const watch = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    for (const u of ["https://youtu.be/dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?si=abc", "https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ", "https://www.youtube.com/shorts/dQw4w9WgXcQ", ` ${watch}&t=42s `]) {
      expect(canonicalUrl(u)).toBe(watch);
    }
    expect(leadHash(canonicalUrl("https://youtu.be/dQw4w9WgXcQ"))).toBe(leadHash(watch));
    expect(canonicalUrl(" https://www.beatstars.com/beat/night-123 ")).toBe("https://www.beatstars.com/beat/night-123");
  });

  describe("notes and lead links follow a moved beat", () => {
    const b = (path: string, sizeBytes: number) => ({ path, name: path.split("/").pop()!.replace(/\.[^.]+$/, ""), sizeBytes });
    const links = { beatNotes: { "/b/Untitled.mp3": "hook idea", "/b/kept.mp3": "x" }, beatNoteSizes: { "/b/Untitled.mp3": 1234, "/b/kept.mp3": 9 } };

    it("moves on the same name AND size, keeping a tombstone", () => {
      const next = relinkBeatNotes(links, [b("/b/kept.mp3", 9), b("/b/sub/Untitled.mp3", 1234)], true);
      expect(next?.beatNotes).toEqual({ "/b/sub/Untitled.mp3": "hook idea", "/b/kept.mp3": "x" });
      expect(next?.beatNoteSizes).toEqual({ "/b/sub/Untitled.mp3": 1234, "/b/kept.mp3": 9 });
      expect(next?.beatNoteMoves).toEqual({ "/b/Untitled.mp3": { to: "/b/sub/Untitled.mp3", size: 1234, text: "hook idea" } });
    });

    it("never guesses on the name or the size alone", () => {
      // Another "Untitled" of another size, a same-size file of another name.
      expect(relinkBeatNotes(links, [b("/b/kept.mp3", 9), b("/b/other/Untitled.mp3", 999), b("/b/renamed.mp3", 1234)], true)).toBeNull();
      // Two files fit: no guess.
      expect(relinkBeatNotes(links, [b("/b/kept.mp3", 9), b("/b/x/Untitled.mp3", 1234), b("/b/y/Untitled.mp3", 1234)], true)).toBeNull();
      // A noted beat is never a target.
      const both = { beatNotes: { "/b/Untitled.mp3": "a", "/b/x/Untitled.mp3": "b" }, beatNoteSizes: { "/b/Untitled.mp3": 1, "/b/x/Untitled.mp3": 1 } };
      expect(relinkBeatNotes(both, [b("/b/x/Untitled.mp3", 1)], true)).toBeNull();
    });

    it("does nothing after a capped scan or with a beats folder unreachable", () => {
      // `complete` is false for both (useDigger: !capped && !unreachable).
      expect(relinkBeatNotes(links, [b("/b/kept.mp3", 9), b("/b/sub/Untitled.mp3", 1234)], false)).toBeNull();
    });

    it("restores the note when the old path comes back, forgets the tombstone once confirmed", () => {
      const moved = relinkBeatNotes(links, [b("/b/kept.mp3", 9), b("/b/sub/Untitled.mp3", 1234)], true)!;
      // The old file is back (it was a copy, or a drive came back): its note too.
      const back = relinkBeatNotes(moved, [b("/b/kept.mp3", 9), b("/b/sub/Untitled.mp3", 1234), b("/b/Untitled.mp3", 1234)], false);
      expect(back?.beatNotes["/b/Untitled.mp3"]).toBe("hook idea");
      expect(back?.beatNotes["/b/sub/Untitled.mp3"]).toBe("hook idea");
      expect(back?.beatNoteMoves).toEqual({});
      // A partial scan never confirms; a complete one that sees the new path does.
      expect(relinkBeatNotes(moved, [b("/b/sub/Untitled.mp3", 1234)], false)).toBeNull();
      expect(relinkBeatNotes(moved, [b("/b/kept.mp3", 9), b("/b/sub/Untitled.mp3", 1234)], true)?.beatNoteMoves).toEqual({});
    });

    it("moves a hand-made lead link with the beat, even without a note", () => {
      const l = { leadBeats: { h1: "/b/Night.mp3", h2: null }, beatNoteSizes: { "/b/Night.mp3": 77 } };
      const next = relinkBeatNotes(l, [b("/b/2026/Night.mp3", 77)], true);
      expect(next?.leadBeats).toEqual({ h1: "/b/2026/Night.mp3", h2: null });
      expect(next?.beatNoteMoves["/b/Night.mp3"]).toEqual({ to: "/b/2026/Night.mp3", size: 77 });
      // Sizes are learnt for linked beats too, so the next move can follow.
      expect(relinkBeatNotes({ leadBeats: { h1: "/b/Night.mp3" } }, [b("/b/Night.mp3", 77)], true)?.beatNoteSizes).toEqual({ "/b/Night.mp3": 77 });
    });

    it("leaves everything alone when nothing moved", () => {
      expect(relinkBeatNotes(links, [b("/b/Untitled.mp3", 1234), b("/b/kept.mp3", 9)], true)).toBeNull();
      // A noted beat missing from the scan keeps its note and its last size.
      expect(relinkBeatNotes(links, [b("/b/kept.mp3", 9)], true)).toBeNull();
      expect(relinkBeatNotes({}, [], true)).toBeNull();
    });
  });

  it("sorts beats by name, tempo or key, unmeasured last", () => {
    const b = (path: string, name: string) => ({ path, name, folder: "", sizeBytes: 1, modifiedAtMs: 0 });
    const beats = [b("1", "b"), b("2", "a"), b("3", "c")];
    const f = (bpm: number | null, key: string | null) => ({ name: "", durationSec: 1, bpm, bpmSource: null, key, loudnessDb: null, hitsPerSec: null });
    const facts = { "1": f(140, "Am"), "2": null, "3": f(90, "C") };
    expect(sortBeats(beats, facts, "newest")).toBe(beats);
    expect(sortBeats(beats, facts, "name").map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect(sortBeats(beats, facts, "bpm").map((x) => x.path)).toEqual(["3", "1", "2"]);
    expect(sortBeats(beats, facts, "key").map((x) => x.path)).toEqual(["1", "3", "2"]);
  });

  it("falls back to searches from the beat names when the dig wrote none", () => {
    const dig = { analysis: { queries: [] as string[] } };
    expect(withFallbackQueries(dig, ["[FREE] Dark Trap Type Beat - Night", "dark trap type beat night", "Cold Room"]).analysis.queries).toEqual(["Dark Trap Type Beat Night", "Cold Room type beat"]);
    const has = { analysis: { queries: ["x"] } };
    expect(withFallbackQueries(has, ["Cold Room"])).toBe(has);
    expect(nameQueries(["", "[FREE]"])).toEqual([]);
  });

  it("reads a kept dig back, keeping only well-formed fields", () => {
    const raw = {
      dig: {
        model: "m",
        audioSent: false,
        beats: [{ name: "Night", durationSec: 100, bpm: 140, bpmSource: "name", key: "Am", loudnessDb: -10, hitsPerSec: 2 }],
        analysis: { summary: "Dark", traits: ["808"], tempo: "140", queries: ["q"] },
        web: [{ url: "https://www.beatstars.com/a", site: "beatstars.com", text: "A", resolved: true }, { url: "javascript:alert(1)", site: "x", text: "bad", resolved: true }],
        webSearches: [],
        webError: null,
      },
      dugFor: ["/b/night.mp3"],
      rounds: [{ links: [], queries: ["q2"], seeds: [] }],
      roundResults: [{ query: "q", videos: [{ id: "dQw4w9WgXcQ", title: "T", channel: "C", publishedAt: "2024", url: "https://evil.example", thumbnail: "https://evil.example/x.jpg" }, { id: "bad" }] }],
      liked: [{ id: "dQw4w9WgXcQ", title: "T" }],
      shownRound: 9,
      webQuery: "q",
    };
    const k = restoreDig(raw)!;
    expect(k.dig.web.map((l) => l.url)).toEqual(["https://www.beatstars.com/a"]);
    expect(k.roundResults[0].videos).toEqual([{ id: "dQw4w9WgXcQ", title: "T", channel: "C", publishedAt: "2024", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" }]);
    expect(k.shownRound).toBe(1);
    expect(k.dig.failed).toEqual([]);
    expect(k.dig.beats[0].bpm).toBe(140);
    expect(restoreDig(null)).toBeNull();
    expect(restoreDig({ dig: { analysis: { summary: "" } } })).toBeNull();
    expect(restoreDig([1])).toBeNull();
  });

  it("frames the website's player page with a strict video id only", () => {
    expect(embedUrl("dQw4w9WgXcQ")).toBe("https://www.hi-vo.fr/embed.html?v=dQw4w9WgXcQ");
    expect(embedUrl("dQw4w9WgXcQ&autoplay=0")).toBeNull();
    expect(embedUrl("../x")).toBeNull();
    expect(embedUrl("")).toBeNull();
  });

  it("reads the video ID of YouTube links only", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://www.youtube.com/results?search_query=beat")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=too-short")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ/../x")).toBeNull();
    expect(youtubeId("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeId("https://www.beatstars.com/beat/night-123")).toBeNull();
    expect(youtubeId("javascript:alert(1)")).toBeNull();
    expect(youtubeId("")).toBeNull();
  });
});

describe("digger leads", () => {
  it("hashes a url like the Rust side (FNV-1a 32-bit, 8 lowercase hex digits)", () => {
    // Same vectors as src-tauri/src/leads.rs.
    expect(leadHash("https://youtu.be/dQw4w9WgXcQ")).toBe("8fd69810");
    expect(leadHash("  https://youtu.be/dQw4w9WgXcQ \n")).toBe("8fd69810");
    expect(leadHash("a")).toBe("e40c292c");
    expect(leadHash("")).toBe("811c9dc5");
    expect(leadHash("prod é")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("carries the dig's summary and traits, and only the result's own bpm and key", () => {
    // The picked beat's measured 140 / Am is never written onto the lead (W1).
    const dig = { analysis: { summary: " Dark, slow trap. ", traits: ["dark", " 808 slides "], tempo: "140 BPM" }, beats: [{ bpm: 140, key: "Am" }] };
    expect(leadFacts(dig, "Night - Dark Trap Type Beat")).toEqual({ summary: "Dark, slow trap.", traits: ["140 BPM", "dark", "808 slides"], bpm: null, key: null });
    expect(leadFacts(dig, "Night | 92 BPM | F#m")).toMatchObject({ bpm: 92, key: "F#m" });
    expect(leadFacts({ analysis: { summary: "", traits: [], tempo: "" } }, "")).toEqual({ summary: null, traits: [], bpm: null, key: null });
    expect(leadFacts(null, "Cold Room 140bpm (C minor)")).toEqual({ summary: null, traits: [], bpm: 140, key: "Cm" });
  });

  it("reads a tempo and a key from a title when it says them", () => {
    expect(titleFacts("[FREE] Dark Trap Type Beat - Night 140 BPM")).toEqual({ bpm: 140, key: null });
    expect(titleFacts("Night (bpm 92) Bb minor")).toEqual({ bpm: 92, key: "Bbm" });
    expect(titleFacts("Night | A Major | 2024")).toEqual({ bpm: null, key: "A" });
    expect(titleFacts("Night - Am - 150bpm")).toEqual({ bpm: 150, key: "Am" });
    expect(titleFacts("Beat 9000 bpm")).toEqual({ bpm: null, key: null });
    expect(titleFacts("Dark Trap Beat by Amber")).toEqual({ bpm: null, key: null });
    expect(titleFacts("make a major hit")).toEqual({ bpm: null, key: null });
  });

  it("builds the converter link from an https template with a {url} slot only", () => {
    const video = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1";
    expect(converterLink("https://example.com/convert?u={url}", video)).toBe(`https://example.com/convert?u=${encodeURIComponent(video)}`);
    expect(converterLink(" https://example.com/{url}/go?x={url} ", "https://a.b/c")).toBe("https://example.com/https%3A%2F%2Fa.b%2Fc/go?x=https%3A%2F%2Fa.b%2Fc");
    expect(converterLink("http://example.com/convert?u={url}", video)).toBeNull();
    // No slot: the page itself, and the address goes to the clipboard.
    expect(converterLink("https://example.com/convert", video)).toBe("https://example.com/convert");
    expect(converterNeedsPaste("https://example.com/convert")).toBe(true);
    expect(converterNeedsPaste("https://example.com/convert?u={url}")).toBe(false);
    expect(converterNeedsPaste("http://example.com/convert")).toBe(false);
    expect(converterNeedsPaste(undefined)).toBe(false);
    expect(converterLink("javascript:{url}", video)).toBeNull();
    expect(converterLink(undefined, video)).toBeNull();
    expect(converterLink("", video)).toBeNull();
  });
});
