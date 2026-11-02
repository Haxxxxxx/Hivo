// Signs the Android release build with the upload keystore when the
// HIVO_UPLOAD_* environment variables are set, leaves it unsigned with
// HIVO_UNSIGNED=1 (the release workflow, which signs it in a later step),
// and keeps the debug keystore otherwise, for local test builds only: with
// CI set and neither, the release build fails.
//
// The generated build.gradle reads the variables when Gradle runs, so no
// path or password ever lands in android/ (generated, git-ignored) or in git.
//   HIVO_UPLOAD_STORE_FILE      absolute path to the .jks / .keystore
//   HIVO_UPLOAD_STORE_PASSWORD  keystore password
//   HIVO_UPLOAD_KEY_ALIAS       key alias
//   HIVO_UPLOAD_KEY_PASSWORD    key password (defaults to the store password)
// CommonJS: Expo loads config plugins with require().

const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// hivo-release-signing";

const SIGNING_CONFIG = `
        release { ${MARK}
            def hivoStore = System.getenv('HIVO_UPLOAD_STORE_FILE')
            if (hivoStore) {
                def hivoStorePassword = System.getenv('HIVO_UPLOAD_STORE_PASSWORD')
                def hivoAlias = System.getenv('HIVO_UPLOAD_KEY_ALIAS')
                if (!hivoStorePassword || !hivoAlias) {
                    throw new GradleException('HIVO_UPLOAD_STORE_FILE is set: HIVO_UPLOAD_STORE_PASSWORD and HIVO_UPLOAD_KEY_ALIAS are required too')
                }
                if (!file(hivoStore).isFile()) {
                    throw new GradleException('HIVO_UPLOAD_STORE_FILE does not point at a file')
                }
                storeFile file(hivoStore)
                storePassword hivoStorePassword
                keyAlias hivoAlias
                keyPassword(System.getenv('HIVO_UPLOAD_KEY_PASSWORD') ?: hivoStorePassword)
            }
        }`;

// The release build type: the upload key when the variables are set;
// unsigned with HIVO_UNSIGNED=1 (the release workflow signs afterwards, in a
// step Gradle never sees); never the debug key on CI (CI set), so a missing
// secret fails the build instead of shipping a debug-signed release.
const RELEASE_SIGNING = `signingConfig(System.getenv('HIVO_UPLOAD_STORE_FILE') ? signingConfigs.release : System.getenv('HIVO_UNSIGNED') == '1' ? null : System.getenv('CI') ? { throw new GradleException('CI release build without HIVO_UPLOAD_* or HIVO_UNSIGNED=1, refusing to sign it with the debug key') }() : signingConfigs.debug) ${MARK}`;

/** @param {string} gradle the generated android/app/build.gradle */
function applyReleaseSigning(gradle) {
  if (gradle.includes(MARK)) return gradle;

  // 1. A `release` signing config next to the generated `debug` one.
  const debugBlock = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/;
  if (!debugBlock.test(gradle)) throw new Error("withReleaseSigning: signingConfigs { debug { … } } not found in build.gradle");
  let out = gradle.replace(debugBlock, `$1${SIGNING_CONFIG}`);

  // 2. The release build type uses it when the variables are set.
  const releaseType = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!releaseType.test(out)) throw new Error("withReleaseSigning: the release build type's signingConfig was not found in build.gradle");
  out = out.replace(releaseType, `$1${RELEASE_SIGNING}`);
  return out;
}

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== "groovy") throw new Error("withReleaseSigning: expected a Groovy build.gradle");
    c.modResults.contents = applyReleaseSigning(c.modResults.contents);
    return c;
  });

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
