package com.antai.archai

import com.antai.archai.bridge.BridgeRouter
import com.antai.archai.bridge.Channels
import com.antai.archai.host.FileStorage
import com.antai.archai.host.HostClipboard
import com.antai.archai.host.HostFiles
import com.antai.archai.host.HostServices
import com.antai.archai.host.OpenedDocument
import com.antai.archai.host.PickedImage
import com.antai.archai.host.StorageDirectory
import com.antai.archai.web.bundlePath
import com.antai.archai.web.mimeTypeFor
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class MemoryDirectory : StorageDirectory {
    val files = linkedMapOf<String, String>()
    override suspend fun list() = files.keys.toList()
    override suspend fun read(name: String) = files[name]
    override suspend fun write(name: String, text: String) {
        files[name] = text
    }
    override suspend fun delete(name: String) {
        files.remove(name)
    }
}

private class FakeFiles : HostFiles {
    var saved: Pair<String, String>? = null
    override suspend fun openDocument() = OpenedDocument("content://docs/1", "Tower.AIR", "{}")
    override suspend fun saveDocumentAs(text: String, suggestedName: String): String {
        saved = suggestedName to text
        return "content://docs/$suggestedName"
    }
    override suspend fun saveDocumentTo(path: String, text: String) = path
    override suspend fun openImage(): PickedImage? = null
}

private class FakeClipboard : HostClipboard {
    var text: String? = null
    override suspend fun readText() = text
    override suspend fun writeText(text: String) {
        this.text = text
    }
}

class WebBundleTest {
    @Test
    fun mapsFilesAndAppRoutes() {
        assertEquals("index.html", bundlePath("/"))
        assertEquals("index.html", bundlePath("/meridian-tower-doc_example_meridian_tower"))
        assertEquals("index.html", bundlePath("/modeling"))
        assertEquals("assets/index-abc123.js", bundlePath("/assets/index-abc123.js"))
        assertEquals("catalog/Draw/North Arrows/north-arrow/2d.png", bundlePath("/catalog/Draw/North%20Arrows/north-arrow/2d.png"))
        assertEquals("examples/meridian-tower.AIR", bundlePath("/examples/meridian-tower.AIR"))
    }

    @Test
    fun refusesPathsLeavingTheBundle() {
        assertNull(bundlePath("/../secret.txt"))
        assertNull(bundlePath("/assets/%2e%2e/x.js"))
    }

    @Test
    fun servesModulesAndWasmWithTheirTypes() {
        assertEquals("text/javascript", mimeTypeFor("assets/index.js"))
        assertEquals("application/wasm", mimeTypeFor("assets/manifold.wasm"))
    }
}

class FileStorageTest {
    @Test
    fun roundTripsKeysExactlyAndListsByPrefix() = runTest {
        val directory = MemoryDirectory()
        val storage = FileStorage(directory)
        storage.set("archai:cai:pkg:A", "upper")
        storage.set("archai:cai:pkg:a", "lower")
        storage.set("session", "{}")
        assertEquals("upper", storage.get("archai:cai:pkg:A"))
        assertEquals("lower", storage.get("archai:cai:pkg:a"))
        assertEquals(setOf("archai:cai:pkg:A", "archai:cai:pkg:a"), storage.keys("archai:cai:pkg:").toSet())
        // Case-only differences never share a file (case-insensitive filesystems).
        assertEquals(3, directory.files.keys.map { it.lowercase() }.toSet().size)
        storage.delete("session")
        assertNull(storage.get("session"))
    }

    @Test
    fun keepsFileNamesShortForLongKeys() = runTest {
        val directory = MemoryDirectory()
        FileStorage(directory).set("k".repeat(200), "v")
        assertTrue(directory.files.keys.single().length < 160)
    }
}

class BridgeRouterTest {
    private val files = FakeFiles()
    private val clipboard = FakeClipboard()
    private val router = BridgeRouter(HostServices(FileStorage(MemoryDirectory()), files, clipboard))

    private suspend fun call(channel: String, payload: String = "null"): JsonObject =
        Json.parseToJsonElement(router.handle("""{"id":7,"channel":"$channel","payload":$payload}""")).jsonObject

    @Test
    fun answersStorageAndClipboardRequests() = runTest {
        assertTrue(call(Channels.STORAGE_SET, """{"key":"session","value":"{\"a\":1}"}""")["ok"]!!.jsonPrimitive.boolean)
        val get = call(Channels.STORAGE_GET, """{"key":"session"}""")
        assertEquals(7, get["id"]!!.jsonPrimitive.content.toInt())
        assertEquals("""{"a":1}""", get["value"]!!.jsonPrimitive.content)
        call(Channels.CLIPBOARD_WRITE_TEXT, """{"text":"copied"}""")
        assertEquals("copied", clipboard.text)
    }

    @Test
    fun returnsDocumentsAndSavedPaths() = runTest {
        val opened = call(Channels.FILES_OPEN_DOCUMENT)["value"]!!.jsonObject
        assertEquals("Tower.AIR", opened["name"]!!.jsonPrimitive.content)
        val saved = call(Channels.FILES_SAVE_DOCUMENT_AS, """{"text":"{}","suggestedName":"Plan.AIR"}""")
        assertEquals("content://docs/Plan.AIR", saved["value"]!!.jsonObject["path"]!!.jsonPrimitive.content)
    }

    @Test
    fun rejectsInvalidPayloadsAndUnknownChannels() = runTest {
        val empty = call(Channels.STORAGE_GET, """{"key":""}""")
        assertEquals(false, empty["ok"]!!.jsonPrimitive.boolean)
        val wrongType = call(Channels.STORAGE_SET, """{"key":"x","value":5}""")
        assertEquals(false, wrongType["ok"]!!.jsonPrimitive.boolean)
        val unknown = call("archai:shell:exec", """{"cmd":"rm"}""")
        assertTrue(unknown["error"]!!.jsonPrimitive.content.contains("Unknown bridge channel"))
        val malformed = Json.parseToJsonElement(router.handle("not json")).jsonObject
        assertEquals(false, malformed["ok"]!!.jsonPrimitive.boolean)
    }
}
