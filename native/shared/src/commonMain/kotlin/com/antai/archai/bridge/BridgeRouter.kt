package com.antai.archai.bridge

import com.antai.archai.host.HostServices
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** Channel names, identical to `IPC` in shared/ipc.ts (the Electron contract). */
object Channels {
    const val FILES_OPEN_DOCUMENT = "archai:files:openDocument"
    const val FILES_SAVE_DOCUMENT_AS = "archai:files:saveDocumentAs"
    const val FILES_SAVE_DOCUMENT_TO = "archai:files:saveDocumentTo"
    const val FILES_OPEN_IMAGE = "archai:files:openImage"
    const val FILES_SAVE_BINARY = "archai:files:saveBinary"
    const val CLIPBOARD_READ_IMAGE = "archai:clipboard:readImage"
    const val CLIPBOARD_WRITE_IMAGE = "archai:clipboard:writeImage"
    const val STORAGE_GET = "archai:storage:get"
    const val STORAGE_SET = "archai:storage:set"
    const val STORAGE_DELETE = "archai:storage:delete"
    const val STORAGE_KEYS = "archai:storage:keys"
    const val CLIPBOARD_READ_TEXT = "archai:clipboard:readText"
    const val CLIPBOARD_WRITE_TEXT = "archai:clipboard:writeText"
    const val MENU_SET = "archai:menu:set"
    const val WINDOW_SET_TITLE = "archai:window:setTitle"
}

/** A request the web app sent that the host refuses (unknown channel, invalid payload). */
class BridgeException(message: String) : Exception(message)

/**
 * Answers the web app's bridge messages (see src/platform/native.ts). Requests are JSON
 * `{ id, channel, payload }`; replies are `{ id, ok: true, value }` or `{ id, ok: false, error }`.
 * The page is treated as untrusted input, like the Electron main process treats the renderer:
 * every payload is validated with the same limits as the zod schemas in shared/ipc.ts.
 */
class BridgeRouter(private val host: HostServices) {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun handle(message: String): String {
        val request = try {
            json.parseToJsonElement(message).jsonObject
        } catch (_: Exception) {
            return reply(-1, error = "Malformed bridge message")
        }
        val id = request["id"]?.jsonPrimitive?.longOrNull ?: return reply(-1, error = "Bridge message without id")
        val channel = request["channel"]?.jsonPrimitive?.contentOrNull ?: return reply(id, error = "Bridge message without channel")
        val payload = request["payload"] as? JsonObject ?: JsonObject(emptyMap())
        return try {
            reply(id, value = dispatch(channel, payload))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            reply(id, error = failure.message ?: failure::class.simpleName ?: "Host error")
        }
    }

    private suspend fun dispatch(channel: String, payload: JsonObject): JsonElement = when (channel) {
        Channels.STORAGE_GET -> JsonPrimitive(host.storage.get(payload.key()))
        Channels.STORAGE_SET -> {
            host.storage.set(payload.key(), payload.string("value"))
            JsonNull
        }
        Channels.STORAGE_DELETE -> {
            host.storage.delete(payload.key())
            JsonNull
        }
        Channels.STORAGE_KEYS -> JsonArray(host.storage.keys(payload.string("prefix", max = 200)).map(::JsonPrimitive))
        Channels.FILES_OPEN_DOCUMENT -> host.files.openDocument()?.let {
            buildJsonObject {
                put("path", it.path)
                put("name", it.name)
                put("text", it.text)
            }
        } ?: JsonNull
        Channels.FILES_SAVE_DOCUMENT_AS -> pathResult(host.files.saveDocumentAs(payload.string("text"), payload.string("suggestedName", min = 1, max = 200)))
        Channels.FILES_SAVE_DOCUMENT_TO -> pathResult(host.files.saveDocumentTo(payload.string("path", min = 1), payload.string("text")))
        Channels.FILES_OPEN_IMAGE -> host.files.openImage()?.let {
            buildJsonObject {
                put("name", it.name)
                put("mime", it.mime)
                put("data", it.base64)
            }
        } ?: JsonNull
        Channels.CLIPBOARD_READ_TEXT -> JsonPrimitive(host.clipboard.readText())
        Channels.FILES_SAVE_BINARY -> pathResult(host.files.saveBinary(payload.string("data", min = 1, max = 64 * 1024 * 1024), payload.string("suggestedName", min = 1, max = 200), payload.string("mime", min = 1, max = 100)))
        Channels.CLIPBOARD_READ_IMAGE -> host.clipboard.readImage()?.let {
            buildJsonObject { put("name", it.name); put("mime", it.mime); put("data", it.base64) }
        } ?: JsonNull
        Channels.CLIPBOARD_WRITE_IMAGE -> {
            host.clipboard.writeImage(payload.string("data", min = 1, max = 64 * 1024 * 1024), payload["text"]?.jsonPrimitive?.contentOrNull)
            JsonNull
        }
        Channels.CLIPBOARD_WRITE_TEXT -> {
            host.clipboard.writeText(payload.string("text"))
            JsonNull
        }
        // No menu bar or window title on tablets; accepted so shared code needs no special cases.
        Channels.MENU_SET, Channels.WINDOW_SET_TITLE -> JsonNull
        else -> throw BridgeException("Unknown bridge channel: $channel")
    }

    private fun pathResult(path: String?): JsonElement = path?.let { buildJsonObject { put("path", it) } } ?: JsonNull

    private fun reply(id: Long, value: JsonElement? = null, error: String? = null): String = buildJsonObject {
        put("id", id)
        put("ok", error == null)
        if (error == null) put("value", value ?: JsonNull) else put("error", error)
    }.toString()
}

private fun JsonObject.string(name: String, min: Int = 0, max: Int = Int.MAX_VALUE): String {
    val value = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: throw BridgeException("Expected a string '$name'")
    if (value.length !in min..max) throw BridgeException("'$name' must be $min-$max characters")
    return value
}

private fun JsonObject.key(): String = string("key", min = 1, max = 200)
