/** `s` cut to at most `max` UTF-16 units, never in the middle of an emoji:
 * half a surrogate pair turns into "\ud83d" in JSON, which the computer's
 * parser refuses (the whole push would fail). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
