// The Digger's converter link (Settings → Digger). Hivo never calls these
// sites and never downloads audio: the link opens in the user's browser.
// Hivo names no converter site: the user sets their own https link.
// `templateFromExample` makes the `{url}` slot easy to get right: the
// address of a converter page *after* a video link was pasted on it usually
// carries that link (plain or percent-encoded); swapping it for `{url}`
// gives the template, whatever the site.

/** A YouTube video link as it appears plain inside another address:
 * watch?v=, youtu.be/ or /shorts/ with the 11-char id. Nothing after the id
 * is claimed: a `&f=mp3` there is the site's own parameter. */
const VIDEO_LINK = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[A-Za-z0-9_-]{11}/;
/** The same, percent-encoded (`encodeURIComponent`), where the link's own
 * `%26t%3D…` parameters are unmistakably part of it. */
const VIDEO_LINK_ENCODED =
  /https%3A%2F%2F(?:www\.|m\.)?(?:youtube\.com%2Fwatch%3Fv%3D[A-Za-z0-9_-]{11}(?:%26[A-Za-z0-9_%.-]*)*|youtu\.be%2F[A-Za-z0-9_-]{11}(?:%3F[A-Za-z0-9_%.-]*)?|youtube\.com%2Fshorts%2F[A-Za-z0-9_-]{11})/i;

/** The `{url}` template a converter page's address implies, or null when
 * no video link is inside it. The address is kept as typed apart from the
 * link, plain or percent-encoded. */
export function templateFromExample(address: string): string | null {
  const a = address.trim();
  if (!a.startsWith("https://") || a.includes("{url}")) return null;
  const plain = a.match(VIDEO_LINK);
  if (plain) return a.replace(plain[0], "{url}");
  const encoded = a.match(VIDEO_LINK_ENCODED);
  if (encoded) return a.replace(encoded[0], "{url}");
  // Encoded another way (e.g. only ":" and "/" escaped): rebuild from the
  // decoded form, which the site accepts too.
  let decoded: string;
  try {
    decoded = decodeURIComponent(a);
  } catch {
    return null;
  }
  const inside = decoded.match(VIDEO_LINK);
  return inside ? decoded.replace(inside[0], "{url}") : null;
}

/** What to save for what the user typed: a template from an example
 * address, else the address itself. There are no built-in sites: the
 * converter is whatever https link the user sets (docs/GUARDRAILS.md,
 * Digger exception: links only). A template saved before the presets were
 * removed is a plain string and keeps working as is. */
export function converterTemplateFor(address: string): { template: string; recognized: "example" | null } {
  const a = address.trim();
  const fromExample = templateFromExample(a);
  if (fromExample) return { template: fromExample, recognized: "example" };
  return { template: a, recognized: null };
}
