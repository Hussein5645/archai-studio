# ArchAI plugins

Status: **implemented** (plugins 0.5.0, 2026-10-10). Revit, AutoCAD and Blender are run-tested
(Send to ArchAI, Open .AIR); Rhino, SketchUp, 3ds Max and Unreal are built (or packaged) but not yet
run in their apps. Live Bridge status and geometry quality per app:
[docs/live-bridge.md](live-bridge.md#status-by-app-2026-10-10-archai-02216-plugins-050).

Every plugin ("ArchAI in <app>") offers the same four actions, with the shared ArchAI icon set:

| Action | What it does |
|---|---|
| **Send to ArchAI** | Saves the visible model as an `.AIR` exchange file; ArchAI's *Open file* rebuilds it (`src/revit/exchange.ts`, `import-revit-model`). |
| **Open .AIR** | Brings an ArchAI document (or another plugin's exchange file) into the app as meshes, grouped per element, a layer / collection / tag per level. |
| **Live Bridge** | Keeps the app and the ArchAI desktop app in sync while it is on, element by element, with the other linked apps (see below and docs/live-bridge.md). |
| **Link to project...** | Choose the ArchAI project this model syncs with (ArchAI shows its projects). |
| **Open in VR** | Uploads the model and a tour to the VR share service and opens the short link (docs/vr-tours.md); cameras / named views / scenes become stops. |

| App | Plugin | UI | Language | Package (`plugins/dist`) |
|---|---|---|---|---|
| Revit 2024–2027 | `revit/Archai.Revit` | Ribbon tab ArchAI (ArchAI, Live, VR, Web panels) | C# | `revit/build-packages.ps1` / setup |
| AutoCAD 2025+ | `plugins/autocad` | Ribbon tab ArchAI; `ARCHAIEXPORT`, `ARCHAIIMPORT`, `ARCHAILIVE`, `ARCHAIVR`, `ARCHAIWEB` (`-ARCHAIEXPORT` / `-ARCHAIIMPORT` take paths, for scripts) | C# | `ArchAI-AutoCAD-<v>.zip` (ApplicationPlugins bundle) |
| Rhino 8 | `plugins/rhino` | ArchAI panel; `ArchAI`, `ArchaiSend`, `ArchaiOpenAir`, `ArchaiLive`, `ArchaiVR` | C# | `ArchAI-Rhino-<v>.zip` (`ArchAI.rhp`) |
| SketchUp 2021+ | `plugins/sketchup` | ArchAI toolbar, Extensions → ArchAI | Ruby | `ArchAI-SketchUp-<v>.rbz` |
| Blender 3.6+ / 4.x | `plugins/blender` | Sidebar tab ArchAI; File → Import / Export | Python | `ArchAI-Blender-<v>.zip` (add-on and 4.2 extension) |
| 3ds Max 2025+ | `plugins/3dsmax` | ArchAI menu, dockable ArchAI panel (PySide6) | Python | `ArchAI-3dsMax-<v>.zip` (ApplicationPlugins bundle) |
| Unreal Engine 5.1+ | `plugins/unreal` | ArchAI menu in the main menu bar | Python | `ArchAI-Unreal-<v>.zip` (project plugin) |

Twinmotion has no plugin API: its users go through Unreal or export from the source app.

## Live Bridge

The ArchAI desktop app runs a small HTTP server on the loopback interface (`127.0.0.1:47821`,
`ARCHAI_LIVE_PORT` overrides; `electron/liveLink.ts`). With a plugin's Live Bridge on:

1. the model goes to ArchAI a moment (1.5 s) after each edit, as the exchange file *Send to ArchAI*
   writes, and ArchAI applies it element by element through the binding graph (`bridge-sync`, one
   undo step): items keep their ArchAI element, unchanged ones are skipped, changes are merged per
   part (geometry, position, material, name and data) following who owns them;
2. the plugin polls `GET /live/status` every 2 s and, when the project changed, pulls what changed
   since its last pull: other apps' shared elements (one object each, in its source colour),
   ArchAI's moves and names for its own objects, editable copies;
3. ArchAI's elements go into a layer / collection / folder of their own ("ArchAI Live"), replaced
   or removed one by one and never sent back; editable copies are ordinary objects ("ArchAI
   Copies") that are sent back and linked to the element they came from.

Everything about ownership, conflicts, safe deletions, fidelity and the protocol is in
docs/live-bridge.md. Plugins 0.4.x (protocol 1: whole models both ways) keep working.

**Projects.** A model is bound to one ArchAI project: the one open when it first connects, or the
one chosen with **Link to project...** (ArchAI shows its project picker). The link is remembered
per model (`%LOCALAPPDATA%\ArchAI\live-bridge.json`, shared by all plugins). While ArchAI shows
another project, the plugin says so and sends nothing.

**Starting ArchAI by itself.** When the desktop app is not running, the plugin starts it:
`ArchAI.exe` in its install folder (`%LOCALAPPDATA%\Programs\ArchAI`, `%ProgramFiles%\ArchAI`, or
`ARCHAI_EXE`), else the `archai://live?key=…` link the installer registers, at most once a minute.
On its Home screen ArchAI opens the project the model is linked to, else creates one named after it.

Requests need the `X-ArchAI-Live: 1` header and are refused when they carry an `Origin` (a web
page cannot reach the model). Clients: `Archai.Plugins.LiveLink` (C#: Revit through an
ExternalEvent, AutoCAD on Idle, Rhino on the UI thread), `archai_core.LiveLink` (Python: Blender
timers, a Qt queued signal in 3ds Max, a slate tick in Unreal; 3ds Max and Unreal notice edits by
polling a scene fingerprint) and `plugins/sketchup/archai/live.rb` (Ruby, a UI timer and
Net::HTTP).

## Shared pieces

- **Core**: `plugins/dotnet/Archai.Plugins.Core` (C#, netstandard2.0: Revit, AutoCAD, Rhino),
  `plugins/python/archai_core.py` (Blender, 3ds Max, Unreal; copied into each package),
  `plugins/sketchup/archai/core.rb`. Each has the glTF writer and reader, the exchange writer,
  `.AIR` reading, VR tour building and the share-service client. Tests:
  `dotnet run --project plugins/dotnet/Archai.Plugins.Core.Tests [-- file.AIR]` and
  `blender --background --python plugins/python/test_core.py [-- file.AIR]`.
- **Windows UI** (Revit, AutoCAD): `plugins/dotnet/Shared.Windows` — icon loader, progress window,
  result dialog with the link (copy / open). Rhino uses Eto, 3ds Max PySide, SketchUp an HtmlDialog.
- **Icons**: `plugins/icons/make-icons.mjs` renders the ArchAI tile with an action badge (logo,
  export, import, vr, web) to PNG 16–256 and ICO, from `public/brand/archai-mark.png`.

## Axes and units

ArchAI: millimetres, plan x right, plan y down, elevation up. A Z-up right-handed host point
(X, Y, Z) is (X, −Y, Z) × unit size. glTF, ArchAI's 3D scene and the VR viewer: metres as
(x, up, plan y). Unreal (left-handed, centimetres) maps (X, Y, Z) straight to (x, plan y,
elevation) × 10; its glTF importer's own axis conversion is measured once with a probe triangle.

## The 3D snapshot in .AIR files

ArchAI writes `scene3d = { format: 'glb', version: 1, units: 'm', up: 'y', data: <base64> }` next
to the document when it saves a file (`save-document`, `save-document-as`; not the local
autosave). It is the 3D view's scene at high detail, one node per element named after it, with
`extras.archai = { id, kind, type, level }` (`exportSceneSnapshot`, `src/view3d/vrExport.ts`).
Opening the file in ArchAI drops it (`parseDocumentData`); ArchAI rebuilds 3D from the elements.
A save never fails over the snapshot. Files saved before this change have none: the plugins ask
for one re-save in ArchAI. The snapshot makes files larger (the Meridian Tower example: 11.5 MB of
glTF, about 1 s to export).

## Building

`powershell -ExecutionPolicy Bypass -File plugins/build-plugins.ps1 [-Version 0.3.0] [-Skip Rhino,...]`
builds the .NET plugins against the installed apps (AutoCAD 2026, Rhino 8; override `AcadDir` /
`RhinoDir`) and writes the packages to `plugins/dist`. Nothing secret is built in: **Open in VR**
publishes with the account signed in in the ArchAI desktop app, asked over the Live Bridge
(`GET /live/account`, docs/accounts-and-cloud.md). The download page (`public/download.html`, tab
Plugins) links `https://pub-56da091dd4ec4d00a47cd0aaa54fcef1.r2.dev/plugins/<package>`.

## Download page logos

`public/brand/apps/*.svg`: Revit, AutoCAD, Rhino, SketchUp, Blender, Unreal Engine and Twinmotion
marks from Simple Icons 13.21.0 (CC0 SVGs, filled with each brand's colour); 3ds Max is the icon
cropped from Wikimedia Commons' public-domain `Autodesk 3ds Max Logo.svg`. The trademarks belong to
their owners (noted on the page).

## Revit setup

`ArchAI-Revit-Setup-0.5.0-beta.1.exe` (archai-revit bucket) installs the 0.5.0-beta.1 packages,
built with `revit/build-packages.ps1 -UseApiPackages -Dotnet revit/artifacts/tools/dotnet/dotnet.exe`
(the local .NET 10 SDK, needed for Revit 2027) and `revit/build-setup.ps1`. Its `--self-test <dir>`
must run in a short path (.NET Framework 260-character limit).
