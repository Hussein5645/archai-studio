package com.antai.archai.host

/**
 * What the native host provides to the web app: the Kotlin side of the web app's `Platform`
 * (src/platform/types.ts). Each platform implements these; `BridgeRouter` exposes them.
 */
class HostServices(
    val storage: HostStorage,
    val files: HostFiles,
    val clipboard: HostClipboard,
)

/** Durable key-value storage for documents, recents and settings (app-private). */
interface HostStorage {
    suspend fun get(key: String): String?
    suspend fun set(key: String, value: String)
    suspend fun delete(key: String)
    suspend fun keys(prefix: String): List<String>
}

/** A document the user picked. `path` is a host handle that `saveDocumentTo` accepts back. */
class OpenedDocument(val path: String, val name: String, val text: String)

/** An image the user picked, base64-encoded for the bridge. */
class PickedImage(val name: String, val mime: String, val base64: String)

/** System document pickers. Every method returns null when the user cancels. */
interface HostFiles {
    suspend fun openDocument(): OpenedDocument?
    /** Returns the handle of the saved document. */
    suspend fun saveDocumentAs(text: String, suggestedName: String): String?
    /** Writes to a handle from an earlier open/save; asks again (save as) if that is no longer possible. */
    suspend fun saveDocumentTo(path: String, text: String): String?
    suspend fun openImage(): PickedImage?
}

interface HostClipboard {
    suspend fun readText(): String?
    suspend fun writeText(text: String)
}
