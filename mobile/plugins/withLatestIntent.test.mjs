import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { applyLatestIntent, MARK } = require("./withLatestIntent.js");
const appJson = require("../app.json");

// The shape `expo prebuild` generates (SDK 58), trimmed.
const MAIN = `package fr.hivo.mobile
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "main"

  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          return
      }
      super.invokeDefaultOnBackPressed()
  }
}
`;

describe("withLatestIntent", () => {
  it("adds onNewIntent with setIntent inside the class, and the import", () => {
    const out = applyLatestIntent(MAIN);
    expect(out).toMatch(/^package fr\.hivo\.mobile\nimport android\.content\.Intent\n/);
    expect(out).toMatch(/override fun onNewIntent\(intent: Intent\) \{\n {4}super\.onNewIntent\(intent\)\n {4}setIntent\(intent\)\n {2}\}\n\}\n$/);
  });

  it("runs once (prebuild without --clean)", () => {
    const once = applyLatestIntent(MAIN);
    expect(applyLatestIntent(once)).toBe(once);
    expect(once.split(MARK).length).toBe(2);
  });

  it("refuses to add a second onNewIntent", () => {
    const other = MAIN.replace("class MainActivity : ReactActivity() {", "class MainActivity : ReactActivity() {\n  override fun onNewIntent(intent: Intent) { super.onNewIntent(intent) }");
    expect(() => applyLatestIntent(other)).toThrow(/already overrides/);
  });

  it("is in app.json's plugins", () => {
    expect(appJson.expo.plugins).toContain("./plugins/withLatestIntent");
  });
});
