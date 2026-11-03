import { useFonts } from "expo-font";
import { getLocales } from "expo-localization";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { Alert, AppState, BackHandler, Keyboard, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { onShare, onShareStart, sweepShareCache, takeShared, type Shared } from "./modules/hivo-share";
import { s } from "./src/inboxStrings";
import { isLoopbackLink, needsYou, savedSince } from "./src/lib/captures";
import { setLang, tr } from "./src/lib/i18n";
import type { IdeaTarget } from "./src/lib/ideas";
import { backAction, canShowShare, filterStack, pop, push, replaceTop, showsUpdateBanner, toTab, top, type Nav, type Tab } from "./src/lib/nav";
import { parsePairingUrl, type PairOffer, type Pairing } from "./src/lib/pairing";
import { dequeue, enqueue } from "./src/lib/shareQueue";
import { needsNewCode, pairErrorText, pairFailText, T } from "./src/strings";
import type { Kind } from "./src/lib/sync";
import { ConfirmPairing } from "./src/components/ConfirmPairing";
import { InboxTab, type CaptureHandle } from "./src/components/InboxTab";
import { PairingUnreadable } from "./src/components/PairingUnreadable";
import { ScreenHeader } from "./src/components/ScreenHeader";
import { CopyingStrip, SyncHeader, SyncStrip } from "./src/components/SyncHeader";
import { TabBar } from "./src/components/TabBar";
import { showToast, ToastHost } from "./src/components/Toast";
import { Led, Spinner } from "./src/components/ui";
import { UpdateBanner } from "./src/components/UpdateBanner";
import { pickFiles } from "./src/files";
import { IdeaScreen } from "./src/screens/IdeaScreen";
import { LibraryScreen } from "./src/screens/LibraryScreen";
import { NoteScreen } from "./src/screens/NoteScreen";
import { PairScreen, type PairError, type PairSource } from "./src/screens/PairScreen";
import { RecordScreen } from "./src/screens/RecordScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ShareScreen, type IncomingShare } from "./src/screens/ShareScreen";
import { addIdea, cancelConfirmation, flush, flushExtras, getState, load, pair, requestSync, sync, syncOnForeground, useApp, verifyPairing } from "./src/store";
import { C, FONT } from "./src/theme";

setLang(getLocales()[0]?.languageCode);

/** Full-screen routes pushed over the two tabs. `since`: when the screen
 * opened, to tell what it kept (the toast). */
type Route =
  | { name: "note"; kind: Kind; id: string }
  | { name: "settings" }
  | { name: "pair" }
  | { name: "idea"; id: string; since: number }
  | { name: "record"; target: IdeaTarget | null; since: number; draftId?: string }
  | { name: "share"; share: IncomingShare; at: number; since: number };

const fromNative = (sh: Shared): IncomingShare => ({ files: sh.files, skipped: sh.skipped, text: sh.text, subject: sh.subject, picked: false, dir: sh.dir });

/** A search field left focused under a pushed screen (or a hidden tab) takes the
 * hardware Back for itself, every time: blur it, not only the keyboard. */
function releaseFocus(): void {
  TextInput.State.currentlyFocusedInput()?.blur();
  Keyboard.dismiss();
}

/** How long "Paired" stays on screen. */
const PAIRED_MS = 1800;

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    BarlowCondensed_600SemiBold: require("@expo-google-fonts/barlow-condensed/600SemiBold/BarlowCondensed_600SemiBold.ttf"),
  });
  const loaded = useApp((st) => st.loaded);
  const paired = useApp((st) => st.pairing !== null);
  const confirmingNow = useApp((st) => st.confirming !== null);
  const outbox = useApp((st) => st.outbox);
  const pairingUnreadable = useApp((st) => st.pairingUnreadable);
  // Whether the computer answered last time (a sync starting clears `error`, so it's kept here for the toast).
  const syncError = useApp((st) => st.error);
  const lastSyncAt = useApp((st) => st.sync.lastSyncAt);
  const unreachable = useRef(false);
  useEffect(() => {
    if (syncError) unreachable.current = true;
  }, [syncError]);
  useEffect(() => {
    unreachable.current = false;
  }, [lastSyncAt]);
  const [nav, setNav] = useState<Nav<Route>>({ tab: "capture", stack: [] });
  const navRef = useRef(nav);
  navRef.current = nav;
  const [kind, setKind] = useState<Kind>("prod");
  const capture = useRef<CaptureHandle>(null);
  /** What the hardware Back does on a screen that has its own rule (share, record). */
  const backRef = useRef<(() => void) | null>(null);

  // Pairing state lives here, not in PairScreen: the code check covers that
  // screen, and a result (an error, "Paired") must still show after it.
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<PairError | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  /** Cancelled on the phone: the code check hides at once (the wait ends at its next poll). */
  const [confirmHidden, setConfirmHidden] = useState(false);
  const confirming = confirmingNow && !confirmHidden;
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;
  useEffect(() => {
    if (!confirmingNow) setConfirmHidden(false);
  }, [confirmingNow]);
  useEffect(() => {
    if (!justPaired) return;
    const timer = setTimeout(() => setJustPaired(null), PAIRED_MS);
    return () => clearTimeout(timer);
  }, [justPaired]);

  // Shares that arrived while recording or while another share is on screen:
  // each waits its turn, none replaces another.
  const [queue, setQueue] = useState<Shared[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  /** A share's files are being copied (a big export takes a while). */
  const [copying, setCopying] = useState(false);
  const showShare = (sh: Shared) => {
    setCopying(false);
    setQueue((q) => enqueue(q, sh));
  };
  useEffect(() => {
    if (queue.length === 0 || !canShowShare(nav, { confirming })) return;
    const { next, rest } = dequeue(queue);
    setQueue(rest);
    // Pushed over whatever is on screen: Back returns there.
    if (next) go({ name: "share", share: fromNative(next), at: Date.now(), since: Date.now() });
  }, [queue, nav, confirming]);

  function go(r: Route) {
    releaseFocus();
    capture.current?.stopPlayback();
    setNav((n) => push(n, r));
  }

  /** Leaves the top screen for the one under it; says what was kept. */
  function popScreen() {
    const leaving = top(navRef.current);
    const rest = pop(navRef.current);
    setNav(rest);
    if (!leaving) return;
    if (leaving.name === "note") {
      setTimeout(() => {
        if (Object.keys(getState().sync.pending).length > 0) requestSync();
      }, 50);
    }
    if (leaving.name === "record" || leaving.name === "share" || leaving.name === "idea") {
      // After the screen's own leaving code (an idea saves when it unmounts).
      setTimeout(() => {
        const st = getState();
        const what = savedSince(leaving, st.ideas, st.outbox, leaving.since);
        if (!what) return;
        const label = { memo: s().toastMemo, export: s().toastExport, idea: s().toastIdea }[what];
        const how = !st.pairing ? s().toastUnpaired : st.error || unreachable.current ? s().toastLater : s().toastNow;
        showToast(`${label} · ${how}`);
        if (rest.stack.length === 0 && rest.tab === "capture") capture.current?.scrollToTop();
      }, 60);
    }
  }

  function cancelPairing() {
    cancelConfirmation();
    setConfirmHidden(true);
  }

  /** Checks the computer answers, then saves the pairing and syncs. */
  async function verifyAndPair(link: Pairing | PairOffer, source: PairSource) {
    setPairBusy(true);
    setPairError(null);
    try {
      // Only a computer that answers is kept (a wrong or old code saves nothing).
      const v = await verifyPairing(link);
      if (!v.ok) {
        // null: cancelled on the phone while it waited for the computer's confirmation.
        if (v.code) setPairError({ text: pairFailText(v.code), source, newCode: needsNewCode(v.code) });
        return;
      }
      await pair(v.pairing);
      setPairError(null);
      setNav((n) => filterStack(n, (r) => r.name !== "pair"));
      setJustPaired(v.pairing.desktopName);
      void sync();
    } catch (e) {
      // Saving the key failed on the phone (secure storage): the raw text is for the log.
      console.warn("pairing failed:", e instanceof Error ? e.message : String(e));
      setPairError({ text: tr(T).pairSaveFailed, source, newCode: false });
    } finally {
      setPairBusy(false);
    }
  }

  function submitPairing(input: string, source: PairSource) {
    if (pairBusy) return;
    const r = parsePairingUrl(input, { loopback: Platform.OS === "ios" });
    if (!r.ok) {
      setPairError({ text: r.error === "hosts" && isLoopbackLink(input) ? tr(T).loopbackLink : pairErrorText(r.error), source, newCode: false });
      return;
    }
    void verifyAndPair("offer" in r ? r.offer : r.pairing, source);
  }

  /** A hivo://pair link opened from the system camera (or `simctl openurl`),
   * only after the user says yes (any app or page can open a link; pairing
   * sends notes to that address). When already paired, it offers to replace
   * the pairing (the computer's address changed, or another computer);
   * unsynced note edits are carried over. A link that can't pair says why. */
  function pairFromLink(url: string | null | undefined): void {
    if (!url || !/^hivo:\/\/pair/i.test(url.trim())) return;
    const t = tr(T);
    const r = parsePairingUrl(url, { loopback: Platform.OS === "ios" });
    if (!r.ok) {
      Alert.alert(t.badLinkTitle, r.error === "hosts" && isLoopbackLink(url) ? t.loopbackLink : pairErrorText(r.error));
      return;
    }
    const link = "offer" in r ? r.offer : r.pairing;
    const { desktopName, hosts, port, deviceId } = link;
    const current = getState().pairing;
    if ("pairing" in r && current?.deviceId === deviceId && current.key === r.pairing.key) return;
    const title = current ? t.replacePairTitle(desktopName) : t.linkPairTitle;
    const body = current ? t.replacePairBody(current.desktopName, `${hosts[0]}:${port}`) : t.linkPairBody(desktopName, `${hosts[0]}:${port}`);
    Alert.alert(title, body, [
      { text: t.cancel, style: "cancel" },
      {
        text: current ? t.replacePairYes : t.linkPairYes,
        onPress: () => {
          // Still the pairing the question was about.
          if (getState().pairing?.deviceId !== current?.deviceId) return;
          // On the pair screen, so an error shows with its next step.
          if (top(navRef.current)?.name !== "pair") go({ name: "pair" });
          void verifyAndPair(link, "link");
        },
      },
    ]);
  }

  useEffect(() => {
    // Shared while Hivo is open (registered first: a share can start copying right away).
    const share = onShare(showShare);
    const start = onShareStart(() => setCopying(true));
    void load().then(async () => {
      if (getState().pairing) void sync();
      pairFromLink(await Linking.getInitialURL());
      // Started by "Share to Hivo".
      const shared = await takeShared().catch(() => null);
      setCopying(false);
      if (shared) showShare(shared);
      // Copies left by an earlier run (killed mid-share): only these are still wanted.
      const onScreen = navRef.current.stack.flatMap((r) => (r.name === "share" && r.share.dir ? [r.share.dir] : []));
      void sweepShareCache([shared?.dir, ...onScreen, ...queueRef.current.map((q) => q.dir)].filter((d): d is string => !!d));
    });
    const link = Linking.addEventListener("url", ({ url }) => {
      if (getState().loaded) pairFromLink(url);
    });
    // Sync when the app comes back; save the cache when it leaves.
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") {
        // Skips a sync that finished moments ago, restarts one stuck with the screen off.
        syncOnForeground();
        // Shared while Hivo was in the background (the intent is waiting).
        void takeShared()
          .then((shared) => {
            setCopying(false);
            if (shared) showShare(shared);
          })
          .catch(() => setCopying(false));
      } else if (st === "background" || st === "inactive") {
        void flush();
        void flushExtras();
      }
    });
    return () => {
      sub.remove();
      link.remove();
      share.remove();
      start.remove();
    };
  }, []);

  // Unpaired: the computer's screens go (a note, Settings); what's being captured stays.
  const wasPaired = useRef(paired);
  useEffect(() => {
    if (wasPaired.current && !paired) setNav((n) => filterStack(n, (r) => r.name === "share" || r.name === "idea" || r.name === "record"));
    wasPaired.current = paired;
  }, [paired]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      switch (backAction(navRef.current, { confirming: confirmingRef.current })) {
        case "cancel-pairing":
          cancelPairing();
          return true;
        case "screen":
          // Share and record have their own rule (cleanup, never leave a take).
          backRef.current?.();
          return true;
        case "pop":
          popScreen();
          return true;
        case "to-capture":
          setNav((n) => toTab(n, "capture"));
          return true;
        case "exit":
          return false;
      }
    });
    return () => sub.remove();
  }, []);

  function newIdea(target: IdeaTarget | null) {
    go({ name: "idea", id: addIdea({ target }), since: Date.now() });
  }

  async function pick() {
    try {
      const files = await pickFiles();
      if (files.length > 0) go({ name: "share", share: { files, skipped: [], text: null, subject: null, picked: true }, at: Date.now(), since: Date.now() });
    } catch (e) {
      console.warn("Hivo: the file picker failed", e);
    }
  }

  function onTab(tab: Tab) {
    if (tab === "capture" && nav.tab === "capture") capture.current?.scrollToTop();
    releaseFocus();
    setNav((n) => toTab(n, tab));
  }

  const ready = loaded && (fontsLoaded || fontError);
  const route = top(nav);
  const covered = route !== null || confirming || justPaired !== null;
  const t = tr(T);

  function screen(r: Route) {
    switch (r.name) {
      case "share":
        return (
          <ShareScreen
            key={r.at}
            share={r.share}
            onDone={popScreen}
            onIdea={(id) => setNav((n) => replaceTop(n, { name: "idea", id, since: r.since }))}
            backRef={backRef}
            waiting={queue.length}
          />
        );
      case "idea":
        return <IdeaScreen key={r.id} id={r.id} onBack={popScreen} />;
      case "record":
        return <RecordScreen key={r.draftId ?? "new"} target={r.target} onDone={popScreen} backRef={backRef} draftId={r.draftId} />;
      case "note":
        return (
          <NoteScreen
            key={`${r.kind}:${r.id}`}
            kind={r.kind}
            id={r.id}
            onBack={popScreen}
            onRecord={(target) => go({ name: "record", target, since: Date.now() })}
            onIdea={(target) => newIdea(target)}
          />
        );
      case "settings":
        return (
          <View style={{ flex: 1 }}>
            <View style={{ flex: 1 }}>
              <SettingsScreen onBack={popScreen} />
            </View>
            {showsUpdateBanner(nav, { confirming }) ? <UpdateBanner /> : null}
          </View>
        );
      case "pair":
        if (pairingUnreadable)
          return (
            <View style={{ flex: 1 }}>
              <ScreenHeader title={t.pairTitle} onBack={popScreen} />
              <PairingUnreadable />
            </View>
          );
        return <PairScreen busy={pairBusy} error={pairError} onSubmit={submitPairing} onClearError={() => setPairError(null)} onBack={popScreen} />;
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.chassis }} edges={["top", "bottom", "left", "right"]}>
        <StatusBar style="light" />
        {!ready ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Spinner size="large" />
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            {/* The tabs stay mounted under pushed screens: the Library keeps its search and scroll. */}
            <View style={{ flex: 1 }} importantForAccessibility={covered ? "no-hide-descendants" : "auto"} pointerEvents={covered ? "none" : "auto"}>
              <SyncHeader onSettings={() => go({ name: "settings" })} onPair={() => go({ name: "pair" })} />
              <View style={{ flex: 1 }}>
                <View style={[StyleSheet.absoluteFill, nav.tab !== "capture" && styles.hidden]} pointerEvents={nav.tab === "capture" ? "auto" : "none"} importantForAccessibility={nav.tab === "capture" ? "auto" : "no-hide-descendants"}>
                  <InboxTab ref={capture} onIdea={(id) => (id ? go({ name: "idea", id, since: Date.now() }) : newIdea(null))} onRecord={() => go({ name: "record", target: null, since: Date.now() })} onPick={() => void pick()} onDraft={(id) => go({ name: "record", target: null, since: Date.now(), draftId: id })} />
                </View>
                <View style={[StyleSheet.absoluteFill, nav.tab !== "library" && styles.hidden]} pointerEvents={nav.tab === "library" ? "auto" : "none"} importantForAccessibility={nav.tab === "library" ? "auto" : "no-hide-descendants"}>
                  <LibraryScreen kind={kind} onKind={setKind} onOpen={(i) => go({ name: "note", kind: i.kind, id: i.id })} onPair={() => go({ name: "pair" })} />
                </View>
              </View>
              {copying ? <CopyingStrip /> : null}
              {showsUpdateBanner(nav, { confirming }) ? <UpdateBanner /> : null}
              <SyncStrip onSettings={() => go({ name: "settings" })} />
              <TabBar tab={nav.tab} onTab={onTab} badge={needsYou(outbox)} />
            </View>
            {route ? (
              <View style={[StyleSheet.absoluteFill, styles.cover]}>
                {copying && route.name !== "share" ? <CopyingStrip /> : null}
                <View style={{ flex: 1 }}>{screen(route)}</View>
              </View>
            ) : null}
            {confirming ? (
              // Scanned: compare the code with the computer's until it's confirmed there.
              <View style={[StyleSheet.absoluteFill, styles.cover]}>
                <ConfirmPairing onCancel={cancelPairing} />
              </View>
            ) : null}
            {justPaired !== null && !confirming ? (
              <Pressable style={[StyleSheet.absoluteFill, styles.cover, styles.paired]} onPress={() => setJustPaired(null)} accessibilityRole="alert">
                <Led color={C.ok} size={14} />
                <Text style={styles.pairedTitle}>{t.pairedTitle}</Text>
                <Text style={styles.pairedBody}>{t.pairedBody(justPaired)}</Text>
              </Pressable>
            ) : null}
            <ToastHost bottom={route ? 16 : 72} />
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  // Hidden but mounted (a tab's state survives); opacity, not display, so the list keeps its scroll.
  hidden: { opacity: 0 },
  cover: { backgroundColor: C.chassis },
  paired: { alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  pairedTitle: { fontFamily: FONT.display, fontSize: 40, color: C.cream, textTransform: "uppercase", letterSpacing: 1 },
  pairedBody: { color: C.body, fontSize: 16, lineHeight: 22, textAlign: "center" },
});
