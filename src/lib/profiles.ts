// People → Profiles: what a lookup stores on a person, merged with what is
// already there, and which links count. Pure helpers (ProfileLookup.tsx).

import type { LookupProfile, Person, PlatformLink, SpotifyDetails } from "../types";

/** A link whose id counts (Launch Kit, Copy ID): checked by MusicBrainz or
 * Spotify, added by hand, or confirmed by the user. Deezer / Apple Music
 * found by name only stay unverified until confirmed (a homonym is
 * possible). Links stored before the flag existed were all by-name ones
 * when they came from Deezer or iTunes. */
export function linkVerified(l: PlatformLink): boolean {
  if (l.verified !== undefined) return l.verified;
  return l.source !== "deezer" && l.source !== "itunes";
}

const sameLink = (a: PlatformLink, b: PlatformLink) => a.url.toLowerCase() === b.url.toLowerCase() || (a.platform === b.platform && !!a.id && a.id === b.id);

/**
 * The person's links after a new lookup: nothing is dropped, a link already
 * there stays as it is (confirmed or hand-added state kept), a confirmed or
 * hand-added link on a platform keeps its place against a new by-name
 * guess, and a new guess replaces an older unconfirmed one.
 */
export function mergeLinks(old: PlatformLink[], found: PlatformLink[]): PlatformLink[] {
  const out = old.slice();
  for (const l of found) {
    if (out.some((o) => sameLink(o, l))) continue;
    const i = out.findIndex((o) => o.platform === l.platform && o.platform !== "web" && o.platform !== "website");
    if (i < 0) {
      out.push(l);
      continue;
    }
    const mine = out[i];
    if (linkVerified(mine) && !linkVerified(l)) continue;
    if (!linkVerified(mine)) out[i] = l;
    else out.push(l);
  }
  return out;
}

/** Spotify details after a lookup: the new ones, with the old numbers kept
 * where Spotify now sends none (apps in development mode get empty artist
 * objects); the old details when the new lookup has none. */
export function mergeSpotify(old: SpotifyDetails | null | undefined, found: SpotifyDetails | null): SpotifyDetails | null {
  if (!found) return old ?? null;
  if (!old || old.id !== found.id) return found;
  return {
    id: found.id,
    followers: found.followers ?? old.followers,
    popularity: found.popularity ?? old.popularity,
    genres: found.genres.length ? found.genres : old.genres,
    imageUrl: found.imageUrl ?? old.imageUrl,
  };
}

/** The patch a picked lookup makes on a person: merged, never overwritten. */
export function mergeProfile(person: Pick<Person, "mbid" | "links" | "spotify">, profile: Pick<LookupProfile, "mbid" | "links" | "spotify">, now: string): Pick<Person, "mbid" | "links" | "spotify" | "lookedUpAt"> {
  return {
    mbid: profile.mbid ?? person.mbid ?? null,
    links: mergeLinks(person.links ?? [], profile.links),
    spotify: mergeSpotify(person.spotify, profile.spotify),
    lookedUpAt: now,
  };
}

/** `links` with one confirmed (it is this artist). */
export function confirmLink(links: PlatformLink[], target: PlatformLink): PlatformLink[] {
  return links.map((l) => (l === target || sameLink(l, target) ? { ...l, verified: true } : l));
}

/** `links` without one. */
export function removeLink(links: PlatformLink[], target: PlatformLink): PlatformLink[] {
  return links.filter((l) => !(l === target || sameLink(l, target)));
}

/** `links` with a hand-added one (replacing the same profile if there). */
export function addLink(links: PlatformLink[], link: PlatformLink): PlatformLink[] {
  return [...removeLink(links, link), link];
}
