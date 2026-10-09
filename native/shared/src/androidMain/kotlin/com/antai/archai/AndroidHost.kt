package com.antai.archai

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResultLauncher
import com.antai.archai.host.HostClipboard
import com.antai.archai.host.HostFiles
import com.antai.archai.host.OpenedDocument
import com.antai.archai.host.PickedImage
import com.antai.archai.host.StorageDirectory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileNotFoundException

/** App-private storage: files/archai-storage (removed with the app, never visible to others). */
class AndroidStorageDirectory(context: Context) : StorageDirectory {
    private val root = File(context.filesDir, "archai-storage")

    override suspend fun list(): List<String> = withContext(Dispatchers.IO) { root.list()?.toList() ?: emptyList() }

    override suspend fun read(name: String): String? = withContext(Dispatchers.IO) {
        File(root, name).takeIf { it.isFile }?.readText()
    }

    override suspend fun write(name: String, text: String) = withContext(Dispatchers.IO) {
        root.mkdirs()
        val target = File(root, name)
        val temporary = File(root, "$name.tmp")
        temporary.writeText(text)
        if (!temporary.renameTo(target)) {
            target.delete()
            if (!temporary.renameTo(target)) throw java.io.IOException("Could not write $name")
        }
    }

    override suspend fun delete(name: String) {
        withContext(Dispatchers.IO) { File(root, name).delete() }
    }
}

/**
 * Activity-result launchers for the system pickers, registered by the composable that hosts the
 * WebView. One pick runs at a time; starting another cancels (resolves null) the pending one.
 */
class PickerLaunchers {
    var openDocument: ActivityResultLauncher<Array<String>>? = null
    var createDocument: ActivityResultLauncher<String>? = null
    private var pending: CompletableDeferred<Uri?>? = null

    fun deliver(uri: Uri?) {
        pending?.complete(uri)
        pending = null
    }

    suspend fun <I> pick(launcher: ActivityResultLauncher<I>?, input: I): Uri? {
        if (launcher == null) return null
        pending?.complete(null)
        val result = CompletableDeferred<Uri?>()
        pending = result
        withContext(Dispatchers.Main) { launcher.launch(input) }
        return result.await()
    }
}

/**
 * Documents through the Storage Access Framework. Handles are content URIs with persisted
 * read/write permission, so "Save" can write back to a document opened in an earlier session.
 */
class AndroidFiles(private val context: Context, private val pickers: PickerLaunchers) : HostFiles {
    private val resolver get() = context.contentResolver

    override suspend fun openDocument(): OpenedDocument? {
        // .AIR has no registered MIME type, so the picker shows every file.
        val uri = pickers.pick(pickers.openDocument, arrayOf("*/*")) ?: return null
        persist(uri)
        return withContext(Dispatchers.IO) {
            val text = resolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: return@withContext null
            OpenedDocument(uri.toString(), displayName(uri) ?: "Untitled.AIR", text)
        }
    }

    override suspend fun saveDocumentAs(text: String, suggestedName: String): String? {
        val uri = pickers.pick(pickers.createDocument, suggestedName) ?: return null
        persist(uri)
        write(uri, text)
        return uri.toString()
    }

    override suspend fun saveDocumentTo(path: String, text: String): String? {
        val uri = Uri.parse(path)
        return try {
            write(uri, text)
            path
        } catch (_: SecurityException) {
            saveDocumentAs(text, displayName(uri) ?: "Untitled.AIR")
        } catch (_: FileNotFoundException) {
            saveDocumentAs(text, displayName(uri) ?: "Untitled.AIR")
        }
    }

    override suspend fun openImage(): PickedImage? {
        val uri = pickers.pick(pickers.openDocument, arrayOf("image/*")) ?: return null
        return withContext(Dispatchers.IO) {
            val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return@withContext null
            PickedImage(displayName(uri) ?: "image", resolver.getType(uri) ?: "image/png", Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
    }

    private suspend fun write(uri: Uri, text: String) = withContext(Dispatchers.IO) {
        // "wt": truncate, so a shorter document leaves no stale tail behind.
        val stream = resolver.openOutputStream(uri, "wt") ?: throw FileNotFoundException(uri.toString())
        stream.bufferedWriter().use { it.write(text) }
    }

    private fun persist(uri: Uri) {
        val readWrite = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        try {
            resolver.takePersistableUriPermission(uri, readWrite)
        } catch (_: SecurityException) {
            // Read-only providers: keep read access; saving falls back to "save as".
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: SecurityException) {
            }
        }
    }

    private suspend fun displayName(uri: Uri): String? = withContext(Dispatchers.IO) {
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (_: Exception) {
            null
        }
    }
}

class AndroidClipboard(private val context: Context) : HostClipboard {
    private val manager get() = context.getSystemService(ClipboardManager::class.java)

    override suspend fun readText(): String? = withContext(Dispatchers.Main) {
        manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
    }

    override suspend fun writeText(text: String) = withContext(Dispatchers.Main) {
        manager.setPrimaryClip(ClipData.newPlainText("ArchAI", text))
    }
}
