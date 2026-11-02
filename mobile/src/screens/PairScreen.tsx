import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Engrave } from "../components/ui";
import { UpdateCheck } from "../components/UpdateCheck";
import { tr } from "../lib/i18n";
import { parsePairingUrl } from "../lib/pairing";
import { CAMERA_APP_INTENT, SCAN_TIMEOUT_MS, scannerFailure } from "../lib/scanner";
import { waitingCount } from "../lib/shareQueue";
import { pair, sync, useApp, verifyPairing } from "../store";
import { errorText, pairErrorText, T } from "../strings";
import { C, FONT, RADIUS } from "../theme";

export function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const handled = useRef(false);
  const t = tr(T);
  const outbox = useApp((st) => st.outbox);
  const ideas = useApp((st) => st.ideas);
  const waiting = waitingCount(outbox, ideas);
  const deniedForever = !!permission && !permission.granted && !permission.canAskAgain;

  async function submit(input: string) {
    if (busy) return;
    const r = parsePairingUrl(input, { loopback: Platform.OS === "ios" });
    if (!r.ok) {
      setError(pairErrorText(r.error));
      handled.current = false;
      return;
    }
    setBusy(true);
    setError(null);
    setScanning(false);
    try {
      // Only a computer that answers is kept (a wrong or old code saves nothing).
      const v = await verifyPairing(r.pairing);
      if (!v.ok) {
        setError(t.pairCheckFailed(errorText(v.code)));
        setBusy(false);
        handled.current = false;
        return;
      }
      await pair({ ...r.pairing, desktopName: v.desktopName }); // the app switches to the Library
      void sync();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      handled.current = false;
    }
  }

  async function pasteLink() {
    const pasted = (await Clipboard.getStringAsync().catch(() => "")).trim();
    if (!pasted) return;
    setText(pasted);
    void submit(pasted);
  }

  async function startScan() {
    setError(null);
    setNotice(null);
    // Android: Google Play services' code scanner (the in-view analysis saw
    // nothing on a real phone while the system camera read the same code).
    // It brings its own full-screen UI and needs no camera permission here.
    if (Platform.OS === "android" && CameraView.isModernBarcodeScannerAvailable) {
      const sub = CameraView.onModernBarcodeScanned((res) => {
        sub.remove();
        void submit(res.data);
      });
      try {
        await CameraView.launchScanner({ barcodeTypes: ["qr"] });
        return;
      } catch (e) {
        sub.remove();
        if (scannerFailure(e) === "cancelled") return;
        // Google's scanner didn't start: use the camera here instead.
        console.warn("code scanner failed, using the in-app camera:", e instanceof Error ? e.message : String(e));
        setNotice(t.scanFallback);
      }
    }
    await openCamera();
  }

  async function openCamera() {
    if (!permission?.granted) {
      const p = await requestPermission();
      if (!p.granted) {
        setError(t.cameraDenied);
        return;
      }
    }
    handled.current = false;
    setScanning(true);
  }

  // The phone's own camera app reads the QR and opens the hivo:// link,
  // which pairs (App.tsx). Android only: iOS has no intent for it.
  async function openCameraApp() {
    setScanning(false);
    setError(null);
    try {
      await Linking.sendIntent(CAMERA_APP_INTENT);
      setNotice(t.cameraAppOpened);
    } catch (e) {
      console.warn("couldn't open the camera app:", e instanceof Error ? e.message : String(e));
      setNotice(t.scanTip);
    }
  }

  // Nothing read after SCAN_TIMEOUT_MS: hand over to the camera app.
  useEffect(() => {
    if (!scanning || Platform.OS !== "android") return;
    const timer = setTimeout(() => {
      if (!handled.current) void openCameraApp();
    }, SCAN_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>Hivo</Text>
        <Text style={styles.title}>{t.pairTitle}</Text>
        <Text style={styles.body}>{t.pairIntro}</Text>
        {waiting > 0 ? <Text style={styles.waiting}>{t.waitingToSend(waiting)}</Text> : null}

        {scanning ? (
          <View style={styles.cameraBox}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(res) => {
                if (handled.current) return;
                handled.current = true;
                void submit(res.data);
              }}
            />
          </View>
        ) : null}
        <Button
          label={scanning ? t.stopScan : permission && !permission.granted && !permission.canAskAgain ? t.allowCamera : t.scan}
          variant={scanning ? "secondary" : "primary"}
          onPress={() => (scanning ? setScanning(false) : void startScan())}
          style={{ marginTop: 20 }}
        />
        {/* Right under the camera, so a refused code is never hidden below the fold. */}
        {busy ? <Text style={styles.status}>{t.codeRead}</Text> : null}
        {notice && !busy ? <Text style={styles.status}>{notice}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {deniedForever && !scanning ? (
          <Button label={t.openCameraSettings} variant="secondary" onPress={() => void Linking.openSettings()} style={{ marginTop: 10 }} />
        ) : null}
        {scanning && Platform.OS === "android" ? <Text style={styles.tip}>{t.scanTimeoutHint(SCAN_TIMEOUT_MS / 1000)}</Text> : null}
        {Platform.OS === "android" ? (
          <Button label={t.useCameraApp} variant="secondary" onPress={() => void openCameraApp()} style={{ marginTop: 10 }} />
        ) : null}
        <Text style={styles.tip}>{t.scanTip}</Text>

        <Engrave style={{ marginTop: 28, marginBottom: 6 }}>{t.pasteLabel}</Engrave>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t.pastePlaceholder}
          placeholderTextColor={C.engrave}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          accessibilityLabel={t.pairLinkLabel}
          style={styles.input}
        />
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          <Button label={t.pasteLink} variant="secondary" onPress={() => void pasteLink()} disabled={busy} style={{ flex: 1 }} />
          <Button label={busy ? t.pairing : t.pair} onPress={() => void submit(text)} disabled={busy || !text.trim()} style={{ flex: 1 }} />
        </View>

        {/* Here too: an app that can't pair must still be able to update. */}
        <UpdateCheck style={{ marginTop: 32 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 32 },
  brand: { fontFamily: FONT.display, fontSize: 40, color: C.cream, letterSpacing: 1, textTransform: "uppercase" },
  title: { fontFamily: FONT.display, fontSize: 24, color: C.cream, marginTop: 16, textTransform: "uppercase", letterSpacing: 0.5 },
  body: { color: C.body, fontSize: 15, lineHeight: 21, marginTop: 8 },
  cameraBox: { marginTop: 20, aspectRatio: 1, borderRadius: RADIUS, overflow: "hidden", borderWidth: 1, borderColor: C.ruleStrong, backgroundColor: C.panel },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: C.rule,
    backgroundColor: C.chassis,
    borderRadius: RADIUS,
    color: C.cream,
    padding: 10,
    fontFamily: FONT.mono,
    fontSize: 13,
    textAlignVertical: "top",
  },
  waiting: { color: C.warn, fontSize: 14, lineHeight: 20, marginTop: 10 },
  error: { color: C.missing, marginTop: 12, fontSize: 14 },
  status: { color: C.cream, marginTop: 12, fontSize: 14 },
  tip: { color: C.engrave, marginTop: 10, fontSize: 13, lineHeight: 18 },
});
