// Builds the YouTube player for embed.html. Only a strict 11-character video id
// from the `v` query parameter ever reaches the player URL (same rule as
// `youtubeId()` in the app); anything else shows a short message instead.
(function () {
  var params = new URLSearchParams(location.search);
  // The page has no language path: an explicit ?hl=fr|en wins, else the
  // viewer's (the app's webview) language. Sets <html lang> for screen readers.
  var hl = params.get("hl");
  var fr = hl === "fr" || (hl !== "en" && /^fr\b/i.test(navigator.language || ""));
  document.documentElement.lang = fr ? "fr" : "en";
  var id = params.get("v");
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    var p = document.createElement("p");
    p.textContent = fr ? "Pas de vidéo." : "No video.";
    document.body.appendChild(p);
    return;
  }
  var PLAYER = "https://www.youtube-nocookie.com";
  // The phone app (react-native-webview) loads this page as its own and
  // wants to know when the video can't play (error 150: embedding disabled),
  // to say so and offer "Open in YouTube". Only there: the player reports its
  // state through YouTube's postMessage protocol (enablejsapi), and this page
  // forwards the error code and state, nothing else. The desktop is unchanged.
  var app = window.ReactNativeWebView;
  var frame = document.createElement("iframe");
  frame.src = PLAYER + "/embed/" + id + "?autoplay=1" + (app ? "&playsinline=1&enablejsapi=1&origin=" + encodeURIComponent(location.origin) : "");
  frame.allow = "autoplay; encrypted-media";
  frame.setAttribute("allowfullscreen", "");
  frame.title = "YouTube";
  document.body.appendChild(frame);
  if (!app) return;

  var send = function (msg) {
    msg.hivo = 1;
    app.postMessage(JSON.stringify(msg));
  };
  var heard = false;
  var tries = 0;
  var listen = function () {
    if (heard || tries++ > 40 || !frame.contentWindow) return;
    frame.contentWindow.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), PLAYER);
    setTimeout(listen, 250);
  };
  frame.addEventListener("load", listen);
  window.addEventListener("message", function (e) {
    if (e.origin !== PLAYER || e.source !== frame.contentWindow || typeof e.data !== "string" || e.data.length > 20000) return;
    var m;
    try {
      m = JSON.parse(e.data);
    } catch (err) {
      return;
    }
    if (!m || typeof m !== "object") return;
    heard = true;
    if (m.event === "onReady") send({ type: "ready" });
    else if (m.event === "onError" && typeof m.info === "number") send({ type: "error", code: m.info });
    else if (m.event === "onStateChange" && typeof m.info === "number") send({ type: "state", state: m.info });
  });
})();
