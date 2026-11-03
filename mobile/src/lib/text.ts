/** `s` cut to at most `max` UTF-16 units, never in the middle of an emoji:
 * half a surrogate pair turns into "\ud83d" in JSON, which the computer's
 * parser refuses (the whole push would fail). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A message shown on its own, with its final period ("Try again in a few
 * seconds."); one that already ends a sentence is left as it is. The bare
 * text is also used after a colon, so the period is added here. */
export function sentence(s: string): string {
  const t = s.trimEnd();
  return !t || /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** A file name the phone and the computer both take: path separators and
 * control characters out, at most `max` characters with the extension kept
 * (a 130-character title used to lose its ".m4a"), never empty. */
export function safeFileName(name: string, max = 120): string {
  const clean = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim().replace(/^\.+/, "");
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(clean);
  const ext = m?.[2] ?? "";
  const stem = clip(m?.[1] ?? clean, Math.max(1, max - ext.length)).trim();
  return stem ? `${stem}${ext}` : ext ? `file${ext}` : "file";
}
