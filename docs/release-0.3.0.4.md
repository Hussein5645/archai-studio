# ArchAI 0.3.0.4 — Render opens Unreal Editor

The Board's Render button now transfers the model to a persistent Unreal project and opens the
full Unreal Editor. All lighting, materials, cameras, image rendering, baking and export controls
are used inside Unreal. The separate ArchAI Render window, its native rendering engine and
path-tracer dependency have been removed.

Board changes synchronize into the running Editor while preserving Unreal lighting, camera actors
and explicit material overrides. The Unreal ArchAI menu offers frame/synchronize/pause and static
lighting preparation. Editor projects remain saved on disk and stay open when ArchAI closes.
Repeated Render requests reuse the same Editor process.

This authoring workflow uses the locally installed Unreal 5.8 Editor. The development default is
`F:\ur5.5\new\UE_5.8`. Projects default to `F:\Archai-Unreal-Projects`; see
[render-studio.md](render-studio.md) for configuration and output steps.

Bake preparation is verified inside Unreal. Complete the actual Lightmass build and packaging with
Unreal's native menus. A finished headset experience still requires an XR pawn and locomotion setup
and headset testing. Cloud publishing and browser delivery remain future work.
