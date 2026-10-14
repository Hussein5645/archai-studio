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
with its existing diffuse vertex bake; D5's rendered lighting is not preserved. The folder limit
is 256 MB / 10,000 files; scenes over one million triangles can be imported but cannot auto-bake.

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
