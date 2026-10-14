# Importing 3D models

Status: **implemented** (2026-10-07).

Any common 3D file becomes a **3D model element**: a box on the board (move, rotate, lift, level
link like any element) carrying the model as a binary glTF in the document. It shows in every 3D,
section and plan view, its own materials are paintable slots (Materials), and VR tours include it.

## Ways in

- Toolbar **3D model** (Shift+M): click on the board, pick the file(s).
- **File → Import 3D model…** (`import-3d-model`): placed at the centre of the view.
- Drop files on the board: placed at the drop point.

Pick or drop a model **with its companion files** (an OBJ's `.mtl` and textures, a glTF's `.bin`
and images, FBX textures): they are matched by file name.

## Formats

### D5 project folders (desktop, experimental)

**File → Import D5 project folder…**, the ArchAI menu, or the 3D workspace's **VR** menu opens
**D5 scene to VR**. Choose the saved folder containing `asset/1.save`. ArchAI reads the folder
and decodes the sampled version-11 Z-up D5 meshes directly; no Python, external converter or
D5 installation is needed. Original files are not modified.

The import report lists supported visible mesh actors, triangle/texture counts, omitted scene
content and material/lighting review items. **Import scene** inserts the supported subset.
**Import and bake VR** also opens VR preparation and requests one automatic bake after scene
and settings load. When content is omitted, the button explicitly says **Import partial scene
and bake VR**. Review the result, then choose **Publish VR link** with an ArchAI account.

The scene preserves relative actor transforms and instances, basic PBR materials, normals, UVs
and explicitly referenced PNG/JPEG base-colour maps. Like other model imports, it is placed as
one editable mesh element, with its lowest point on the ground. If the project has no VR stops,
import adds an editable starting view 1.5 m outside the scene's plan bounds, facing it. Move it
or add interior stops in the 3D view. Import and the initial stop share one undo step.

This is a prototype validated with the supplied curtain sample, not full D5 scene compatibility.
Terrain, grouped/scattered/procedural actors, native synced actors, material style overrides,
non-base-colour maps, lights, D5 environment/effects, cameras and animation are not reproduced.
The report flags known omissions; it cannot guarantee every D5 field is understood. Non-identity
mesh matrices and rotated scenes still need comparison against D5. ArchAI recalculates lighting
with its existing diffuse vertex bake; D5's rendered lighting is not preserved. There is no
folder-wide size or file-count limit. The desktop loads the scene index and then referenced
meshes and base-colour textures one resource at a time, reusing converted geometry for repeated
actors and showing progress between objects/mesh parts. Conversion runs in a background worker
and transfers binary buffers back to the app window. Unused files and hidden actors are not read;
unused archive textures are not decoded. Unsupported local library mesh formats are identified
from their header and listed as omissions without loading the payload. Native meshes that omit
the axis hint are treated as Z-up; missing embedded materials get named placeholders with a warning.
Individual resources/decoded mesh entries retain a 256 MB memory
guard; GLB's 4 GB format ceiling and available memory still apply.

Large imported models get a generated preview for the board's **Low detail** mode (target
350,000 triangles, 10 mm simplification tolerance). **High detail** keeps the original geometry;
the saved model blob remains unchanged. Preview generation runs in a worker and reuses repeated
geometry. Textures, material boundaries and UV seams are protected. Model decoding is serialized
to reduce peak memory use.
The 2D plan reader preallocates typed triangle buffers and avoids collecting invisible edges.
The existing 30,000-segment display cap per edge/cut layer remains; detailed geometry is retained.
Large desktop working-copy values use atomic chunk manifests and 8 MB IPC messages, including
model transfers to Render Studio. These working copies require the updated desktop version.

VR export and baking reduce a detached scene with a 20 mm tolerance before processing it.
Baking reserves half its quality preset's triangle budget for double-sided surfaces. Geometry
reduction preserves textured UV seams and accounts for normal/colour changes; tiny isolated
components may be removed. Unused UV seams need not restrict an untextured VR copy. This uses
[meshoptimizer's attribute-aware simplification](https://github.com/zeux/meshoptimizer/blob/master/README.md#simplification).
Targets are best effort: error limits and protected features can retain more triangles. Scenes
still over one million source triangles after reduction need smaller VR areas or a panorama tour.
VR publishing retains its 95 MB upload limit. Review the reduced bake before sharing; headset
frame rate depends on the resulting geometry, materials, textures and device.

Code: `electron/d5Folder.ts`, `shared/d5.ts`, `src/commands/builtin/d5.ts`,
`src/ui/D5ImportDialog.tsx`; one-shot bake requests use `src/studio/link.ts`.

### Individual files

GLB / glTF, FBX, OBJ (+MTL), STL, PLY, Collada (DAE), 3MF, 3DS, AMF, VRML (WRL), USD / USDZ,
LightWave (LWO), VTK (VTK / VTP), KMZ. Rhino `.3dm` is not supported (three.js reads it through a
WebAssembly library loaded from a CDN into a blob worker, which ArchAI's Content-Security-Policy
blocks): export OBJ, FBX or glTF from Rhino. Revit models come through the ArchAI Revit add-in
(docs/revit-import.md).

## Units and orientation

Converted once to millimetres, Y up, on the ground. Units come from the format (glTF / VRML / USD /
KMZ / LWO metres, STL / 3MF / AMF millimetres) or, for unitless formats (FBX, OBJ, PLY, DAE, 3DS,
VTK), are guessed from the size (≤ 30 → m, ≤ 600 → cm, else mm). CAD-style formats (STL, PLY, 3MF,
3DS, AMF, VTK) are taken as Z up. The toast after an import says what was assumed; the Inspector's
**3D model → Units / Up axis** (`set-model-units`) re-bakes it, keeping its centre.

## Code

`src/view3d/modelImport.ts` (loaders, conversion, re-bake), `src/view3d/modelFiles.ts` (UI
helpers), `src/commands/builtin/models.ts` (`create-mesh-element`, `replace-mesh-model`,
`import-3d-model`, `set-model-units`), `src/view3d/meshes.ts` (mesh elements, shared with Revit
imports).
