# ArchAI 0.3.0.5 — Unreal inside Archai

Render now runs a bundled Unreal Shipping application inside the Archai window. End users do
not download or open Unreal Editor. The Editor-launch workflow from 0.3.0.4 is superseded.

The integrated workspace includes live Board synchronization, sun/sky and exposure controls,
PNG capture, and portable Windows interactive scene export with desktop and OpenXR launchers.
New render-project light elements support point, spot and area sources with position, brightness,
color, reach, direction, size, enable/disable and removal controls. Lights persist per project and
travel with exported scenes.

Exports use real-time lighting. Precomputed baking needs a separate build service. Quest-native
and WebXR output, online publishing, and headset hardware/comfort validation remain outstanding.
See [render-studio.md](render-studio.md) for usage and technical boundaries.
