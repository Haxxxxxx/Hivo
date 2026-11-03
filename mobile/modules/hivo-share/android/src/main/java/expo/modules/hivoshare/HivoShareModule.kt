package expo.modules.hivoshare

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException

// "Share to Hivo" (phase B step 4, docs/PHONE-SYNC.md v1.1): reads what
// another app (BandLab, a file manager…) shared with Hivo, copies the files
// into the app's cache so JS can read them, and hands JS their names and
// sizes. Text (a BandLab link, lyrics) comes through as text. The intent is
// taken before it's read (`claim`), so a reload, or the new-intent event and
// takeShared both firing, never shares it twice.
//
// Limits are checked here too so a huge file is never copied:
// MAX_FILES / MAX_FILE_BYTES match src/lib/outbox.ts; MAX_SHARE_BYTES (2 GB
// for one share) is the phone's own cap.

private const val MAX_FILES = 20
private const val MAX_FILE_BYTES = 500L * 1024 * 1024
/** All the files of one share together. */
private const val MAX_SHARE_BYTES = 2L * 1024 * 1024 * 1024
/** Room left on the phone after a copy. */
private const val SPACE_MARGIN_BYTES = 50L * 1024 * 1024
private const val MAX_TEXT_CHARS = 20_000
/** Marks an intent this module has already taken (it can reach JS twice:
 * the new-intent event, then takeShared when the app becomes active). */
private const val CONSUMED = "fr.hivo.share.consumed"

class HivoShareModule : Module() {
  private val lock = Any()
  /** Share folders being copied right now: a sweep never touches them. */
  private val copying = mutableSetOf<String>()

  override fun definition() = ModuleDefinition {
    Name("HivoShare")
    Events("onShare", "onShareStart")

    // A share that started the app (or arrived while it was in the background).
    // The intent is taken first (two calls never copy one share), then read.
    AsyncFunction("takeShared") {
      val activity = appContext.currentActivity ?: return@AsyncFunction null
      val captured = claim(activity.intent) ?: return@AsyncFunction null
      // Claimed: from here on it's shown, even as a failure, never dropped.
      try {
        read(captured)
      } catch (t: Throwable) {
        failed()
      }
    }

    // A share while Hivo is open (singleTask activity). Copying can take a
    // while (up to 20 big files): off the main thread, or Android shows
    // "not responding". Nothing thrown on that thread may escape: an uncaught
    // exception there kills the app, and the claimed share with it.
    OnNewIntent { intent ->
      val captured = claim(intent) ?: return@OnNewIntent
      Thread {
        val shared = try {
          read(captured)
        } catch (t: Throwable) {
          failed()
        }
        try {
          if (shared != null) sendEvent("onShare", shared)
        } catch (t: Throwable) {
          // The app is going away: nothing left to show it to.
        }
      }.start()
    }

    // Whether a plain TCP connect to the computer is refused (the port is
    // closed: phone sync off, Hivo closed), after a sync request failed. Only
    // a private IPv4 literal (no DNS, nothing outside the LAN).
    AsyncFunction("probeTcp") { host: String, port: Int, timeoutMs: Int ->
      if (!isPrivateIPv4(host) || port !in 1..65535) return@AsyncFunction "other"
      val socket = java.net.Socket()
      try {
        socket.connect(java.net.InetSocketAddress(host, port), timeoutMs.coerceIn(100, 5000))
        "open"
      } catch (e: java.net.ConnectException) {
        if (e.message?.contains("ECONNREFUSED") == true || e.message?.contains("refused", ignoreCase = true) == true) "refused" else "other"
      } catch (e: Exception) {
        "other"
      } finally {
        try { socket.close() } catch (_: Exception) {}
      }
    }

    // The phone's own private IPv4 addresses on Wi-Fi or Ethernet, for "Look
    // for my computer again" (scan only the network the phone is on now).
    // Mobile data, VPNs and hotspot-client tunnels are left out; no permission.
    AsyncFunction("localIPv4s") {
      val out = mutableListOf<String>()
      try {
        val nets = java.net.NetworkInterface.getNetworkInterfaces()?.toList() ?: emptyList()
        for (ni in nets) {
          if (!ni.isUp || ni.isLoopback || ni.isVirtual || ni.isPointToPoint) continue
          val name = ni.name ?: continue
          if (!name.startsWith("wlan") && !name.startsWith("eth")) continue
          for (a in ni.inetAddresses.toList()) {
            val host = (a as? java.net.Inet4Address)?.hostAddress ?: continue
            if (isPrivateIPv4(host) && host !in out) out.add(host)
          }
        }
      } catch (_: Exception) {
        // Unknown: JS falls back to the saved hosts' networks.
      }
      out
    }

    // A picked file's own name (the picker hands JS a content:// address whose
    // last part is only an id). Null when the provider doesn't say.
    AsyncFunction("displayName") { uri: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction null
      val parsed = try { Uri.parse(uri) } catch (_: Exception) { return@AsyncFunction null }
      if (parsed.scheme != "content") return@AsyncFunction null
      try {
        ctx.contentResolver.query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
          val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (c.moveToFirst() && n >= 0 && !c.isNull(n)) c.getString(n)?.takeIf { it.isNotBlank() }?.let { clean(it) } else null
        }
      } catch (_: Exception) {
        null
      }
    }

    // Removes one share's copies once JS has moved them into the outbox (or
    // the share was left). Only a folder inside the share cache.
    AsyncFunction("clearCache") { dir: String ->
      val target = shareDir(dir) ?: return@AsyncFunction false
      synchronized(lock) { if (target.path in copying) return@AsyncFunction false }
      target.deleteRecursively()
    }

    // At start: every share folder but the ones JS still shows or holds.
    AsyncFunction("sweepCache") { keep: List<String> ->
      val ctx = appContext.reactContext ?: return@AsyncFunction 0
      val kept = keep.mapNotNull { shareDir(it)?.path }.toSet()
      var removed = 0
      File(ctx.cacheDir, "hivo-share").listFiles()?.forEach { f ->
        val busy = synchronized(lock) { f.canonicalPath in copying }
        if (!busy && f.canonicalPath !in kept && f.deleteRecursively()) removed++
      }
      removed
    }
  }

  /** What JS gets for a share that couldn't be read at all: one unreadable, unnamed item. */
  private fun failed(): Map<String, Any?> =
    mapOf("dir" to null, "files" to emptyList<Any>(), "skipped" to listOf(mapOf("name" to "", "reason" to "unreadable", "named" to false)), "text" to null, "subject" to null)

  private fun isPrivateIPv4(s: String): Boolean {
    val m = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(s) ?: return false
    val p = m.groupValues.drop(1).map { it.toInt() }
    if (p.any { it > 255 }) return false
    return p[0] == 10 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168)
  }

  /** A share folder JS named, checked to be directly inside the share cache. */
  private fun shareDir(path: String): File? {
    val ctx = appContext.reactContext ?: return null
    val root = File(ctx.cacheDir, "hivo-share").canonicalFile
    val f = try { File(path.removePrefix("file://")).canonicalFile } catch (_: IOException) { return null }
    return if (f.parentFile == root) f else null
  }

  /** Takes a share intent once: returns a copy to read and empties the
   * original (marked, extras removed), so nothing reads it again. */
  private fun claim(intent: Intent?): Intent? = synchronized(lock) {
    if (intent == null || intent.getBooleanExtra(CONSUMED, false)) return null
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
    val copy = Intent(intent)
    intent.putExtra(CONSUMED, true)
    intent.removeExtra(Intent.EXTRA_STREAM)
    intent.removeExtra(Intent.EXTRA_TEXT)
    intent.action = Intent.ACTION_MAIN
    copy
  }

  /** Only content:// shares: a file:// path from another app could point
   * inside Hivo's own storage (the activity is exported, it has to be). */
  private fun streams(intent: Intent): List<Uri> = rawStreams(intent).filter { it.scheme == "content" }

  private fun rawStreams(intent: Intent): List<Uri> {
    return when (intent.action) {
      Intent.ACTION_SEND -> {
        val uri = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
        listOfNotNull(uri)
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        val list = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        }
        list?.filterNotNull() ?: emptyList()
      }
      else -> emptyList()
    }
  }

  private fun read(intent: Intent?): Map<String, Any?>? {
    if (intent == null) return null
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
    val ctx = appContext.reactContext ?: return null
    val uris = streams(intent)
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.take(MAX_TEXT_CHARS)
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.take(200)
    if (uris.isEmpty() && text.isNullOrBlank()) return null

    // Each share in its own folder: clearing one never touches another.
    val dir = File(ctx.cacheDir, "hivo-share/${System.currentTimeMillis()}-${java.util.UUID.randomUUID().toString().take(8)}").canonicalFile
    dir.mkdirs()
    synchronized(lock) { copying.add(dir.path) }
    val files = mutableListOf<Map<String, Any?>>()
    val skipped = mutableListOf<Map<String, Any?>>()
    var total = 0L
    try {
      // Inside the try: if the event can't be sent, the folder still leaves `copying`.
      if (uris.isNotEmpty()) {
        try {
          sendEvent("onShareStart", mapOf("count" to uris.size))
        } catch (_: Throwable) {
          // Only the "Copying…" strip is lost; the share is still read.
        }
      }
      for ((i, uri) in uris.withIndex()) {
        val (name, size, named) = describe(ctx, uri, i)
        if (i >= MAX_FILES) {
          skipped.add(mapOf("name" to name, "named" to named, "reason" to "count"))
          continue
        }
        if (size != null && size > MAX_FILE_BYTES) {
          skipped.add(mapOf("name" to name, "named" to named, "reason" to "too-big", "size" to size))
          continue
        }
        if (size != null && total + size > MAX_SHARE_BYTES) {
          skipped.add(mapOf("name" to name, "named" to named, "reason" to "total", "size" to size))
          continue
        }
        // Checked before copying: a full phone is a sentence, not a half file.
        if (size != null && dir.usableSpace in 1 until size + SPACE_MARGIN_BYTES) {
          skipped.add(mapOf("name" to name, "named" to named, "reason" to "space", "size" to size))
          continue
        }
        try {
          val target = uniqueFile(dir, name)
          val copied = copy(ctx, uri, target, minOf(MAX_FILE_BYTES, MAX_SHARE_BYTES - total))
          if (copied < 0) {
            target.delete()
            skipped.add(mapOf("name" to name, "named" to named, "reason" to if (total + MAX_FILE_BYTES > MAX_SHARE_BYTES) "total" else "too-big"))
          } else {
            total += copied
            files.add(mapOf("uri" to Uri.fromFile(target).toString(), "name" to target.name, "size" to copied, "mime" to ctx.contentResolver.getType(uri), "named" to named))
          }
        } catch (e: IOException) {
          val full = e.message?.contains("ENOSPC") == true || e.message?.contains("No space", ignoreCase = true) == true
          skipped.add(mapOf("name" to name, "named" to named, "reason" to if (full) "space" else "unreadable"))
        } catch (e: SecurityException) {
          skipped.add(mapOf("name" to name, "named" to named, "reason" to "unreadable"))
        } catch (e: Exception) {
          // A provider that throws something else (IllegalArgumentException,
          // IllegalStateException…): this file is left out, the others go.
          skipped.add(mapOf("name" to name, "named" to named, "reason" to "unreadable"))
        }
      }
    } finally {
      synchronized(lock) { copying.remove(dir.path) }
    }
    return mapOf("dir" to dir.path, "files" to files, "skipped" to skipped, "text" to text, "subject" to subject)
  }

  /** The file's name and size, as the sharing app gave them, and whether
   * that's a real name. Without a display name, the media title (plus the
   * type's extension) is next; the uri's last segment is only an id
   * ("msf:1000032969"), so JS renames those after the song's title. */
  private fun describe(ctx: Context, uri: Uri, index: Int): Triple<String, Long?, Boolean> {
    var name: String? = null
    var size: Long? = null
    try {
      ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val s = c.getColumnIndex(OpenableColumns.SIZE)
          if (n >= 0 && !c.isNull(n)) name = c.getString(n)?.takeIf { it.isNotBlank() }
          if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
        }
      }
    } catch (_: Exception) {
      // A file:// uri or a provider without columns: fall back below.
    }
    if (name == null) {
      try {
        ctx.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.TITLE), null, null, null)?.use { c ->
          val t = c.getColumnIndex(MediaStore.MediaColumns.TITLE)
          if (c.moveToFirst() && t >= 0 && !c.isNull(t)) {
            val title = c.getString(t)?.takeIf { it.isNotBlank() }
            val ext = ctx.contentResolver.getType(uri)?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
            if (title != null) name = if (ext != null && !title.endsWith(".$ext", ignoreCase = true)) "$title.$ext" else title
          }
        }
      } catch (_: Exception) {
        // Most document providers have no title column.
      }
    }
    if (name != null) return Triple(clean(name!!), size, true)
    val fallback = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "shared-${index + 1}"
    return Triple(clean(fallback), size, false)
  }

  /** No path separators or control characters; never empty. */
  private fun clean(name: String): String {
    val c = name.replace(Regex("[/\\\\:*?\"<>|\\p{Cntrl}]"), "_").trim().trim('.').take(120)
    return c.ifEmpty { "shared" }
  }

  private fun uniqueFile(dir: File, name: String): File {
    var f = File(dir, name)
    var n = 2
    val stem = name.substringBeforeLast('.', name)
    val ext = name.substringAfterLast('.', "")
    while (f.exists()) {
      f = File(dir, if (ext.isEmpty()) "$stem ($n)" else "$stem ($n).$ext")
      n++
    }
    return f
  }

  /** Bytes copied, or -1 past `limit` (the size wasn't known up front). */
  private fun copy(ctx: Context, uri: Uri, target: File, limit: Long): Long {
    val input = ctx.contentResolver.openInputStream(uri) ?: throw IOException("unreadable")
    input.use { inp ->
      target.outputStream().use { out ->
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val n = inp.read(buf)
          if (n < 0) break
          total += n
          if (total > limit) return -1
          out.write(buf, 0, n)
        }
        return total
      }
    }
  }
}
