package com.antai.archai

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

/**
 * The whole native app: the ArchAI web app in a WebView, kept clear of system bars, notches and
 * rounded corners (the web app itself does not pad for safe areas).
 */
@Composable
fun App() {
    Box(Modifier.fillMaxSize().background(Color.White).safeDrawingPadding()) {
        ArchaiWebHost(Modifier.fillMaxSize())
    }
}

/**
 * The platform WebView serving the bundled web build from the app origin and answering the web
 * app's bridge messages (see bridge/BridgeRouter.kt).
 */
@Composable
expect fun ArchaiWebHost(modifier: Modifier)
