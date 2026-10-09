@file:OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)

package com.antai.archai

import com.antai.archai.host.HostClipboard
import com.antai.archai.host.HostFiles
import com.antai.archai.host.OpenedDocument
import com.antai.archai.host.PickedImage
import com.antai.archai.host.StorageDirectory
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.CompletableDeferred
import platform.Foundation.NSApplicationSupportDirectory
import platform.Foundation.NSData
import platform.Foundation.NSFileManager
import platform.Foundation.NSSearchPathForDirectoriesInDomains
import platform.Foundation.NSString
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSURL
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.NSUserDefaults
import platform.Foundation.NSUserDomainMask
import platform.Foundation.base64EncodedStringWithOptions
import platform.Foundation.create
import platform.Foundation.dataWithBytes
import platform.Foundation.dataWithContentsOfURL
import platform.Foundation.stringWithContentsOfFile
import platform.Foundation.stringWithContentsOfURL
import platform.Foundation.writeToFile
import platform.Foundation.writeToURL
import platform.UIKit.UIApplication
import platform.UIKit.UIDocumentPickerDelegateProtocol
import platform.UIKit.UIDocumentPickerViewController
import platform.UIKit.UIPasteboard
import platform.UIKit.UIViewController
import platform.UniformTypeIdentifiers.UTType
import platform.UniformTypeIdentifiers.UTTypeData
import platform.UniformTypeIdentifiers.UTTypeImage
import platform.darwin.NSObject

internal fun ByteArray.toNSData(): NSData =
    if (isEmpty()) NSData() else usePinned { NSData.dataWithBytes(it.addressOf(0), size.toULong()) }

/** App-private storage: Application Support/archai-storage (backed up, never user-visible). */
class IosStorageDirectory : StorageDirectory {
    private val root: String by lazy {
        val base = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, true).first() as String
        "$base/archai-storage".also { NSFileManager.defaultManager.createDirectoryAtPath(it, withIntermediateDirectories = true, attributes = null, error = null) }
    }

    override suspend fun list(): List<String> =
        NSFileManager.defaultManager.contentsOfDirectoryAtPath(root, error = null)?.filterIsInstance<String>() ?: emptyList()

    override suspend fun read(name: String): String? = NSString.stringWithContentsOfFile("$root/$name", encoding = NSUTF8StringEncoding, error = null)

    override suspend fun write(name: String, text: String) {
        // atomically = true: written to a temporary file and renamed into place.
        if (!NSString.create(string = text).writeToFile("$root/$name", atomically = true, encoding = NSUTF8StringEncoding, error = null)) {
            throw IllegalStateException("Could not write $name")
        }
    }

    override suspend fun delete(name: String) {
        NSFileManager.defaultManager.removeItemAtPath("$root/$name", error = null)
    }
}

class IosClipboard : HostClipboard {
    override suspend fun readText(): String? = UIPasteboard.generalPasteboard.string
    override suspend fun writeText(text: String) {
        UIPasteboard.generalPasteboard.string = text
    }
}

/**
 * Documents through UIDocumentPickerViewController. Handles are file URLs; a security-scoped
 * bookmark per handle (in user defaults) lets "Save" write back in later sessions.
 */
class IosFiles : HostFiles {
    private val defaults get() = NSUserDefaults.standardUserDefaults

    override suspend fun openDocument(): OpenedDocument? {
        val url = pick(UIDocumentPickerViewController(forOpeningContentTypes = listOf(UTTypeData), asCopy = false)) ?: return null
        return url.withSecurityScope {
            val text = NSString.stringWithContentsOfURL(url, encoding = NSUTF8StringEncoding, error = null) ?: return@withSecurityScope null
            keepBookmark(url)
            OpenedDocument(url.absoluteString ?: return@withSecurityScope null, url.lastPathComponent ?: "Untitled.AIR", text)
        }
    }

    override suspend fun saveDocumentAs(text: String, suggestedName: String): String? {
        // Export moves a temporary file to wherever the user picks.
        val temporary = NSURL.fileURLWithPath("${NSTemporaryDirectory()}/${suggestedName.replace('/', '_')}")
        if (!NSString.create(string = text).writeToURL(temporary, atomically = true, encoding = NSUTF8StringEncoding, error = null)) return null
        val url = pick(UIDocumentPickerViewController(forExportingURLs = listOf(temporary), asCopy = false)) ?: return null
        url.withSecurityScope { keepBookmark(url) }
        return url.absoluteString
    }

    override suspend fun saveDocumentTo(path: String, text: String): String? {
        val url = resolve(path)
        val written = url?.withSecurityScope {
            NSString.create(string = text).writeToURL(url, atomically = false, encoding = NSUTF8StringEncoding, error = null)
        } ?: false
        if (written) return path
        // No longer writable (moved, deleted, permission gone): ask where to save instead.
        return saveDocumentAs(text, NSURL(string = path).lastPathComponent ?: "Untitled.AIR")
    }

    override suspend fun openImage(): PickedImage? {
        val url = pick(UIDocumentPickerViewController(forOpeningContentTypes = listOf(UTTypeImage), asCopy = true)) ?: return null
        val data = NSData.dataWithContentsOfURL(url) ?: return null
        val mime = UTType.typeWithFilenameExtension(url.pathExtension ?: "")?.preferredMIMEType ?: "image/png"
        return PickedImage(url.lastPathComponent ?: "image", mime, data.base64EncodedStringWithOptions(0u))
    }

    private fun keepBookmark(url: NSURL) {
        val bookmark = url.bookmarkDataWithOptions(0u, includingResourceValuesForKeys = null, relativeToURL = null, error = null) ?: return
        defaults.setObject(bookmark, forKey = bookmarkKey(url.absoluteString ?: return))
    }

    private fun resolve(path: String): NSURL? {
        val bookmark = defaults.dataForKey(bookmarkKey(path)) ?: return null
        return NSURL.URLByResolvingBookmarkData(bookmark, options = 0u, relativeToURL = null, bookmarkDataIsStale = null, error = null)
    }

    private fun bookmarkKey(path: String) = "archai.bookmark.$path"

    private suspend fun pick(picker: UIDocumentPickerViewController): NSURL? {
        val presenter = topViewController() ?: return null
        val result = CompletableDeferred<NSURL?>()
        // The picker only holds its delegate weakly; this local keeps it alive until it answers.
        val delegate = PickerDelegate(result)
        picker.delegate = delegate
        picker.allowsMultipleSelection = false
        presenter.presentViewController(picker, animated = true, completion = null)
        return result.await().also { picker.delegate = null }
    }

    private fun topViewController(): UIViewController? {
        var controller = UIApplication.sharedApplication.keyWindow?.rootViewController
        while (controller?.presentedViewController != null) controller = controller.presentedViewController
        return controller
    }
}

private class PickerDelegate(private val result: CompletableDeferred<NSURL?>) : NSObject(), UIDocumentPickerDelegateProtocol {
    override fun documentPicker(controller: UIDocumentPickerViewController, didPickDocumentsAtURLs: List<*>) {
        result.complete(didPickDocumentsAtURLs.firstOrNull() as? NSURL)
    }

    override fun documentPickerWasCancelled(controller: UIDocumentPickerViewController) {
        result.complete(null)
    }
}

private inline fun <T> NSURL.withSecurityScope(block: () -> T): T {
    val started = startAccessingSecurityScopedResource()
    try {
        return block()
    } finally {
        if (started) stopAccessingSecurityScopedResource()
    }
}
