import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Engrave } from "../components/ui";
import { UpdateCheck } from "../components/UpdateCheck";
import { tr } from "../lib/i18n";
import { CAMERA_APP_INTENT, SCAN_TIMEOUT_MS, scannerFailure } from "../lib/scanner";
import { waitingCount } from "../lib/shareQueue";
import { useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS } from "../theme";
import { PairSteps } from "./LibraryScreen";

export type PairSource = "scan" | "paste" | "link";
/** Kept by App.tsx, so it survives this screen being covered by the code check. */
export type PairError = { text: string; source: PairSource; newCode: boolean };

type Props = {
  busy: boolean;
  error: PairError | null;
  onSubmit: (input: string, source: PairSource) => void;
  onClearError: () => void;
  onBack: () => void;
};

export function PairScreen({ busy, error, onSubmit, onClearError, onBack }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [trouble, setTrouble] = useState(error?.source === "paste");
  const handled = useRef(false);
  const t = tr(T);
  const outbox = useApp((st) => st.outbox);
  const ideas = useApp((st) => st.ideas);
  const waiting = waitingCount(outbox, ideas);
  const deniedForever = !!permission && !permission.granted && !permission.canAskAgain;

  useEffect(() => {
    if (busy) setScanning(false);
    else handled.current = false;
  }, [busy]);
  useEffect(() => {
    if (error?.source === "paste") setTrouble(true);
  }, [error]);

  function submit(input: string, source: PairSource) {
    if (busy) return;
    setNotice(null);
    onSubmit(input, source);
  }

  async function pasteLink() {
    const pasted = (await Clipboard.getStringAsync().catch(() => "")).trim();
    if (!pasted) return;
    setText(pasted);
    submit(pasted, "paste");
  }

  async function startScan() {
    onClearError();
    setNotice(null);
    // Android: Google Play services' code scanner (the in-view analysis saw
    // nothing on a real phone while the system camera read the same code).
    // It brings its own full-screen UI and needs no camera permission here.
    if (Platform.OS === "android" && CameraView.isModernBarcodeScannerAvailable) {
      const sub = CameraView.onModernBarcodeScanned((res) => {
        sub.remove();
        submit(res.data, "scan");
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
        setNotice(t.cameraDenied);
        setTrouble(true);
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
    onClearError();
    try {
      await Linking.sendIntent(CAMERA_APP_INTENT);
      setNotice(t.cameraAppOpened);
    } catch (e) {
      console.warn("couldn't open the camera app:", e instanceof Error ? e.message : String(e));
      setNotice(t.scanTip);
    }
  }

  // Nothing read after SCAN_TIMEOUT_MS: show the other ways (never switch apps by itself).
  useEffect(() => {
    if (!scanning) return;
    const timer = setTimeout(() => {
      if (!handled.current) setTrouble(true);
    }, SCAN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [scanning]);

  const errorBlock = (e: PairError) => (
    <View style={styles.errorBox} accessibilityLiveRegion="polite">
      <Text style={styles.error}>{e.text}</Text>
      {e.newCode ? <Text style={styles.next}>{t.pairNewCode}</Text> : null}
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <Pressable onPress={onBack} accessibilityRole="button" style={styles.back}>
          <Text style={styles.backText}>‹ {t.back}</Text>
        </Pressable>
        <Text style={styles.title}>{t.pairTitle}</Text>
        <PairSteps />
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
                submit(res.data, "scan");
              }}
            />
          </View>
        ) : null}
        <Button
          label={scanning ? t.stopScan : deniedForever ? t.allowCamera : t.scan}
          variant={scanning ? "secondary" : "primary"}
          onPress={() => (scanning ? setScanning(false) : void startScan())}
          disabled={busy}
          style={{ marginTop: 20 }}
        />
        {/* Right under Scan, so the result of a scan is never below the fold. */}
        {busy ? (
          <View style={styles.statusRow}>
            <ActivityIndicator color={C.body} size="small" />
            <Text style={[styles.status, { marginTop: 0 }]}>{t.codeRead}</Text>
          </View>
        ) : null}
        {notice && !busy ? <Text style={styles.status}>{notice}</Text> : null}
        {error && error.source !== "paste" && !busy ? errorBlock(error) : null}
        {deniedForever && !scanning ? (
          <Button label={t.openCameraSettings} variant="secondary" onPress={() => void Linking.openSettings()} style={{ marginTop: 10 }} />
        ) : null}

        <Button label={trouble ? t.hideTrouble : t.troubleScanning} variant="quiet" onPress={() => setTrouble((v) => !v)} style={{ marginTop: 16, alignSelf: "flex-start" }} />
        {trouble ? (
          <View>
            {Platform.OS === "android" ? (
              <Button label={t.useCameraApp} variant="secondary" onPress={() => void openCameraApp()} style={{ marginTop: 6 }} />
            ) : null}
            <Text style={styles.tip}>{t.scanTip}</Text>

            <Engrave style={{ marginTop: 20, marginBottom: 6 }}>{t.pasteLabel}</Engrave>
            <TextInput
              value={text}
              onChangeText={(v) => {
                setText(v);
                if (error?.source === "paste") onClearError();
              }}
              placeholder={t.pastePlaceholder}
              placeholderTextColor={C.engrave}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              accessibilityLabel={t.pairLinkLabel}
              style={[styles.input, error?.source === "paste" && { borderColor: C.missing }]}
            />
            {error?.source === "paste" && !busy ? errorBlock(error) : null}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              <Button label={t.pasteLink} variant="secondary" onPress={() => void pasteLink()} disabled={busy} style={{ flex: 1 }} />
              <Button label={busy ? t.pairing : t.pair} onPress={() => submit(text, "paste")} disabled={busy || !text.trim()} style={{ flex: 1 }} />
            </View>
          </View>
        ) : null}

        {/* Here too: an app that can't pair must still be able to update. */}
        <UpdateCheck style={{ marginTop: 32 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 8 },
  back: { minHeight: 48, justifyContent: "center", alignSelf: "flex-start", paddingRight: 16 },
  backText: { color: C.body, fontSize: 15 },
  title: { fontFamily: FONT.display, fontSize: 28, color: C.cream, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.5 },
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
  waiting: { color: C.warn, fontSize: 14, lineHeight: 20, marginTop: 14 },
  errorBox: { marginTop: 10, padding: 10, borderWidth: 1, borderColor: C.missing, borderRadius: RADIUS, backgroundColor: C.panel, gap: 6 },
  error: { color: C.cream, fontSize: 14, lineHeight: 20 },
  next: { color: C.body, fontSize: 14, lineHeight: 20 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  status: { color: C.cream, marginTop: 12, fontSize: 14, lineHeight: 20 },
  tip: { color: C.engrave, marginTop: 10, fontSize: 13, lineHeight: 18 },
});
