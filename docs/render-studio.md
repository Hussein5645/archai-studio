# ArchAI Render

Status: **implemented** (2026-10-08). The rendering studio of the desktop app, in the spirit of D5
Render and Twinmotion: any 3D view goes to it with **Render** (3D workspace bar) or the
`open-render-studio` command, and it stays live-linked to the board.

## Use

1. Open a 3D view full screen and press **Render**. The ArchAI Render window opens on that view's
   camera (or on a framing of the model from its sunlit side when opened from the command palette).
2. Edit on the board: the studio rebuilds the model about half a second after each change.
3. **Real-time** for composing; **Path traced** for final quality (samples accumulate while the
   camera is still). **Render image** writes a PNG (HD to 4K, path traced 128–4000 samples, or a
   real-time frame).

Panels: **Environment** (sun & physical sky by date, time and site, or an HDRI with rotation; sky
and sun strength; ground; AgX / ACES / Neutral tone mapping, exposure, ambient occlusion, bloom,
light bounces), **Camera** (field of view; depth of field with focus distance, aperture and a focus
picker), **Materials** (the project's materials and ArchAI's material library; pick one and click
the model to apply it to a face, part, object or everywhere; the board applies it as one undo
step and the studio follows), **Entourage** (the board's asset library: every catalog model,
.CAI packages from R2 and the user's own; click an item, click in the scene to place, click a
placed item to move / turn / scale with W / E / R, Delete removes), **Views** (the document's
saved 3D cameras).

Settings and entourage are saved per document in platform storage (`render:<doc id>`), not in the
`.AIR` file. The sun defaults to the site's map location.

## Layout (0.2.2.10.1, in the spirit of D5)

Top: the live-link state, the tools **Select / Paint / Pick / Focus**, Real-time / Path traced and
**Render**. Left: the library with **Models** (the board's asset catalog, search and categories),
**Materials** (the project's and the library's; picking one starts Paint) and **Sky** (HDRIs).
Right: the selection (a placed model's move / turn / scale, or the picked material's quick panel
with Make unique, sent to the board as `material-update` / `material-unique`), otherwise the
scene settings in **Environment / Camera / Effects**. Bottom: the scenes (the document's saved
3D views) and *Whole model*.

## Pieces

| Piece | Where |
|---|---|
| Engine (three.js real time + three-gpu-pathtracer) | `src/studio/engine.ts` |
| Studio UI | `src/studio/RenderStudio.tsx`, `RenderStudio.module.css` |
| Live link (board ↔ studio) | `src/studio/link.ts`; `platform.studio` (Electron IPC relay `archai:studio:send` → `archai:studio`; BroadcastChannel in the browser) |
| Settings | `src/studio/settings.ts` |
| Library (HDRIs, entourage) | `src/studio/library.ts`, R2 `archai-assets/render/` |
| Window | Electron `openRenderWindow` (route `render`), `platform.window.openRender` |
| Command | `open-render-studio` (`src/commands/builtin/render.ts`) |

The scene is the 3D view's own (`buildSurfaces` in `src/view3d/vrExport.ts`) in metres. The sky
is always a float equirectangular texture (three's physical Sky rendered through a cube camera,
sun disc clamped because the directional sun carries the sun, or a library HDRI), so real time,
path tracing and stills see the same light.

## Desktop GPU backend

The Windows app starts Chromium with ANGLE over **OpenGL** (`electron/main.ts`): the default
Direct3D 11 backend takes about 49 s to compile the path-tracing shader on an RTX 4060 Ti (31 s
with the shader cache), OpenGL about 9 s and Vulkan about 2 s, with the same sample rate
(~15 samples/s at 1600 × 900 on the Meridian Tower example). `ARCHAI_ANGLE=d3d11|vulkan|gl`
overrides it. In the browser the studio exists for development only (the Render button shows in
dev builds); it uses the browser's backend.

## Library

HDRIs: `node scripts/render-library.mjs <work dir>` (8 CC0 Poly Haven skies) writes
`library.json`; upload `<work dir>/out/render/*` to `archai-assets/render/` (public at
`https://pub-b5992926befd442a815cdfd81f89d74c.r2.dev/render`, `VITE_RENDER_LIBRARY_URL` overrides).
Its older render-only entourage models stay as a fallback for scenes placed before.

Models: the studio's entourage is the board's asset catalog (`catalogEntourage` in
`src/studio/library.ts`), so the same models serve the board and the renders.
`node scripts/asset-library.mjs <work dir>` builds 90 CC0 Poly Haven models as .CAI packages
(trees, shrubs, potted plants, seating, tables, storage, beds, lighting, decor, kitchen and HVAC
equipment, street furniture): a full model (trees 150k triangles, others 50–60k), a low level of
detail (5–12k), a top view rendered from the model and the Poly Haven thumbnail, with the
package's metadata inlined in `catalog.json` (docs/cai-format.md). Ids are the Poly Haven ids,
the same as the older render models. Poly Haven has no people or vehicles; those need another
CC0 source.

## Not yet

360° panoramas (the path tracer has an equirect camera), video walkthroughs, people and cars,
editing material properties in the studio (it assigns them), WebGPU path tracing.
