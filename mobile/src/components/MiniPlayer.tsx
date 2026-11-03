import { useEffect, useMemo, useState } from "react";
import { AppState, Keyboard, Linking, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest, WebViewOpenWindowEvent } from "react-native-webview/lib/WebViewTypes";
import { lang, tr } from "../lib/i18n";
import { externalUrl, fromPlayerPage, navDecision, parsePlayerMessage, playerUrl, problemFor, type PlayerProblem } from "../lib/youtube";
import { T } from "../strings";
import { C, RADIUS } from "../theme";
import { Button, Led, Spinner } from "./ui";

/** The strip's video, 16:9. */
const SMALL_H = 108;

/**
 * The docked mini player of the note screen: YouTube's own embed
 * (youtube-nocookie.com) inside the website's embed.html, play only. It
 * plays while mounted: closing it, leaving the screen or sending the app to
 * the background unmounts the WebView, which stops it. Big (full width) or a
 * strip next to its buttons; it shrinks to the strip when the keyboard
 * comes up, so the note stays in view.
 */
export function MiniPlayer({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  const t = tr(T);
  const page = useMemo(() => playerUrl(videoId, lang()), [videoId]);
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  const [big, setBig] = useState(true);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<{ kind: PlayerProblem; code: number } | null>(null);
  /** Bumped by Retry: a fresh WebView. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const kb = Keyboard.addListener("keyboardDidShow", () => setBig(false));
    // No background play: the player goes when the app does.
    const app = AppState.addEventListener("change", (s) => {
      if (s === "background") onClose();
    });
    return () => {
      kb.remove();
      app.remove();
    };
  }, [onClose]);

  const openOutside = (url: string) => void Linking.openURL(url).catch(() => {});

  function onShouldStart(req: ShouldStartLoadRequest): boolean {
    if (!page) return false;
    // Android only reports the main frame through this; frames are kept on
    // YouTube's hosts by embed.html's CSP (frame-src) and navDecision.
    const d = navDecision(req.url, req.isTopFrame ?? true, page);
    if (d === "external") openOutside(externalUrl(req.url));
    return d === "allow";
  }

  function onOpenWindow(e: WebViewOpenWindowEvent) {
    if (!page) return;
    const url = e.nativeEvent.targetUrl;
    if (navDecision(url, true, page) === "external") openOutside(externalUrl(url));
  }

  function onMessage(e: WebViewMessageEvent) {
    if (!fromPlayerPage(e.nativeEvent.url)) return;
    const m = parsePlayerMessage(e.nativeEvent.data);
    if (m?.type === "error") setProblem({ kind: problemFor(m.code), code: m.code });
  }

  const message = problem
    ? { offline: t.playerOffline, blocked: t.playerBlocked, unavailable: t.playerUnavailable, refused: t.playerRefused, failed: t.playerFailed(problem.code) }[problem.kind]
    : null;
  const videoH = big ? undefined : SMALL_H;

  return (
    <View style={[styles.dock, !big && styles.dockSmall]}>
      <View style={[styles.video, big ? { width: "100%", aspectRatio: 16 / 9 } : { height: videoH, aspectRatio: 16 / 9 }]} accessibilityLabel={t.playerLabel}>
        {page && !problem ? (
          <WebView
            key={attempt}
            source={{ uri: page }}
            style={{ flex: 1, backgroundColor: "#000" }}
            containerStyle={{ backgroundColor: "#000" }}
            // Lockdown: only the player page and YouTube's player hosts (navDecision),
            // no files, no mixed content, nothing kept after it closes.
            originWhitelist={["*"]}
            onShouldStartLoadWithRequest={onShouldStart}
            onOpenWindow={onOpenWindow}
            javaScriptCanOpenWindowsAutomatically={false}
            javaScriptEnabled
            domStorageEnabled={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            mixedContentMode="never"
            incognito
            cacheEnabled={false}
            thirdPartyCookiesEnabled={false}
            sharedCookiesEnabled={false}
            geolocationEnabled={false}
            saveFormDataDisabled
            mediaCapturePermissionGrantType="deny"
            allowsFullscreenVideo={false}
            allowsBackForwardNavigationGestures={false}
            allowsLinkPreview={false}
            webviewDebuggingEnabled={__DEV__}
            // The user tapped Play: the video may start on its own, inline.
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback
            textZoom={100}
            setBuiltInZoomControls={false}
            onMessage={onMessage}
            onLoadEnd={() => setLoading(false)}
            onError={() => setProblem({ kind: "offline", code: 0 })}
            onHttpError={(e) => {
              if (fromPlayerPage(e.nativeEvent.url)) setProblem({ kind: "offline", code: e.nativeEvent.statusCode });
            }}
            onRenderProcessGone={() => setProblem({ kind: "failed", code: 0 })}
          />
        ) : null}
        {loading && !problem ? (
          <View style={styles.overlay} pointerEvents="none">
            <Spinner />
          </View>
        ) : null}
        {problem ? (
          <View style={styles.problem}>
            <Led color={C.missing} size={7} />
            <Text style={styles.problemText} numberOfLines={big ? 4 : 5}>
              {message}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={[styles.controls, !big && styles.controlsSmall]}>
        {problem?.kind === "offline" ? (
          <Button
            label={t.playerRetry}
            onPress={() => {
              setProblem(null);
              setLoading(true);
              setAttempt((a) => a + 1);
            }}
            size="compact"
          />
        ) : !problem ? (
          <Button label={big ? t.playerSmaller : t.playerBigger} variant="quiet" onPress={() => setBig((b) => !b)} size="compact" />
        ) : null}
        <Button label={t.openInYoutube} onPress={() => openOutside(watch)} size="compact" />
        <Button label={t.playerClose} variant="quiet" onPress={onClose} size="compact" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { marginHorizontal: 12, marginTop: 12, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel, overflow: "hidden" },
  dockSmall: { flexDirection: "row" },
  video: { backgroundColor: "#000" },
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  problem: { ...StyleSheet.absoluteFill, flexDirection: "row", alignItems: "center", padding: 10, backgroundColor: C.chassis },
  problemText: { color: C.cream, flex: 1, marginLeft: 8, fontSize: 13, lineHeight: 18 },
  controls: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, padding: 6 },
  controlsSmall: { flex: 1, flexDirection: "column", alignItems: "stretch", justifyContent: "center", gap: 2, padding: 4 },
});
