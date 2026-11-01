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
// consumed once read, so a reload doesn't share it twice.
//
// Limits are checked here too so a huge file is never copied:
// MAX_FILES / MAX_FILE_BYTES match src/lib/outbox.ts.

private const val MAX_FILES = 20
private const val MAX_FILE_BYTES = 500L * 1024 * 1024
private const val MAX_TEXT_CHARS = 20_000

class HivoShareModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HivoShare")
    Events("onShare")

    // A share that started the app (or arrived while it was in the background).
    AsyncFunction("takeShared") {
      val activity = appContext.currentActivity ?: return@AsyncFunction null
      val shared = read(activity.intent) ?: return@AsyncFunction null
      // Consumed: the same intent isn't read again after a reload.
      activity.intent = Intent(activity.intent).apply {
        action = Intent.ACTION_MAIN
        removeExtra(Intent.EXTRA_STREAM)
        removeExtra(Intent.EXTRA_TEXT)
      }
      shared
    }

    // A share while Hivo is open (singleTask activity). Copying can take a
    // while (up to 20 big files): off the main thread, or Android shows
    // "not responding".
    OnNewIntent { intent ->
      Thread {
        val shared = read(intent) ?: return@Thread
        sendEvent("onShare", shared)
      }.start()
    }

    // Removes the copies once JS has moved them into the outbox.
    AsyncFunction("clearCache") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      File(ctx.cacheDir, "hivo-share").deleteRecursively()
    }
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

    val dir = File(ctx.cacheDir, "hivo-share/${System.currentTimeMillis()}")
    dir.mkdirs()
    val files = mutableListOf<Map<String, Any?>>()
    val skipped = mutableListOf<Map<String, Any?>>()
    for ((i, uri) in uris.withIndex()) {
      val (name, size, named) = describe(ctx, uri, i)
      if (i >= MAX_FILES) {
        skipped.add(mapOf("name" to name, "reason" to "count"))
        continue
      }
      if (size != null && size > MAX_FILE_BYTES) {
        skipped.add(mapOf("name" to name, "reason" to "too-big", "size" to size))
        continue
      }
      try {
        val target = uniqueFile(dir, name)
        val copied = copy(ctx, uri, target)
        if (copied < 0) {
          target.delete()
          skipped.add(mapOf("name" to name, "reason" to "too-big"))
        } else {
          files.add(mapOf("uri" to Uri.fromFile(target).toString(), "name" to target.name, "size" to copied, "mime" to ctx.contentResolver.getType(uri), "named" to named))
        }
      } catch (e: IOException) {
        val full = e.message?.contains("ENOSPC") == true || e.message?.contains("No space", ignoreCase = true) == true
        skipped.add(mapOf("name" to name, "reason" to if (full) "space" else "unreadable"))
      } catch (e: SecurityException) {
        skipped.add(mapOf("name" to name, "reason" to "unreadable"))
      }
    }
    return mapOf("files" to files, "skipped" to skipped, "text" to text, "subject" to subject)
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

  /** Bytes copied, or -1 past MAX_FILE_BYTES (the size wasn't known up front). */
  private fun copy(ctx: Context, uri: Uri, target: File): Long {
    val input = ctx.contentResolver.openInputStream(uri) ?: throw IOException("unreadable")
    input.use { inp ->
      target.outputStream().use { out ->
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val n = inp.read(buf)
          if (n < 0) break
          total += n
          if (total > MAX_FILE_BYTES) return -1
          out.write(buf, 0, n)
        }
        return total
      }
    }
  }
}
