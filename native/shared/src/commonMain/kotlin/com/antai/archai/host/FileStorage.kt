package com.antai.archai.host

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A flat directory of text files; each platform provides one in app-private storage. */
interface StorageDirectory {
    suspend fun list(): List<String>
    suspend fun read(name: String): String?
    /** Replaces the file atomically (write to a temporary file, then rename). */
    suspend fun write(name: String, text: String)
    suspend fun delete(name: String)
}

@Serializable
private class StoredEntry(val key: String, val value: String)

/**
 * Key-value storage as one file per key, like the Electron host: the file name is the key made
 * filesystem-safe plus a hash of the exact key (so keys that sanitise alike, or differ only in
 * case, never share a file), and the file holds `{ key, value }` so the key is recovered exactly.
 */
class FileStorage(private val directory: StorageDirectory) : HostStorage {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun get(key: String): String? = entry(fileName(key))?.takeIf { it.key == key }?.value

    override suspend fun set(key: String, value: String) {
        directory.write(fileName(key), json.encodeToString(StoredEntry.serializer(), StoredEntry(key, value)))
    }

    override suspend fun delete(key: String) {
        directory.delete(fileName(key))
    }

    override suspend fun keys(prefix: String): List<String> {
        // The readable part of the name is a (lossy) prefix of the key: only open files that can match.
        val stem = sanitize(prefix)
        return directory.list()
            .filter { it.endsWith(SUFFIX) && it.startsWith(stem) }
            .mapNotNull { entry(it)?.key }
            .filter { it.startsWith(prefix) }
    }

    private suspend fun entry(name: String): StoredEntry? {
        val text = directory.read(name) ?: return null
        // A corrupt entry reads as missing rather than failing the whole call.
        return try {
            json.decodeFromString(StoredEntry.serializer(), text)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        private const val SUFFIX = ".json"
        private const val READABLE_LENGTH = 120

        fun fileName(key: String): String = "${sanitize(key)}-${fnv1a(key)}$SUFFIX"

        private fun sanitize(key: String): String =
            key.map { if (it.isLetterOrDigit() && it.code < 128 || it == '_' || it == '.' || it == '-') it else '_' }
                .joinToString("")
                .take(READABLE_LENGTH)

        /** 64-bit FNV-1a of the key's UTF-8 bytes, as 16 hex digits. */
        private fun fnv1a(key: String): String {
            var hash = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
            for (byte in key.encodeToByteArray()) {
                hash = hash xor (byte.toLong() and 0xff)
                hash *= 0x100000001b3L
            }
            return hash.toULong().toString(16).padStart(16, '0')
        }
    }
}
