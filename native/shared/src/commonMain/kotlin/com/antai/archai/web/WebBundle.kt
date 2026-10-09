package com.antai.archai.web

import archai.shared.generated.resources.Res
import org.jetbrains.compose.resources.ExperimentalResourceApi

/** One file of the bundled web build, ready to hand to the WebView. */
class WebAsset(val bytes: ByteArray, val mimeType: String)

private const val INDEX = "index.html"

/**
 * Maps a request path on the app's origin to a file of the bundled web build (relative to
 * files/web/). The web app routes with real paths (`/`, `/<project>`, `/modeling`), so any path
 * whose last segment has no extension is an app route and gets index.html. Returns null for
 * paths that try to leave the bundle.
 */
fun bundlePath(requestPath: String): String? {
    val segments = percentDecode(requestPath).split('/').filter { it.isNotEmpty() }
    if (segments.any { it == "." || it == ".." || it.contains('\\') }) return null
    val last = segments.lastOrNull() ?: return INDEX
    return if ('.' in last) segments.joinToString("/") else INDEX
}

/** Reads the file a request path maps to, or null when the bundle has no such file. */
@OptIn(ExperimentalResourceApi::class)
suspend fun readWebAsset(requestPath: String): WebAsset? {
    val path = bundlePath(requestPath) ?: return null
    val bytes = try {
        Res.readBytes("files/web/$path")
    } catch (_: Exception) {
        return null
    }
    return WebAsset(bytes, mimeTypeFor(path))
}

fun mimeTypeFor(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
    "html" -> "text/html"
    "js", "mjs" -> "text/javascript"
    "css" -> "text/css"
    "json", "map" -> "application/json"
    "wasm" -> "application/wasm"
    "svg" -> "image/svg+xml"
    "png" -> "image/png"
    "jpg", "jpeg" -> "image/jpeg"
    "webp" -> "image/webp"
    "gif" -> "image/gif"
    "ico" -> "image/x-icon"
    "woff" -> "font/woff"
    "woff2" -> "font/woff2"
    "ttf" -> "font/ttf"
    "otf" -> "font/otf"
    "glb" -> "model/gltf-binary"
    "gltf" -> "model/gltf+json"
    "txt" -> "text/plain"
    else -> "application/octet-stream"
}

/** Decodes %XX escapes (UTF-8); malformed escapes are kept as written. */
internal fun percentDecode(value: String): String {
    if ('%' !in value) return value
    val out = ArrayList<Byte>(value.length)
    var index = 0
    while (index < value.length) {
        val hex = if (value[index] == '%' && index + 2 < value.length) value.substring(index + 1, index + 3).toIntOrNull(16) else null
        if (hex != null) {
            out.add(hex.toByte())
            index += 3
            continue
        }
        // Plain text up to the next escape, encoded as a whole so surrogate pairs stay intact.
        val next = value.indexOf('%', index + 1).let { if (it < 0) value.length else it }
        value.substring(index, next).encodeToByteArray().forEach { out.add(it) }
        index = next
    }
    return out.toByteArray().decodeToString()
}
