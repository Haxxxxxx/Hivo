package expo.modules.hivoshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

// Voice memos with the screen off (RecordScreen.tsx, src/lib/recording.ts).
// The foreground service is expo-audio's own (AudioRecordingService, type
// `microphone`, started and stopped with the recorder when
// `allowsBackgroundRecording` is on). This module only adds what it lacks:
// - its notification in Hivo's words and language (same id and channel, so
//   it replaces the library's text; the system keeps it tied to the service),
//   only when Hivo may post notifications: every take runs in the service,
//   notifications or not, and without them nothing shows in the shade;
// - a call watch: a phone or VoIP call stops the take (it's kept), even with
//   the app in the background, where JS timers don't run, notifications or not;
// - the length of the finished file (the recorder's state is stale when a
//   take ended in the background).
// The names below are expo-audio 58's (expo.modules.audio.service.AudioRecordingService).

private const val EXPO_SERVICE = "expo.modules.audio.service.AudioRecordingService"
private const val EXPO_STOP_ACTION = "expo.modules.audio.action.STOP_RECORDING"
private const val EXPO_CHANNEL_ID = "expo_audio_recording_channel"
private const val EXPO_NOTIFICATION_ID = 2001
private const val WATCH_MS = 1000L
private const val LABEL_TRIES = 15
private const val LABEL_RETRY_MS = 200L
private const val MAX_HOLD_MS = 500

/** AudioManager modes that mean a call has the microphone (src/lib/recording.ts `isCallMode`). */
private val CALL_MODES = setOf(2, 3, 4, 5, 6)

class HivoRecordingModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var watching = false
  @Volatile private var background = false
  @Volatile private var callStopped = false
  private var labels: Map<String, String> = emptyMap()

  private val ctx: Context?
    get() = appContext.reactContext

  private val watch = object : Runnable {
    override fun run() {
      if (!watching) return
      val am = ctx?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      if (am != null && am.mode in CALL_MODES) {
        watching = false
        callStopped = true
        if (background) stopExpoRecording()
        sendEvent("onCall", mapOf<String, Any>())
        return
      }
      main.postDelayed(this, WATCH_MS)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HivoRecording")
    Events("onCall")

    // A take started. `background`: it runs in expo-audio's foreground service.
    AsyncFunction("startWatch") { inBackground: Boolean, texts: Map<String, String> ->
      main.post {
        main.removeCallbacks(watch)
        labels = texts
        background = inBackground
        callStopped = false
        watching = true
        main.postDelayed(watch, WATCH_MS)
        if (inBackground) relabel(0)
      }
    }

    // The take ended (Stop, the cap, a call, an error, the screen closed).
    AsyncFunction("stopWatch") {
      main.post {
        watching = false
        main.removeCallbacks(watch)
        // A relabel that lost a race with the service stopping would leave an
        // ongoing notification behind: remove it (the system ignores this
        // while the service is still in the foreground).
        if (background) try { notifications()?.cancel(EXPO_NOTIFICATION_ID) } catch (_: Exception) {}
      }
    }

    // expo-audio 58 race (AudioRecordingServiceConnection.bindWithService): it
    // calls bindService on its modules queue and only then stores the
    // continuation; when the system connects fast, onServiceConnected runs on
    // the main thread in between, finds no continuation, and the prepare fails
    // 5 s later ("failed to connect with the recording service within
    // 5000ms") although the service is bound. Seen on most first takes on the
    // emulator. Called right before prepareToRecordAsync: the main thread is
    // held a moment so the connection callback queues behind the continuation.
    Function("holdMainForBind") { ms: Int ->
      val d = ms.coerceIn(0, MAX_HOLD_MS).toLong()
      main.post {
        try { Thread.sleep(d) } catch (_: InterruptedException) {}
      }
    }

    // Whether the last take was stopped by a call (read once).
    Function("takeCallStop") {
      val was = callStopped
      callStopped = false
      was
    }

    // Length of a recorded file in ms (only the app's own files), null if unreadable.
    AsyncFunction("fileDurationMs") { uri: String ->
      val c = ctx ?: return@AsyncFunction null
      val file = ownFile(c, uri) ?: return@AsyncFunction null
      val r = MediaMetadataRetriever()
      try {
        r.setDataSource(file.path)
        r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
      } catch (_: Exception) {
        null
      } finally {
        try { r.release() } catch (_: Exception) {}
      }
    }

    OnDestroy {
      watching = false
      main.removeCallbacks(watch)
    }
  }

  private fun notifications(): NotificationManager? =
    ctx?.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

  private fun ownFile(c: Context, uri: String): File? {
    val parsed = Uri.parse(uri)
    if (parsed.scheme != "file") return null
    val file = File(parsed.path ?: return null).canonicalFile
    val roots = listOfNotNull(c.cacheDir, c.filesDir).map { it.canonicalPath + File.separator }
    return if (roots.any { file.path.startsWith(it) } && file.isFile) file else null
  }

  /** Whether Hivo may post notifications (on Android 13+, POST_NOTIFICATIONS; or the user turned them off). */
  private fun canNotify(nm: NotificationManager): Boolean =
    try { nm.areNotificationsEnabled() } catch (_: Exception) { false }

  /** Replaces the service's notification text once the service has posted it.
   * A no-op when Hivo can't post notifications: the take still runs in the
   * service (Android starts it without the permission), just not in the shade. */
  private fun relabel(attempt: Int) {
    if (!watching || !background) return
    val c = ctx ?: return
    val nm = notifications() ?: return
    if (!canNotify(nm)) return
    val posted = try { nm.activeNotifications.any { it.id == EXPO_NOTIFICATION_ID } } catch (_: Exception) { false }
    if (!posted) {
      if (attempt < LABEL_TRIES) main.postDelayed({ relabel(attempt + 1) }, LABEL_RETRY_MS)
      return
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        // Same id: renames the library's channel in the phone's settings.
        val channel = NotificationChannel(EXPO_CHANNEL_ID, labels["channel"] ?: "Recording", NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(false)
          enableVibration(false)
          enableLights(false)
          setSound(null, null)
        }
        nm.createNotificationChannel(channel)
      }
      val stop = PendingIntent.getService(
        c, 0, Intent().setClassName(c, EXPO_SERVICE).setAction(EXPO_STOP_ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val open = c.packageManager.getLaunchIntentForPackage(c.packageName)?.let {
        PendingIntent.getActivity(c, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      }
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(c, EXPO_CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(c)
      @Suppress("DEPRECATION")
      val n = builder
        .setContentTitle(labels["title"] ?: "Hivo is recording")
        .setContentText(labels["text"] ?: "Tap to return")
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setOngoing(true)
        .setContentIntent(open)
        .addAction(android.R.drawable.ic_delete, labels["stop"] ?: "Stop", stop)
        .setCategory(Notification.CATEGORY_SERVICE)
        .setShowWhen(false)
        .setVisibility(Notification.VISIBILITY_SECRET)
        .setOnlyAlertOnce(true)
        .build()
      // Gone already (stopped between the check and now): don't post an orphan.
      if (!watching || nm.activeNotifications.none { it.id == EXPO_NOTIFICATION_ID }) return
      nm.notify(EXPO_NOTIFICATION_ID, n)
    } catch (_: Exception) {
      // The library's own text stays: recording isn't affected.
    }
  }

  /** Stops expo-audio's recorders the way its notification's Stop does (the file is kept). */
  private fun stopExpoRecording() {
    val c = ctx ?: return
    try {
      c.startService(Intent().setClassName(c, EXPO_SERVICE).setAction(EXPO_STOP_ACTION))
    } catch (_: Exception) {
      // Not allowed (no foreground service): JS stops it on the onCall event.
    }
  }
}
