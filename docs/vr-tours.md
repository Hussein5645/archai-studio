# VR tours

Status: **implemented** (2026-10-07).

Place stops (points of interest) in the 3D workspace, then publish the model with its stops as a
short link that opens in a VR headset (Meta Quest Browser → **Enter VR**) or any browser. The
viewer is the ArchAI VR viewer: a separate WebXR app kept in the **private** repository
Hussein5645/SJP-VR (not part of this repository) and deployed on Vercel at
https://archai-vr.vercel.app (see [hosting.md](hosting.md)).

## Use

1. Open a 3D view full screen and press **VR stop**. Each click on a floor (a surface facing up,
   or the ground) adds a stop there; the stop faces the way the camera looks. Esc stops placing.
2. Stops are reference points (`meta.point`) with `meta.vrStop = { heading }`: rename them, move
   them in plan and height, delete or undo them like any point. The Inspector's **VR facing**
   sets the direction (degrees clockwise from +x on the board); 3D shows it as an arrow.
3. **VR → Export Raw VR Link** exports the scene (high detail, metres, no markers or edge lines, plus a ground
   disc), uploads it and shows the link (`https://archai-vr-share.mklkoklpp.workers.dev/v/<id>`).
   Publishing the same document again updates that link (the id is remembered per document in
   platform storage); `publish-vr-tour { newLink: true }` makes a fresh one.

Commands: `create-vr-stop`, `set-vr-stop-heading`, `publish-vr-tour`.

## Prepared VR and 360 links

**VR → Prepare Rendered VR Link** opens **ArchAI VR Preparation**, replacing the separate
Render button. Add objects and assign materials on the board/3D view. Preparation follows those
edits and supplies environment, sun, sky, exposure, saved cameras, stops, quality and publishing.

- **Baked 3D VR**: Bake scene → review the actual unlit output → Publish VR link. Static sun,
  sky occlusion and diffuse indirect illumination are sampled in a worker and stored in vertex
  colours. Source UVs/textures are retained, opaque material-compatible surfaces are batched,
  and large triangles are subdivided within a preset budget. This is a diffuse vertex bake,
  not a path-traced texture atlas: sharp shadows depend on mesh density, bounced texture colour
  is approximated by material colour, cutout/transmissive surfaces do not block bake rays, and
  glass/reflections are simplified. No lights run for the baked model in the viewer. The chosen
  sky is embedded as a prepared texture, so viewers do not need an account to fetch the HDRI.
- **360 image**: choose a stop or saved camera → Render 360 image → Download image or Publish
  360 link. Uses the full path tracer's equirectangular camera. The published image viewer supports
  mouse/touch look-around and monoscopic WebXR at a fixed viewpoint; it does not support walking.

Fast/Balanced/High Quality change bake samples, diffuse bounce depth, subdivision budget,
texture cap and panorama resolution/sample count. They do not decimate source geometry or
provide KTX2 compression. Scenes above one million source triangles are rejected by the baker;
the service's 95 MB upload limit still applies. Headset frame rate requires device validation.

Settings remain at `render:<document id>` for compatibility. Output/quality preferences use
`vr-preparation:<document id>`. Raw IDs keep `vr-tour:<document id>`; baked and panorama IDs use
`vr-tour:<document id>:baked|panorama`. Geometry/material/embedded asset/lighting/quality changes
invalidate prepared results. Cancellation terminates the bake worker or stops progressive
panorama sampling and restores the preview. Previous Render entourage is read-only and included;
missing legacy assets prevent export rather than silently disappearing.

New publishing uploads immutable `model-<revision>.glb` or `panorama-<revision>.png` first, then
commits `tour.json`. Until that commit, the previous published version is intact. Revisions are
retained so clients holding an older manifest still load; deleting a tour removes all revisions.
Legacy `model.glb` uploads and old manifests remain supported. Deploy the updated share Worker
and SJP-VR viewer before distributing this desktop update.

Additional manifest fields: `mode: raw|baked|panorama`; baked vertex tours use `lighting: baked`,
`bake: vertex`, `bakeScale`, `toneMapping`, `exposure`; panoramas use `mode: panorama`, `panorama`
and a camera stop. `bakeScale` recovers HDR illumination from normalized glTF colour attributes.

Checks: `npx vitest run src/studio/vrPreparation.test.ts src/view3d/vrOptimise.test.ts
src/commands/builtin/vr.test.ts`, `node --test workers/vr-share/src/index.test.mjs`, and
`npx playwright test e2e/vr-preparation.spec.ts`.

## Managing VR links

Home → **VR Links** (signed in) lists every tour published with the account, from the app or a
plugin: name, last update, stops, model size and the short link, with **Copy link**, **Open** and
**Delete** (the link stops working for everyone). It reads `GET /tours` and calls
`DELETE /tours/<id>` on the VR share Worker (`src/cloud/vrTours.ts`, `src/ui/HomePanels.tsx`).

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
plugin asks the running ArchAI desktop app for its session over the Live Bridge (`/live/account`,
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
| Viewer | private repository SJP-VR (`js/main.js`), `?tour=<url of tour.json>`; the VR share Worker's `VIEWER_URL` |

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
