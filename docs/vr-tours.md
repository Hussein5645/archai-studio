# VR tours

Status: **implemented** (2026-10-15). The share Worker and SJP-VR viewer are deployed together with this release.

Place stops (points of interest) in the 3D workspace, then publish the model with its stops as a
short link that opens in a VR headset (Meta Quest Browser → **Enter VR**) or any browser. The
viewer is the ArchAI VR viewer: a separate WebXR app kept in the **private** repository
Hussein5645/SJP-VR (not part of this repository) and deployed on Vercel at
https://archai-vr.vercel.app (see [hosting.md](hosting.md)).

## Use

1. Open a 3D view full screen. Stops are optional for raw and baked 3D links. Press **VR stop** to add named destinations. Each click on a floor (a surface facing up,
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

**VR** has exactly two entries: **Export Raw VR Link** and **Prepare VR Scene**. D5 folder import remains under **File**.

**VR → Prepare VR Scene** opens **ArchAI VR Preparation**, replacing the separate
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
assets up to 512 MB upload in 8 MB parts. Headset frame rate requires device validation.

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
before 0.4 (see docs/accounts-and-cloud.md, release step). Legacy single-request models are limited to 95 MB (Workers
request limit); the app uses multipart uploads up to 512 MB. Keep tours light for the Quest (well under ~1M triangles).

Deploy from `workers/vr-share`: `npx wrangler deploy`.

## Tabletop sessions and cloud versions

### Passthrough, controller tools and precision (2026-10-15 viewer update)

On headsets that report immersive AR support, **Enter mixed reality** opens shared 3D tours in
passthrough: the real room surrounds the opaque tabletop model. Headsets without AR support
continue using immersive VR. Entering at 1:1 fills the view with the scene; returning to the
table restores passthrough. Passthrough is supplied by the headset browser; the viewer does not read camera pixels.

Editing controls are on a panel above the left controller (right if only that controller is
tracked); point with the opposite controller and pull the trigger. **B / Y** folds or opens the
tools. The original gaze-down stop menu and the in-model stop positions stay in place.

- **Model:** move, scale, 15° table rotation, height steps, lock/unlock, and raw element selection.
- **Move:** Free / X / Y / Z / XZ constraints; snap off, 1 mm, 10 mm, 50 mm or 100 mm;
  axis nudges; 15° element rotation; restore the selected element. The default grid is 50 mm.
  Snapping applies increments from the gesture's starting placement. Two-grip rotation snaps to
  15° when snapping is enabled. Releasing one grip preserves the current table placement.
- Selected elements show width × height × depth and ΔX / ΔY / ΔZ in actual model metres,
  both beside the element and on the controller panel. Moving a table uses room metres.
- **Measure → Start measuring:** trigger two surface points to place a distance label and line.
  Nearby triangle vertices snap within the chosen tolerance. Distances stay in original model
  metres at every tabletop scale and at 1:1. Up to 20 rulers remain for the browser session;
  **Clear measures** removes them. Rulers are not part of saved cloud versions.
- **Versions:** the original and the existing three save/load/replace slots.

The desktop toolbar has the same four tabs. Failed or malformed shared links show an error
instead of loading an unrelated sample scene. Changes are hosted in SJP-VR, so existing shared
links receive the viewer update without a new desktop installer. Physical headset validation
remains necessary for passthrough appearance and controller ergonomics.

Shared raw and baked 3D links open as a movable tabletop model. One controller grip pans the
model; two grips scale and rotate it around the hands. Aim at a floor and pull the trigger to
enter at 1:1 scale; **Tabletop** returns to the last table placement. Desktop users drag to move
the table, use the wheel or scale buttons to resize, and click a floor to enter.

Raw exports retain one group with extras.archai.id per element, rather than batching elements
together by material. **Move elements** enables grip-and-drag (or desktop drag) of an individual
element with a blue selection outline. Changes remain in the current browser session, including
when entering at 1:1. Baked scenes expose table navigation and versions but no element editing.
The original GLB and the ArchAI source document are unchanged by VR edits.

**Original** restores the published elements and a fitted table. Three fixed cloud slots provide
**Save 1–3**, **Load 1–3**, and **Replace 1–3** after saving. Saving asks the tour owner to sign in
to ArchAI in the viewer; the session credential stays in memory. In-headset saving signs out of
immersive VR for the browser sign-in form when needed. Viewing and loading versions are public
for anyone holding the link. Other accounts cannot overwrite the owner's versions.

The Worker serves GET /tours/<id>/versions and owner-authenticated PUT
/tours/<id>/versions/<1|2|3>. Each slot is an independent R2 JSON object containing table and raw
element transforms plus the exact model revision, so concurrent writes to different slots do
not lose changes. A fourth slot is rejected. Slot replacement never writes tour.json or the
original model; republishing invalidates old snapshots rather than applying them to new geometry.
Deleting the tour removes its slots along with all assets. No database migration is required.

Validation: npm --prefix ../SJP-VR install && npm --prefix ../SJP-VR test;
node --test workers/vr-share/src/index.test.mjs; npx playwright test e2e/vr-tabletop.spec.ts
(the browser integration test requires the sibling SJP-VR checkout). Controller math is tested
with synthetic poses; final ergonomics and frame rate still require a headset check.
