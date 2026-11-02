import { describe, expect, it } from "vitest";
import { CHECK_EVERY_MS, checkDue, checksForDistribution, compareSemver, desktopIsOlder, MANIFEST_URL, manualCheck, parseSemver, pickUpdate, PLAY_URL, RELEASES_BASE } from "./update";

const apk = `${RELEASES_BASE}v0.6.1/Hivo-0.6.1-android-arm64.apk`;

describe("semver", () => {
  it("parses x.y.z with an optional v", () => {
    expect(parseSemver("0.6.0")).toEqual([0, 6, 0]);
    expect(parseSemver("v1.20.3")).toEqual([1, 20, 3]);
    expect(parseSemver(" 0.6.0 ")).toEqual([0, 6, 0]);
  });
  it("refuses anything else", () => {
    for (const v of ["0.6", "0.6.0-beta.1", "a.b.c", "", "0.6.0.1", null, 6, undefined]) expect(parseSemver(v)).toBeNull();
  });
  it("compares numerically, not as text", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("0.6.0", "0.6.1")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("0.6.0", "v0.6.0")).toBe(0);
    expect(compareSemver("0.6.0", "nope")).toBeNull();
  });
});

describe("pickUpdate", () => {
  it("offers a newer version", () => {
    expect(pickUpdate({ version: "0.6.1", apk, sha256: "ab", notes: "" }, "0.6.0", null)).toEqual({ version: "0.6.1", apk });
  });
  it("stays quiet for the same or an older version", () => {
    expect(pickUpdate({ version: "0.6.0", apk }, "0.6.0", null)).toBeNull();
    expect(pickUpdate({ version: "0.5.9", apk }, "0.6.0", null)).toBeNull();
  });
  it("stays quiet for a dismissed version, not for a later one", () => {
    expect(pickUpdate({ version: "0.6.1", apk }, "0.6.0", "0.6.1")).toBeNull();
    expect(pickUpdate({ version: "0.6.2", apk: apk.replace(/0\.6\.1/g, "0.6.2") }, "0.6.0", "0.6.1")).not.toBeNull();
  });
  it("only links to an APK in the releases bucket", () => {
    for (const bad of [
      "https://example.com/Hivo.apk",
      `${RELEASES_BASE}v0.6.1/Hivo.exe`,
      `${RELEASES_BASE}../other/Hivo.apk`,
      `${RELEASES_BASE}v0.6.1/Hivo.apk?x=1`,
      `http://chrbpaoljulntuvousnz.supabase.co/storage/v1/object/public/releases/Hivo.apk`,
    ]) {
      expect(pickUpdate({ version: "0.6.1", apk: bad }, "0.6.0", null)).toBeNull();
    }
  });
  it("ignores malformed manifests", () => {
    for (const m of [null, "0.6.1", [], {}, { version: 7, apk }, { version: "0.6.1" }, { version: "latest", apk }]) {
      expect(pickUpdate(m, "0.6.0", null)).toBeNull();
    }
  });
  it("reads the manifest from the bucket root", () => {
    expect(MANIFEST_URL).toBe(`${RELEASES_BASE}mobile-latest.json`);
  });
});

describe("desktopIsOlder (the computer's Hivo vs this phone's)", () => {
  it("compares major.minor only, and says nothing when a version is unknown", () => {
    expect(desktopIsOlder("0.5.9", "0.6.0")).toBe(true);
    expect(desktopIsOlder("0.6.0", "1.0.0")).toBe(true);
    expect(desktopIsOlder("0.6.1", "0.6.4")).toBe(false);
    expect(desktopIsOlder("0.7.0", "0.6.4")).toBe(false);
    expect(desktopIsOlder(undefined, "0.6.4")).toBe(false);
    expect(desktopIsOlder("0.6.0", "dev")).toBe(false);
  });
});

describe("checkDue", () => {
  const now = 1_800_000_000_000;
  it("checks once a day", () => {
    expect(checkDue(null, now)).toBe(true);
    expect(checkDue(now - 1000, now)).toBe(false);
    expect(checkDue(now - CHECK_EVERY_MS, now)).toBe(true);
  });
  it("checks again when the clock went back", () => {
    expect(checkDue(now + 60_000, now)).toBe(true);
    expect(checkDue(Number.NaN, now)).toBe(true);
  });
});

describe("manualCheck", () => {
  it("offers a newer version, even one dismissed with Later", () => {
    expect(manualCheck({ version: "0.6.1", apk }, "0.6.0")).toEqual({ kind: "update", update: { version: "0.6.1", apk } });
  });
  it("says this is the latest otherwise, a missing manifest included", () => {
    expect(manualCheck({ version: "0.6.0", apk }, "0.6.0")).toEqual({ kind: "latest", version: "0.6.0" });
    expect(manualCheck(null, "0.6.0")).toEqual({ kind: "latest", version: "0.6.0" });
    expect(manualCheck({ version: "0.7.0", apk: "https://example.com/Hivo.apk" }, "0.6.0")).toEqual({ kind: "latest", version: "0.6.0" });
  });
  it("points Play builds at the app's own Play page", () => {
    expect(PLAY_URL).toBe("https://play.google.com/store/apps/details?id=fr.hivo.mobile");
  });
});

describe("checksForDistribution", () => {
  it("checks only builds explicitly marked direct (fails closed)", () => {
    expect(checksForDistribution("direct")).toBe(true);
    for (const d of ["play", "dev", "", undefined, null, 1]) expect(checksForDistribution(d)).toBe(false);
  });
});
