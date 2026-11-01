// Turning the updater's raw failures into something a person can act on.
// Pure, so it stays testable without the Tauri plugins.

/** macOS said the app bundle can't be written: Hivo runs from the mounted
 * disk image, or from the read-only copy Gatekeeper makes of a downloaded,
 * unnotarized app ("App Translocation"). Moving it to Applications with
 * Finder fixes both. */
export function isReadOnlyInstallError(message: string | undefined): boolean {
  if (!message) return false;
  return /read-only file system|os error 30\b|EROFS/i.test(message);
}

/** What kind of failure the updater reported, to say it in plain words:
 * "readOnly" (see above), "network" (the update server couldn't be reached:
 * offline, DNS, timeout, TLS…) or "other" (the raw detail stays available). */
export type UpdateErrorKind = "readOnly" | "network" | "other";

export function updateErrorKind(message: string | undefined): UpdateErrorKind {
  if (isReadOnlyInstallError(message)) return "readOnly";
  if (!message) return "other";
  return /error sending request|timed? ?out|timeout|dns|resolve|connect|connection|network|offline|unreachable|no route|tls|certificate|fetch|os error (51|60|61|64|65|10051|10060|10061|11001)\b/i.test(message)
    ? "network"
    : "other";
}
