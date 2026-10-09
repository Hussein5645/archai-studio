# ArchAI native (Android and iOS tablets)

A Kotlin Multiplatform shell around the ArchAI web app. The web build in the repository root
runs in the system WebView (Android `WebView`, iOS `WKWebView`); this project adds what a
browser cannot do well: durable app storage, the system document pickers, the clipboard, and a
full-screen tablet app. Desktop stays on Electron (`npm run desktop` in the repository root).

## How it fits together

- **The web app** is built with `npm run build:web` and packaged as Compose resources under
  `files/web/` (see the `buildWeb`/`syncWebBundle` tasks in `shared/build.gradle.kts`), so both
  platforms ship the same bundle.
- **Origins.** Android serves it from `https://appassets.androidplatform.net/`, iOS from
  `archai://app/`. Neither origin touches the network. Paths without an extension are app routes
  and get `index.html` (`shared/.../web/WebBundle.kt`).
- **The bridge.** In the web app, `src/platform/native.ts` implements the same `Platform` as the
  Electron host, over the same `archai:` channels (`shared/ipc.ts`). Messages are JSON
  `{ id, channel, payload }`, answered by `BridgeRouter` (`shared/.../bridge/BridgeRouter.kt`),
  which validates every payload like the Electron main process does.
- **Host services** (`shared/.../host/`): `FileStorage` keeps one file per storage key in
  app-private storage. The platform files (`androidMain`, `iosMain`) provide the storage
  directory, document and image pickers, and clipboard.

## Build and run

Needs Node/npm (for the web build), JDK 17+, and the Android SDK. iOS needs a Mac with Xcode.

- Android app: `./gradlew :androidApp:assembleDebug`, or run `androidApp` from Android Studio.
  Needs API 31+ (Android 12). The first build runs `npm run build:web`.
- Reuse the existing `dist/` without rebuilding the web app: add `-PskipWebBuild`.
- iOS app: open `iosApp/iosApp.xcodeproj` in Xcode and run it (iPad or iPhone).
- Shared tests: `./gradlew :shared:testAndroidHostTest`.
- Debugging the page: Chrome `chrome://inspect` (Android debug builds) or Safari's Develop
  menu (iOS 16.4+).

The online asset catalog (R2) must allow the two app origins; they are listed in
`../r2/cors.json`. Apply that policy to the bucket (see `../docs/r2-setup.md`).
