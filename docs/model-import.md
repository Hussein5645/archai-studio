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
