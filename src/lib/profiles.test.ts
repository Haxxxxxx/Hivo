import { describe, expect, it } from "vitest";
import { addLink, confirmLink, linkVerified, mergeLinks, mergeProfile, mergeSpotify, removeLink } from "./profiles";
import type { PlatformLink, SpotifyDetails } from "../types";

const link = (platform: string, id: string, source: PlatformLink["source"], verified?: boolean): PlatformLink => ({
  platform,
  label: platform,
  category: "streaming",
  url: `https://example.com/${platform}/${id}`,
  id,
  source,
  ...(verified === undefined ? {} : { verified }),
});

describe("profiles", () => {
  it("counts by-name ids only once confirmed, older stored ones included", () => {
    expect(linkVerified(link("spotify", "1", "musicbrainz"))).toBe(true);
    expect(linkVerified(link("deezer", "1", "deezer", false))).toBe(false);
    expect(linkVerified(link("deezer", "1", "deezer"))).toBe(false);
    expect(linkVerified(link("apple-music", "1", "itunes"))).toBe(false);
    expect(linkVerified(link("deezer", "1", "deezer", true))).toBe(true);
    expect(linkVerified(link("instagram", "x", "manual", true))).toBe(true);
    const confirmed = confirmLink([link("deezer", "7", "deezer", false)], link("deezer", "7", "deezer", false));
    expect(linkVerified(confirmed[0])).toBe(true);
  });

  it("merges a new lookup instead of overwriting", () => {
    const mine = link("deezer", "7", "deezer", true);
    const hand = link("instagram", "me", "manual", true);
    const guess = link("apple-music", "5", "itunes", false);
    const found = [link("spotify", "s", "musicbrainz", true), link("deezer", "8", "deezer", false), link("apple-music", "6", "itunes", false)];
    const merged = mergeLinks([mine, hand, guess], found);
    // The confirmed Deezer and the hand-added link stay; the old Apple guess gives way to the new one.
    expect(merged.map((l) => `${l.platform}:${l.id}`)).toEqual(["deezer:7", "instagram:me", "apple-music:6", "spotify:s"]);
    // The same link again keeps its confirmed state.
    expect(mergeLinks([mine], [link("deezer", "7", "deezer", false)])).toEqual([mine]);
  });

  it("keeps old Spotify numbers when the new answer has none", () => {
    const old: SpotifyDetails = { id: "a", followers: 10, popularity: 5, genres: ["rap"], imageUrl: "https://i.scdn.co/image/x" };
    const empty: SpotifyDetails = { id: "a", followers: null, popularity: null, genres: [], imageUrl: null };
    expect(mergeSpotify(old, empty)).toEqual(old);
    expect(mergeSpotify(old, null)).toBe(old);
    expect(mergeSpotify(old, { ...empty, id: "b" })).toEqual({ ...empty, id: "b" });
    expect(mergeSpotify(null, null)).toBeNull();
    const p = mergeProfile({ mbid: "m", links: [], spotify: old }, { mbid: null, links: [], spotify: null }, "2026-11-01");
    expect(p).toEqual({ mbid: "m", links: [], spotify: old, lookedUpAt: "2026-11-01" });
  });

  it("adds and removes links by hand", () => {
    const a = link("instagram", "me", "manual", true);
    expect(addLink([a], { ...a, label: "IG" })).toEqual([{ ...a, label: "IG" }]);
    expect(removeLink([a, link("x", "1", "musicbrainz")], a).map((l) => l.platform)).toEqual(["x"]);
  });
});
