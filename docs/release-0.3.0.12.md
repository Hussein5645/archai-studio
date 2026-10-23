# Archai 0.3.0.12

The Windows setup installs Archai without Unreal binaries, native addons, cooked content or build-worker resources. Setup and first launch do not download Unreal.

In a 3D view, choose **Unreal Engine** in the View inspector. Sign in, then choose **Download Unreal**. The optional pack is downloaded once into the Archai profile, verified against its authenticated SHA-256 manifest, extracted with bounded memory and activated without restarting Archai. Download progress, cancellation and retry are available. Reopening views uses the installed pack and the existing scene caches.

| Capability | Guest | Signed in |
| --- | --- | --- |
| Local modeling, projects, Default views and image exports | Available | Available |
| Default interactive desktop folder | Available | Available |
| Unreal rendering and Unreal image/folder exports | Sign in required | Optional Unreal pack required |
| VR export and interactive web links | Sign in required | Available |
| Default folder with VR entry | Unavailable | Available |

Guest folders contain the Default browser renderer and a desktop launcher, with VR disabled in scene metadata and no VR launcher. Signed-in Default folders can include WebXR. Unreal folders use a Windows player and PC OpenXR; web links use optimized WebXR rendering. Uploading a Windows folder does not run Unreal in a headset browser.

The private `archai-unreal` R2 bucket is served by the account Worker at `/runtime/0.3.0.12/manifest` and `/runtime/0.3.0.12/package`. Both require a valid server session and use private, non-cacheable responses. The desktop host checks account authorization for Unreal IPC and non-Default exports; signing out stops its scenes and cancels downloads without deleting projects or the installed pack. Account verification requires an internet connection, with a short in-process authorization cache.

Lightmass baking still requires a configured authoring worker with Unreal build tools. The optional viewing pack does not install the Unreal Editor. Existing bake locations remain supported on the development computer.

Build the base installer with `npm run dist:win`. Build the private optional pack with `node scripts/package-optional-unreal.mjs <native-stage> <new-output-folder>`. Publish only the base installer and its checksums to the public GitHub release/download bucket. Upload the optional ZIP and manifest to the private runtime bucket, then deploy `workers/archai-cloud` and `workers/web`.

Verification covers unit tests, guest and account UI paths, Worker authorization, archive traversal and corrupt-download rejection, base payload inspection, authenticated explicit installation, actual in-process Unreal rendering, sign-out and installed-pack reuse, and guest desktop folder startup. Hardware headset testing remains separate.
