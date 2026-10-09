@file:OptIn(ExperimentalForeignApi::class, BetaInteropApi::class, ExperimentalComposeUiApi::class)

package com.antai.archai

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.UIKitInteropInteractionMode
import androidx.compose.ui.viewinterop.UIKitInteropProperties
import androidx.compose.ui.viewinterop.UIKitView
import com.antai.archai.bridge.BridgeRouter
import com.antai.archai.host.FileStorage
import com.antai.archai.host.HostServices
import com.antai.archai.web.readWebAsset
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.ObjCSignatureOverride
import kotlinx.cinterop.readValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import platform.CoreGraphics.CGRectZero
import platform.Foundation.NSHTTPURLResponse
import platform.Foundation.NSSelectorFromString
import platform.Foundation.NSURL
import platform.Foundation.NSURLComponents
import platform.Foundation.NSURLRequest
import platform.UIKit.UIApplication
import platform.UIKit.UIScrollViewContentInsetAdjustmentBehavior
import platform.WebKit.WKContentWorld
import platform.WebKit.WKNavigationAction
import platform.WebKit.WKNavigationActionPolicy
import platform.WebKit.WKNavigationDelegateProtocol
import platform.WebKit.WKScriptMessage
import platform.WebKit.WKScriptMessageHandlerWithReplyProtocol
import platform.WebKit.WKURLSchemeHandlerProtocol
import platform.WebKit.WKURLSchemeTaskProtocol
import platform.WebKit.WKUserContentController
import platform.WebKit.WKWebView
import platform.WebKit.WKWebViewConfiguration
import platform.darwin.NSObject

/** The app's origin: bundled files are served by BundleSchemeHandler, never the network. */
private const val SCHEME = "archai"
private const val ORIGIN = "$SCHEME://app"

@Composable
actual fun ArchaiWebHost(modifier: Modifier) {
    val scope = rememberCoroutineScope()
    val host = remember { IosWebHost(scope) }
    UIKitView(
        factory = { host.webView },
        modifier = modifier,
        // Touches go straight to the web view: the board's drags and pinches must not wait for
        // Compose to decide whether the gesture is its own.
        properties = UIKitInteropProperties(interactionMode = UIKitInteropInteractionMode.NonCooperative, isNativeAccessibilityEnabled = true),
    )
}

/** Owns the web view and the delegates it only references weakly. */
private class IosWebHost(scope: CoroutineScope) {
    private val router = BridgeRouter(HostServices(FileStorage(IosStorageDirectory()), IosFiles(), IosClipboard()))
    private val navigation = ExternalLinkDelegate()

    val webView: WKWebView = run {
        val configuration = WKWebViewConfiguration().apply {
            setURLSchemeHandler(BundleSchemeHandler(scope), forURLScheme = SCHEME)
            userContentController.addScriptMessageHandlerWithReply(BridgeMessageHandler(router, scope), contentWorld = WKContentWorld.pageWorld, name = "archaiNative")
        }
        WKWebView(frame = CGRectZero.readValue(), configuration = configuration).apply {
            navigationDelegate = navigation
            allowsLinkPreview = false
            scrollView.bounces = false
            // Compose already keeps the view inside the safe area.
            scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentBehavior.UIScrollViewContentInsetAdjustmentNever
            // Safari Web Inspector (iOS 16.4+; the selector check keeps older versions working).
            if (respondsToSelector(NSSelectorFromString("setInspectable:"))) setInspectable(true)
            loadRequest(NSURLRequest(uRL = NSURL(string = "$ORIGIN/")))
        }
    }
}

/** Serves the bundled web build (see web/WebBundle.kt) for archai://app/… requests. */
private class BundleSchemeHandler(private val scope: CoroutineScope) : NSObject(), WKURLSchemeHandlerProtocol {
    /** Tasks WebKit cancelled: they must not be answered afterwards (that throws). */
    private val stopped = mutableSetOf<WKURLSchemeTaskProtocol>()

    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, startURLSchemeTask: WKURLSchemeTaskProtocol) {
        val task = startURLSchemeTask
        val url = task.request.URL ?: return
        // The encoded path: WebBundle decodes it once (NSURL.path would already be decoded).
        val path = NSURLComponents(uRL = url, resolvingAgainstBaseURL = false).percentEncodedPath ?: "/"
        scope.launch {
            val asset = withContext(Dispatchers.Default) { readWebAsset(path) }
            if (stopped.remove(task)) return@launch
            val headers = mapOf<Any?, Any?>(
                "Content-Type" to (asset?.mimeType ?: "text/plain"),
                "Content-Length" to (asset?.bytes?.size ?: 0).toString(),
            )
            task.didReceiveResponse(NSHTTPURLResponse(uRL = url, statusCode = if (asset != null) 200 else 404, HTTPVersion = "HTTP/1.1", headerFields = headers))
            task.didReceiveData((asset?.bytes ?: ByteArray(0)).toNSData())
            task.didFinish()
        }
    }

    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, stopURLSchemeTask: WKURLSchemeTaskProtocol) {
        stopped.add(stopURLSchemeTask)
    }
}

/** window.webkit.messageHandlers.archaiNative.postMessage(json) resolves with the router's reply. */
private class BridgeMessageHandler(private val router: BridgeRouter, private val scope: CoroutineScope) : NSObject(), WKScriptMessageHandlerWithReplyProtocol {
    override fun userContentController(userContentController: WKUserContentController, didReceiveScriptMessage: WKScriptMessage, replyHandler: (Any?, String?) -> Unit) {
        val body = didReceiveScriptMessage.body as? String
        if (body == null || !didReceiveScriptMessage.frameInfo.mainFrame) {
            replyHandler(null, "Bridge messages must be JSON strings from the main frame")
            return
        }
        scope.launch { replyHandler(router.handle(body), null) }
    }
}

/** Links leaving the app open in Safari instead of replacing the app. */
private class ExternalLinkDelegate : NSObject(), WKNavigationDelegateProtocol {
    override fun webView(webView: WKWebView, decidePolicyForNavigationAction: WKNavigationAction, decisionHandler: (WKNavigationActionPolicy) -> Unit) {
        val url = decidePolicyForNavigationAction.request.URL
        val mainFrame = decidePolicyForNavigationAction.targetFrame?.mainFrame ?: true
        if (url == null || url.scheme == SCHEME || !mainFrame) {
            decisionHandler(WKNavigationActionPolicy.WKNavigationActionPolicyAllow)
            return
        }
        UIApplication.sharedApplication.openURL(url, options = emptyMap<Any?, Any>(), completionHandler = null)
        decisionHandler(WKNavigationActionPolicy.WKNavigationActionPolicyCancel)
    }
}
