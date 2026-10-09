package com.antai.archai

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.antai.archai.bridge.BridgeRouter
import com.antai.archai.host.FileStorage
import com.antai.archai.host.HostServices
import com.antai.archai.web.readWebAsset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * The app's origin. appassets.androidplatform.net is reserved for exactly this (it never reaches
 * the network), and being https makes it a secure context: ES modules, IndexedDB and WebGL
 * behave as in a browser.
 */
private const val ORIGIN = "https://appassets.androidplatform.net"

@Composable
actual fun ArchaiWebHost(modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pickers = remember { PickerLaunchers() }
    pickers.openDocument = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument(), pickers::deliver)
    pickers.createDocument = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream"), pickers::deliver)
    val router = remember {
        val app = context.applicationContext
        BridgeRouter(HostServices(FileStorage(AndroidStorageDirectory(app)), AndroidFiles(app, pickers), AndroidClipboard(app)))
    }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var canGoBack by remember { mutableStateOf(false) }

    // Back walks the web app's own history (e.g. modeling → board) before leaving the app.
    BackHandler(enabled = canGoBack) { webView?.goBack() }

    AndroidView(
        modifier = modifier,
        factory = { viewContext ->
            createWebView(viewContext, router, scope) { canGoBack = it }.also { webView = it }
        },
        onRelease = { it.destroy() },
    )
}

@SuppressLint("SetJavaScriptEnabled")
private fun createWebView(context: Context, router: BridgeRouter, scope: CoroutineScope, onHistoryChanged: (Boolean) -> Unit): WebView {
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
    return WebView(context).apply {
        // Without explicit match-parent params the WebView is wrap-content, sizes the page to its
        // content, and the app's `html, body, #root { height: 100% }` layout collapses to 0.
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // The board handles pinch-zoom itself; browser zoom would fight it.
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            // The device for the web app (src/ui/vrDevice.tsx): headsets such as Meta Quest ("Oculus")
            // and Pico report their maker here even when the model name says nothing.
            userAgentString = "$userAgentString ArchAI-Android (${android.os.Build.MANUFACTURER}; ${android.os.Build.MODEL})"
        }
        // A tablet left on a drawing should not dim mid-work.
        keepScreenOn = true
        webViewClient = ArchaiWebViewClient(onHistoryChanged)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Exposes window.ArchaiNativeHost to our origin only, main frame only.
            WebViewCompat.addWebMessageListener(this, "ArchaiNativeHost", setOf(ORIGIN)) { _, message, _, isMainFrame, replyProxy ->
                val data = message.data
                if (!isMainFrame || data == null) return@addWebMessageListener
                scope.launch { replyProxy.postMessage(router.handle(data)) }
            }
        }
        loadUrl("$ORIGIN/")
    }
}

private class ArchaiWebViewClient(private val onHistoryChanged: (Boolean) -> Unit) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if ("${url.scheme}://${url.host}" != ORIGIN) return null // network requests (catalog) pass through
        // Called on a WebView background thread, so blocking on the resource read is fine.
        val asset = runBlocking { readWebAsset(url.encodedPath ?: "/") }
            ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "Not found".byteInputStream())
        val encoding = if (asset.mimeType.startsWith("text/") || asset.mimeType == "application/json") "utf-8" else null
        return WebResourceResponse(asset.mimeType, encoding, asset.bytes.inputStream())
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if ("${url.scheme}://${url.host}" == ORIGIN) return false
        // Links leaving the app open in the browser instead of replacing the app.
        try {
            view.context.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
        }
        return true
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        onHistoryChanged(view.canGoBack())
    }
}
