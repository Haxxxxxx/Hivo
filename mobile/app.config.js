// app.json holds the static config (and the version); this adds what is
// derived from it or from the build's environment.
// - android.versionCode from the version (plugins/versionCode.js).
// - extra.distribution: "play" when HIVO_DISTRIBUTION=play (the AAB for
//   Google Play), "direct" when HIVO_DISTRIBUTION=direct (the APK on the
//   website), else "dev". Play installs get their updates from Play, so only
//   "direct" builds check for a new APK; a build without the flag never does.
//   expo-constants re-reads this file at every Gradle build, so one prebuild
//   serves both builds.
// - the release signing plugin (plugins/withReleaseSigning.js).
// - Play Store / Play services visibility for the QR scanner
//   (plugins/withPlayServicesVisibility.js).
const { versionCode } = require("./plugins/versionCode");

/** @param {string | undefined} flag */
const distribution = (flag) => (flag === "play" || flag === "direct" ? flag : "dev");

module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, versionCode: versionCode(config.version) },
  extra: { ...config.extra, distribution: distribution(process.env.HIVO_DISTRIBUTION) },
  plugins: [...(config.plugins ?? []), "./plugins/withReleaseSigning", "./plugins/withPlayServicesVisibility"],
});
