// Keeps the newest intent as the activity's own (setIntent in onNewIntent).
// A hivo://pair link or a share that arrives while the app is starting comes
// through onNewIntent before React Native is up, and React Native drops it
// there; getIntent() still held the plain launch, so Linking.getInitialURL()
// and HivoShare's takeShared() never saw it (device pass, 2026-11-04). With
// this, both read the newest one once the app has loaded. A share handled by
// HivoShare's OnNewIntent is marked consumed on that same Intent object, so
// takeShared() never takes it twice.
const { withMainActivity } = require("expo/config-plugins");

const MARK = "// hivo: keep the newest intent (plugins/withLatestIntent.js)";

const METHOD = `
  ${MARK}
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }
`;

/** MainActivity.kt's source with the override (once) and its import. */
function applyLatestIntent(src) {
  if (src.includes(MARK)) return src;
  if (/override fun onNewIntent\s*\(/.test(src)) throw new Error("withLatestIntent: MainActivity already overrides onNewIntent; merge by hand");
  let out = src;
  if (!/^import android\.content\.Intent$/m.test(out)) out = out.replace(/^(package [^\n]+\n)/, "$1import android.content.Intent\n");
  const end = out.lastIndexOf("}");
  if (end < 0) throw new Error("withLatestIntent: MainActivity class not found");
  return out.slice(0, end) + METHOD + out.slice(end);
}

const withLatestIntent = (config) =>
  withMainActivity(config, (c) => {
    if (c.modResults.language !== "kt") throw new Error("withLatestIntent: expected a Kotlin MainActivity");
    c.modResults.contents = applyLatestIntent(c.modResults.contents);
    return c;
  });

module.exports = withLatestIntent;
module.exports.applyLatestIntent = applyLatestIntent;
module.exports.MARK = MARK;
