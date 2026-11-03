import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { C } from "../src/tokens.ts";

const require = createRequire(import.meta.url);
const { applyDialogStyles, applyDialogColors, COLORS, DRAWABLE_XML } = require("./withDarkDialogs.js");
const appJson = require("../app.json");

// The shape `expo prebuild` generates (SDK 58), trimmed.
const styles = () => ({
  resources: {
    style: [
      {
        $: { name: "AppTheme", parent: "Theme.AppCompat.DayNight.NoActionBar" },
        item: [{ $: { name: "android:windowBackground" }, _: "@color/activityBackground" }],
      },
      { $: { name: "Theme.App.SplashScreen", parent: "Theme.SplashScreen" }, item: [] },
    ],
  },
});
const find = (s, name) => s.resources.style.find((x) => x.$.name === name);
const value = (style, name) => style.item.find((i) => i.$.name === name)?._;

describe("withDarkDialogs", () => {
  it("points AppTheme at a fixed dark dialog theme (not DayNight), keeping its items", () => {
    const s = applyDialogStyles(styles());
    const app = find(s, "AppTheme");
    expect(value(app, "alertDialogTheme")).toBe("@style/Theme.Hivo.Dialog");
    expect(value(app, "android:alertDialogTheme")).toBe("@style/Theme.Hivo.Dialog");
    expect(value(app, "android:windowBackground")).toBe("@color/activityBackground");
    const dialog = find(s, "Theme.Hivo.Dialog");
    expect(dialog.$.parent).toBe("Theme.AppCompat.Dialog.Alert");
    expect(value(dialog, "android:windowBackground")).toBe("@drawable/hivo_dialog_background");
  });
  it("sets the action (last button) apart from Cancel", () => {
    const s = applyDialogStyles(styles());
    const dialog = find(s, "Theme.Hivo.Dialog");
    const positive = find(s, value(dialog, "buttonBarPositiveButtonStyle").replace("@style/", ""));
    const negative = find(s, value(dialog, "buttonBarNegativeButtonStyle").replace("@style/", ""));
    expect(value(positive, "android:textColor")).not.toBe(value(negative, "android:textColor"));
  });
  it("is idempotent", () => {
    const once = applyDialogStyles(styles());
    const twice = applyDialogStyles(applyDialogStyles(styles()));
    expect(twice).toEqual(once);
    const c = applyDialogColors(applyDialogColors({ resources: { color: [{ $: { name: "colorPrimary" }, _: "#023c69" }] } }));
    expect(c.resources.color).toHaveLength(1 + Object.keys(COLORS).length);
  });
  it("uses the app's tokens", () => {
    expect(COLORS.hivo_dialog_surface).toBe(C.panel);
    expect(COLORS.hivo_dialog_rule).toBe(C.ruleStrong);
    expect(COLORS.hivo_dialog_title).toBe(C.cream);
    expect(COLORS.hivo_dialog_text).toBe(C.body);
    expect(COLORS.hivo_dialog_muted).toBe(C.engrave);
    expect(DRAWABLE_XML).toContain('android:radius="4dp"');
  });
  it("is registered in app.json", () => {
    expect(appJson.expo.plugins).toContain("./plugins/withDarkDialogs");
  });
});
