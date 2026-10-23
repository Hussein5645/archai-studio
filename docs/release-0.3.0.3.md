# Archai 0.3.0.3 — Unreal-only Render candidate

Render now uses Unreal exclusively. The Board's modeling viewport remains native.
The previous native preparation renderer and bake/panorama actions are removed from this
workspace. No native fallback is shown when the Unreal companion is unavailable.

## Changes

- Automatic scene launch/synchronization in the Windows app, with per-project lighting.
- Right-mouse navigation, adjustable fly speed, Shift acceleration, frame/fullscreen shortcuts,
  a clickable Unreal toolbar, exposure changes and PNG capture.
- PNG export from Archai uses the actual Unreal viewport; toolbar exposure edits feed back
  into the saved Render settings.
- A local Unreal bake worker imports a frozen scene, generates lightmap UVs, invokes CPU
  Lightmass, verifies baked lightmaps, and packages a Windows/OpenXR experience.
- Dedicated output directories, preserved input/logs, build-stage reporting, cancellation,
  resume tooling and a shared compiled shader cache.

## Verified

- Application build, TypeScript checks and 759 unit tests across 128 files pass.
- The Unreal-only browser workspace and scene-transfer tests pass. They check that there is
  no native preview canvas, that unavailable native actions stay disabled in the browser,
  and that object IDs and lighting survive edits and export/reload.
- Authenticated PNG command handling, output cleanup and existing handoff tests pass.
- Real GPU runtime testing passes geometry replacement, camera preservation, lighting-only
  reuse, PNG capture and framing commands.
- Bundled desktop testing passes Unreal-only UI, actual Unreal image export, exposure sync,
  camera preservation and cleanup on close.
- Unreal Lightmass successfully baked the two-mesh sample. The C++ verification found
  real baked lightmaps on both meshes.

Build evidence is under `F:\Archai-Releases\0.3.0.3`, including `bake-check`.
The standalone baked experience packaged and launched successfully. A real GPU capture was
visually inspected, with the two sample columns visible and no static-lighting material fallback.
The cooked map loads directly without runtime geometry import. Evidence is in
`baked-exposure-check/verification.json` and `baked-exposure-check/baked.png`.

The baked profile uses fixed manual exposure without physical-camera scaling. Matching its
look exactly to the live Lumen viewer remains a separate visual-calibration task.

The final bundled app was retested after packaging. Its Unreal runtime and worker sources
match the tested build/source files. Final app evidence is in `bundled-check-final`; final live
runtime evidence is in `live-image-check-final`. The local installer is
`F:\Archai-Releases\0.3.0.3\ArchAI-Setup-0.3.0.3.exe` (file version `0.3.0.3`).
The example baked experience is in `bake-check/Experience/Windows` and starts with its
`ArchaiRender.exe`. Ship the complete folder, not the executable alone.

## Boundaries

This is a Windows preview. The initial bake profile is Preview quality with 128-pixel mesh
lightmaps. Large architectural projects, glass-heavy materials and clean-machine installation
still need validation. Image export is a viewport PNG, not Movie Render Queue/path tracing.

The viewer and resulting baked experience include their Unreal runtime. New local baking
requires an Unreal 5.8 build worker with Windows C++ tools. No remote bake service has been
deployed. Headset/controller behavior is not hardware-verified. Browser/standalone-headset
builds, private/public interactive publishing, accounts and cloud streaming are later work.
