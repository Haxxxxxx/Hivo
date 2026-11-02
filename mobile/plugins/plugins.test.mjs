import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { versionCode } = require("./versionCode.js");
const { applyReleaseSigning } = require("./withReleaseSigning.js");
const { addQueries, addMlkitDependency } = require("./withPlayServicesVisibility.js");

describe("withPlayServicesVisibility", () => {
  const base = () => ({ manifest: { application: [{ "meta-data": [] }] } });
  it("declares the Play Store and Play services, once", () => {
    const m = addQueries(addQueries(base()));
    const names = m.manifest.queries[0].package.map((p) => p.$["android:name"]);
    expect(names).toEqual(["com.android.vending", "com.google.android.gms"]);
  });
  it("can find the camera app, once, keeping other intent queries", () => {
    const m = base();
    m.manifest.queries = [{ intent: [{ action: [{ $: { "android:name": "android.intent.action.VIEW" } }] }] }];
    const out = addQueries(addQueries(m));
    const actions = out.manifest.queries[0].intent.map((i) => i.action[0].$["android:name"]);
    expect(actions).toEqual(["android.intent.action.VIEW", "android.media.action.STILL_IMAGE_CAMERA"]);
  });
  it("asks Play services to fetch the barcode UI module at install, keeping other values", () => {
    const m = base();
    m.manifest.application[0]["meta-data"].push({ $: { "android:name": "com.google.mlkit.vision.DEPENDENCIES", "android:value": "ocr" } });
    const out = addMlkitDependency(addMlkitDependency(m));
    const md = out.manifest.application[0]["meta-data"].filter((x) => x.$["android:name"] === "com.google.mlkit.vision.DEPENDENCIES");
    expect(md).toHaveLength(1);
    expect(md[0].$["android:value"]).toBe("ocr,barcode_ui");
    expect(addMlkitDependency(base()).manifest.application[0]["meta-data"][0].$["android:value"]).toBe("barcode_ui");
  });
});
const appConfig = require("../app.config.js");
const appJson = require("../app.json");

// The shape `expo prebuild` generates (SDK 58), trimmed.
const GRADLE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}`;

describe("versionCode", () => {
  it("is major*10000 + minor*100 + patch", () => {
    expect(versionCode("0.6.0")).toBe(600);
    expect(versionCode("0.6.1")).toBe(601);
    expect(versionCode("1.2.3")).toBe(10203);
    expect(versionCode("0.10.0")).toBeGreaterThan(versionCode("0.9.99"));
  });
  it("refuses what it can't encode", () => {
    expect(() => versionCode("0.6")).toThrow();
    expect(() => versionCode("0.6.0-beta")).toThrow();
    expect(() => versionCode("0.100.0")).toThrow();
    expect(() => versionCode("0.0.0")).toThrow();
  });
});

describe("app.config.js", () => {
  const base = { config: appJson.expo };
  it("derives the versionCode from app.json's version", () => {
    const c = appConfig(base);
    expect(c.version).toBe(appJson.expo.version);
    expect(c.android.versionCode).toBe(versionCode(appJson.expo.version));
    expect(c.android.package).toBe("fr.hivo.mobile");
    expect(c.plugins).toContain("./plugins/withReleaseSigning");
  });
  it("marks Play builds by HIVO_DISTRIBUTION", () => {
    const prev = process.env.HIVO_DISTRIBUTION;
    try {
      // No flag (or an unknown one): a dev build, which never checks for updates.
      delete process.env.HIVO_DISTRIBUTION;
      expect(appConfig(base).extra.distribution).toBe("dev");
      process.env.HIVO_DISTRIBUTION = "website";
      expect(appConfig(base).extra.distribution).toBe("dev");
      process.env.HIVO_DISTRIBUTION = "direct";
      expect(appConfig(base).extra.distribution).toBe("direct");
      process.env.HIVO_DISTRIBUTION = "play";
      expect(appConfig(base).extra.distribution).toBe("play");
    } finally {
      if (prev === undefined) delete process.env.HIVO_DISTRIBUTION;
      else process.env.HIVO_DISTRIBUTION = prev;
    }
  });
});

describe("withReleaseSigning", () => {
  it("adds a release signing config read from the environment", () => {
    const out = applyReleaseSigning(GRADLE);
    expect(out).toMatch(/debug \{[^}]*\}\s*release \{ \/\/ hivo-release-signing/);
    expect(out).toContain("System.getenv('HIVO_UPLOAD_STORE_FILE')");
    expect(out).toContain("signingConfig(System.getenv('HIVO_UPLOAD_STORE_FILE') ? signingConfigs.release : System.getenv('HIVO_UNSIGNED') == '1' ? null : System.getenv('CI') ?");
    // On CI, no upload key and no explicit unsigned build is an error, never the debug key.
    expect(out).toMatch(/System\.getenv\('CI'\) \? \{ throw new GradleException\([^)]*\) \}\(\) : signingConfigs\.debug\)/);
    // The debug build type keeps the debug key.
    expect(out).toMatch(/debug \{\s*signingConfig signingConfigs\.debug\s*\}/);
    // No secret or path in the generated file.
    expect(out).not.toMatch(/\.jks/);
  });
  it("is idempotent", () => {
    const once = applyReleaseSigning(GRADLE);
    expect(applyReleaseSigning(once)).toBe(once);
  });
  it("fails loudly when the template changes", () => {
    expect(() => applyReleaseSigning("android { }")).toThrow(/signingConfigs/);
  });
});

describe("expo-audio config", () => {
  const audio = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-audio")[1];
  it("records in a microphone foreground service, and declares no other service type", () => {
    // docs/PLAY-CONSOLE.md declares only the microphone type to Play.
    expect(audio.enableBackgroundRecording).toBe(true);
    expect(audio.enableBackgroundPlayback).toBe(false);
  });
});
