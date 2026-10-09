# ArchAI for Revit — 0.2.0 beta 1

Imports the repository's schema-version-1 JSON `.AIR` files into a Revit project.
Four separate builds target Revit **2024, 2025, 2026 and 2027**. This is a beta:
API compilation and standalone AIR contract tests are verified; interactive
Revit import and geometry validation have not yet been completed. Do not describe
this release as a lossless converter for every AIR element.

## Install the plugin files

1. Close Revit. Extract the ZIP for your Revit year.
2. Run `install-local.ps1 -RevitVersion 2025` from PowerShell in the extracted
   folder (replace 2025 with your year). No administrator rights are needed.
   Alternatively, copy `Archai.AirImporter.addin` and the `Archai.AirImporter`
   folder together into `%APPDATA%\Autodesk\Revit\Addins\2025`.
3. Install the corresponding Revit **English metric family templates** using
   Autodesk content installation. The importer searches the configured family
   template folder and `%PROGRAMDATA%\Autodesk\RVT <year>\Family Templates\English`.
   Set `ARCHAI_REVIT_TEMPLATES` to a different folder if necessary. Required files:
   `Metric Door.rft`, `Metric Window.rft`, `Metric Column.rft`,
   `Metric Generic Model.rft`. Templates must match the running Revit year.
4. Start Revit, open a project made with an architectural template, and choose
   **ArchAI tab → Open .AIR** (or **Send to ArchAI** to send the model to ArchAI, or **VR → Open in VR** to walk through it
   in a headset; see docs/vr-tours.md). Revit may ask you to load this unsigned add-in.
5. Select your AIR document and confirm the import. Review the JSON report under
   `%LOCALAPPDATA%\ArchAI\Revit\Reports`.

The Windows setup wizard is available as `ArchAI-Revit-Setup-0.2.0-beta.1.exe`.
It detects Revit versions, downloads matching packages from Cloudflare, checks
pinned SHA-256 hashes and installs for the current Windows user. It includes
repair, removal, cancellation during downloads, file rollback on write failure,
and Windows Installed apps registration. See `SETUP-README.txt`.
The PowerShell script above remains available for already-downloaded packages.
Uninstall by closing Revit and removing the named `.addin` file and plugin folder.

## Native conversion coverage

| AIR object | Revit result | Fidelity / constraints |
|---|---|---|
| Level | Native Level | Explicit elevation; unique imported name. Missing datums are generated as needed. |
| Wall | Native Wall and new WallType | Straight/circular-arc paths, layer thicknesses, height, base offset. Polyline sections become separate walls. Joins disabled to preserve endpoints. |
| Curtain wall | Native curtain Wall | Path/height; duplicated project type. Custom panels and grid spacing require review. |
| Floor | Native Floor and new FloorType | Closed outline, thickness, top offset derived from AIR bottom elevation. |
| Ceiling | Native Ceiling and new CeilingType | Closed outline, thickness and underside elevation. |
| Door / window | Generated wall-hosted RFA family instance | Native opening cuts, frame and leaf/glass solids, width/height, sill/threshold, AIR wall host. Geometry is size-specific, not fully parametrically constrained. Hardware and operation details are limited. |
| Column | Generated architectural column family | Rectangular/circular/custom profile, dimensions, elevation and rotation. Not a structural analytical model. |
| Stairs | Native Stairs, StairsRun, StairsLanding | Sketched runs/landings from flights. Rise follows drawn tread count × riser height. Native Revit constraints can reject invalid stairs. Custom profiles/supports need review. |
| Railing | Native Railing and new RailingType | Plan path, top rail height, base offset; stair-attached railings attach to the imported stair. Balusters/panels inherit the template type. |
| Room divider | Native room-separation ModelCurve | Plan path on the associated level. Creates a floor plan when needed. |
| Room | Native Room | Interior placement in the native wall/divider enclosure. Names retained; area/upper limits need review. Unenclosed rooms are rejected. |
| Facade / explicit extrusion | Generated Generic Model family | Footprint extruded by explicit solid height. Custom facade profile details require review. |
| Groups / stair display children | Hierarchy or native parent | Nested transforms are applied; generated stair child geometry is not duplicated. |
| Text, images, catalog meshes, unsupported modeling geometry | Reported as skipped | No fabricated bounding-box replacement is presented as faithful conversion. |

Walls, floors and stairs are system families, and levels/rooms are native project
elements; Revit does not make all of these into separate `.rfa` files. Doors,
windows, columns and explicit solids use newly generated loadable families.
Their geometry can be edited in Revit's Family Editor. Their dimensions are
baked at import time: changing a Width/Height label does not resize all solids.

AIR coordinates always use millimetres, even when display units are feet/metres.
Mapping is `(x, y, elevation) → (x, -y, elevation) / 304.8` at the Revit internal
origin. Parent translations/rotations, host elevations and explicit instance
elevations are respected. Analytic circular arcs stay arcs; Bezier/quadratic
curves use 64 native line segments and emit a warning. Visibility does not exclude
elements. This release creates a new copy on every import, not a synchronization
link. Native imported objects carry source JSON/id in Revit extensible storage.

Each source object is isolated in a transaction group: a failure rolls back that
object including its generated families/types. Successful objects remain, and
one Undo removes the entire import. Reports list created IDs, skips, failures,
Revit warnings and known approximations. Existing project elements are not edited.

## Build and package

Use .NET SDK 10 for the full matrix. The build targets .NET Framework 4.8 for
2024, .NET 8 for 2025/2026 and .NET 10 for 2027. Revit 2027's runtime change is
documented by [Autodesk](https://help.autodesk.com/cloudhelp/2027/ENU/Revit-WhatsNew/files/GUID-8D7A4715-EAF8-4BD1-BE78-061F900D0BCE.htm).

```powershell
dotnet run --project ./revit/Archai.Air.Tests -c Release
# Local Autodesk API installations:
./revit/build-packages.ps1
# Optional community-packaged Autodesk API references (compile only):
./revit/build-packages.ps1 -UseApiPackages
# One installed API, or override a reference folder:
dotnet build ./revit/Archai.Revit -c Release -p:RevitVersion=2025 '-p:RevitApiDir=C:\Program Files\Autodesk\Revit 2025'
```

Output is under `revit/artifacts/releases/<version>-<timestamp>/cloudflare-upload`:
four versioned ZIPs, a manifest with intentionally empty URLs, SHA-256 checksums,
and upload instructions. Autodesk DLLs are excluded using an explicit packaging
allowlist. Upload those ZIPs unchanged to Cloudflare and supply their HTTPS URLs.

The configured beta download bucket is
`https://pub-c7e9dfac353641459603485335c5537d.r2.dev`.
Its four ZIPs have been downloaded and hash-verified. The public development
endpoint is rate-limited; a custom domain is recommended for production.
Only distributable plugin/setup files are published to this bucket.

Rebuild the setup after changing package URLs or hashes:

```powershell
./revit/build-setup.ps1 -ManifestPath ./revit/artifacts/setup/release-manifest.json
```

`Archai.Setup/Packages.xml` also retains the pinned download configuration in
source. Setup targets .NET Framework 4.8 and has no non-framework runtime DLLs.
The test mode `--self-test <output-directory>` downloads the real packages and
exercises installation/repair/removal/rollback in a GUID-named sandbox under
that directory without changing the actual Revit installation or registry.
The unsigned beta setup still requires end-user validation on target machines.

## In-Revit acceptance checks still required

Use `native-smoke.AIR` in a fresh architectural project for each Revit year.
Confirm two source levels (0 and 3150 mm), a 6000 × 5000 mm wall-centreline room,
200 mm walls, 3000 mm wall height, 200 mm floor whose top is at 0, a 900 × 2100 mm
hosted door, a 1200 × 1200 mm window with a 900 mm sill, two columns, a ceiling
underside at 2700 mm, and a stair with 18 risers at 175 mm and 280 mm treads.
Inspect Revit categories, editable family geometry, native wall opening cuts,
stair connections and rail slope. Compare floor/room boundaries to AIR. Review
the report rather than assuming all records succeeded. Confirm one Undo removes
the import and a second import creates an independent copy.

Also test rotated/nested groups, nonzero linked levels, curved walls, doors near
wall corners, concave slabs/rooms, custom columns, U-shaped stairs, missing
family templates, and invalid geometry. The smoke file is synthetic; a real
representative user AIR file is still needed for fidelity acceptance.
