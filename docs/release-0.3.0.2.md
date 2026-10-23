# ArchAI 0.3.0.2 — Standalone Unreal preview candidate

This continues the 0.3 rendering integration. The native Board renderer remains the modeling
engine. A separate C++ Unreal application provides the local visualization companion.
The standalone runtime has passed a rendered sample import and live replacement checks.

## Implemented

- A C++ Game target, independent of editor Python, with runtime glTF scene import through
  Interchange. Geometry is checked against its SHA-256 digest before import.
- Stable Archai object IDs are mapped from glTF node indices onto imported actors and mesh components. A replacement scene is hidden
  until import and ID validation complete; failed imports retain the previous scene.
- Source sun direction, sky intensity, sun intensity, exposure and initial camera transfer.
  Geometry updates preserve the Unreal viewer's camera. Lighting-only updates avoid reimport.
- Default fly navigation, frame-scene and close controls.
- Per-window desktop sessions with random handoff tokens, validated packages, revisioned
  tickets, process status, cancellation and cleanup on close.
- Immutable model files and atomic session manifests. Old model revisions are removed only
  after the runtime acknowledges a replacement.
- Open/synchronize/close controls and opt-in live synchronization in Archai Render.
- Build, offscreen GPU smoke-test and rendered-capture tools for the packaged viewer.
- Packaging support to include the companion beside Archai in the Windows installer.

## Limits

The target is Windows and Unreal 5.8. Dynamic high-quality lighting is configured for DX12 and
hardware ray tracing. A two-column sample was rendered on an RTX 4060 Ti; broader hardware
requirements, architectural material quality and visual equivalence still need validation.
Runtime glTF import cannot generate software-Lumen mesh distance fields.

HDRI files and legacy Render placements are not transferred; requests fail explicitly rather
than silently dropping those resources. Some material and environment settings remain
approximations. This is a desktop visualization milestone, not a native headset runtime.
The native preparation ground, tone-mapping selection, depth-of-field and material overrides
are not yet reproduced by the Unreal companion. Empty space beneath the sky is expected
when the source model contains no ground geometry.

The mesh handoff currently replaces the complete model after changes; it is not an optimized
per-mesh GPU streaming implementation. Resource/performance behavior needs large-scene testing.
Private publications, cloud Pixel Streaming, the interactive website and device-specific XR
publishing are still separate milestones. Existing public WebXR publishing remains available.

## Developer workflow

```powershell
node scripts/build-unreal-runtime.mjs --engine 'F:\ur5.5\new\UE_5.8' --workspace 'F:\Archai-Releases\0.3.0.2\runtime-build'
```

The build workspace must be empty or carry the build tool's own marker. Sources, intermediate
files and the cache stay in that workspace. Editor tools create only the empty entry map;
customer scene loading belongs to the compiled runtime.

```powershell
node scripts/unreal-runtime-smoke.mjs --runtime '<Windows>/ArchaiRender/Binaries/Win64/ArchaiRender.exe' --package '<scene.zip>' --output '<new test directory>'
```

The default test uses offscreen GPU rendering. Add `--render` for a visible window and capture.
Cooked runtime mesh import requires an active graphics device; NullRHI cannot validate it.
Use `ARCHAI_RENDER_RUNTIME` and `ARCHAI_RENDER_CACHE` in the developer process to select a
verified executable and cache location. The app never accepts executable paths from renderer
messages. Production packaging uses the fixed bundled executable under `resources/unreal`.

```powershell
node scripts/package-render-release.mjs --runtime '<packaged Windows folder>' --output '<installer output folder>'
```

## Verification

Verified locally on October 21, 2026:

- Production Archai application build and TypeScript checks passed.
- Eleven targeted handoff, scene-package, synchronization and camera tests passed.
- The Render workspace browser test passed, including export and preserved camera/settings.
- The cooked standalone application imported both sample meshes with both source IDs intact.
  The measured bounds were `[-25,-25,0,425,25,300]` centimetres, matching the source dimensions.
- A real GPU-rendered capture was inspected. This is a small technical scene, not a
  photorealistic architectural quality benchmark.
- Live geometry replacement changed measured scene bounds, retained mesh count and camera,
  and kept one renderer process. A subsequent lighting-only revision did not reimport meshes.

Evidence is under `F:\Archai-Releases\0.3.0.2\runtime-render-check-6` and `live-check`.
The bundled Windows desktop build also passed opening the project, starting its own bundled
renderer with no executable-path override, live exposure synchronization without reimport or
camera reset, and preview shutdown with session-directory cleanup. Its evidence is in
`F:\Archai-Releases\0.3.0.2\bundled-check-final`.

This is a local preview candidate. No public deployment or production publication was made.
A clean-machine installation and wider GPU/scene coverage remain before general release.

The local candidate installer is `F:\Archai-Releases\0.3.0.2\ArchAI-Setup-0.3.0.2.exe`
(332,418,768 bytes). Its file version is `0.3.0.2`; the base product version remains `0.3.0`.
The standalone companion is included, so the workflow launches a packaged application rather
than the Unreal editor. The exact bundled companion matches the independently tested binary.
Installer integrity and evidence paths are recorded in `release-verification.json` beside it.
