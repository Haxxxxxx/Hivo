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
  var frame = document.createElement("iframe");
  frame.src = "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1";
  frame.allow = "autoplay; encrypted-media";
  frame.setAttribute("allowfullscreen", "");
  frame.title = "YouTube";
  document.body.appendChild(frame);
})();
