# VR tours

Status: **implemented** (2026-10-07).

Place stops (points of interest) in the 3D workspace, then publish the model with its stops as a
short link that opens in a VR headset (Meta Quest Browser → **Enter VR**) or any browser. The
viewer is the SJP-VR tour app (github.com/Hussein5645/SJP-VR, served on GitHub Pages).

## Use

1. Open a 3D view full screen and press **VR stop**. Each click on a floor (a surface facing up,
   or the ground) adds a stop there; the stop faces the way the camera looks. Esc stops placing.
2. Stops are reference points (`meta.point`) with `meta.vrStop = { heading }`: rename them, move
   them in plan and height, delete or undo them like any point. The Inspector's **VR facing**
   sets the direction (degrees clockwise from +x on the board); 3D shows it as an arrow.
3. **VR link** exports the scene (high detail, metres, no markers or edge lines, plus a ground
   disc), uploads it and shows the link (`https://archai-vr-share.mklkoklpp.workers.dev/v/<id>`).
   Publishing the same document again updates that link (the id is remembered per document in
   platform storage); `publish-vr-tour { newLink: true }` makes a fresh one.

Commands: `create-vr-stop`, `set-vr-stop-heading`, `publish-vr-tour`.

## From other apps

Every ArchAI plugin (Revit, AutoCAD, Rhino, SketchUp, Blender, 3ds Max, Unreal; docs/plugins.md)
has **Open in VR**, built on the plugin cores (`plugins/dotnet/Archai.Plugins.Core`,
`plugins/python/archai_core.py`, `plugins/sketchup/archai/core.rb`); tour ids are remembered per
file in `%LOCALAPPDATA%\ArchAI\vr-links.json`. Revit in detail:

The Revit add-in's **ArchAI tab → VR → Open in VR** (`revit/Archai.Revit/VrTour.cs`) publishes the
open model the same way: one GLB in metres (every model element, or only what an orthographic 3D
view shows when run from one, plus the ground disc), stops at each perspective camera view (on the
level under the eye, facing the camera's way) and each placed room (at its room point, facing into
the room), max 40. It uploads with the same calls as `vrShare.ts`, opens the short link in the
browser and copies it; republishing keeps the link. Publishing needs an ArchAI account: the
plugin asks the running ArchAI desktop app for its session over the live link (`/live/account`,
docs/accounts-and-cloud.md); `ARCHAI_VR_SHARE_URL` overrides the service.

## Pieces

| Piece | Where |
|---|---|
| Stop model | `src/document/vrStop.ts` |
| Commands | `src/commands/builtin/vr.ts` |
| Tour file (viewer format) | `src/view3d/vrTour.ts` |
| Model export (GLTFExporter) | `src/view3d/vrExport.ts` |
| Upload client | `src/view3d/vrShare.ts` |
| Placement in 3D | `SceneView.setPlacingStop` / `floorAt`, UI in `View3DWorkspace.tsx` |
| Share service | `workers/vr-share` (Cloudflare Worker, R2 bucket `archai-vr`) |
| Viewer | SJP-VR `js/main.js`, `?tour=<url of tour.json>` |

Tour file: `{ format: 'archai-vr', version: 1, name, model: 'model.glb?v=…', lighting: 'live',
exposure, credit, start, spaces: [{ id, name, center: [x, z], look: [x, z], floor }] }` in metres;
board x / y are the scene's x / z.

## Share service

`workers/vr-share/src/index.js`: `POST /tours` reserves an id (or confirms `{ id }` to republish),
`PUT /tours/<id>/model.glb|tour.json` uploads, `GET` reads them with CORS `*`, `GET /v/<id>`
redirects to the viewer. Writes need an ArchAI account session (`Authorization: Bearer`, checked
in the `archai` D1 database); tours are recorded under the account and only it may republish
them. Until the `UPLOAD_KEY` secret is deleted, the old `X-Upload-Key` still works for plugins
before 0.4 (see docs/accounts-and-cloud.md, release step). Models are limited to 95 MB (Workers
request limit); keep tours light for the Quest (well under ~1M triangles).

Deploy from `workers/vr-share`: `npx wrangler deploy`.
