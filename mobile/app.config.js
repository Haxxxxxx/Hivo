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

// - extra.feedback: where Settings → Send feedback goes (the crew backend's
//   submit_feedback function, the same as the desktop). From the build's
//   environment, the repository variables the desktop build uses too; only
//   the public anon key, never a service key. Absent: the panel says this
//   build can't send feedback.
const feedback = () => {
  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : undefined;
};

module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, versionCode: versionCode(config.version) },
  extra: { ...config.extra, distribution: distribution(process.env.HIVO_DISTRIBUTION), feedback: feedback() },
  plugins: [...(config.plugins ?? []), "./plugins/withReleaseSigning", "./plugins/withPlayServicesVisibility"],
});
