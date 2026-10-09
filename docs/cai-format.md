# ArchAI `.CAI` package format

`.CAI` is a ZIP archive with a different extension. Paths are relative to the archive root and
use forward slashes. File names are case-insensitive when ArchAI reads them.

## Required contents

```text
asset.CAI
├── metadata.json       required
├── mapping.json        required
├── views/
│   └── top.png         required (PNG, JPEG, WebP, or SVG)
└── models/
    └── model.glb       at least one GLB or FBX is required
```

For regular assets, `front` and `side` are optional. Placed system types (door, window, column,
stair, facade element) require all three orthographic views: `top`, `front`, and `side`. Line-based
system types (wall, railing, curtain wall) instead ship a `views/section.*` cross-section swatch and
need no top view or model. Both model formats may be included. The 2D board reads the top view now;
the remaining views and model mapping are preserved for configuration and 3D work.

## `metadata.json`

```json
{
  "caiVersion": 1,
  "id": "door-single-900",
  "name": "Single door 900",
  "category": "Architecture/Openings/Doors",
  "kind": "system",
  "system": {
    "type": "door",
    "parameters": {
      "operation": "swing",
      "construction": "panel",
      "threshold": 0,
      "alignment": "middle",
      "handing": "left"
    }
  },
  "size": { "width": 900, "height": 120 },
  "tags": ["single", "hinged"]
}
```

- `id` is stable and unique across the whole catalog.
- `category` creates the library folder path.
- `size` is the real-world top-view footprint in millimetres.
- General placeable objects use `"kind": "asset"` and omit the `system` block.
- System packages use `"kind": "system"` and require `system.type` plus type-specific defaults in
  `system.parameters`. Every key given must be valid for the tool (see `docs/system-tools.md`
  section 3 for the per-tool shapes); missing keys take the built-in defaults. `category` is
  optional for system packages and `size` may be `0 x 0` for line-based types.
- Supported system types are `wall`, `window`, `door`, `column`, `stair`, `railing`,
  `curtain-wall`, and `facade-element`.
- Wall packages carry **presets** instead of one parameter set: `system.presets` is a list of
  `{ "id", "name", "layers", "locationLine", "height", "elevation" }` and every preset becomes one
  selectable wall type. Presets saved in the app are exchanged as presets files (*Export presets* / *Import presets* in the
  dialog) and importing a wall package imports all of its presets.
- System packages are not shown in the Assets tab. Their matching architecture tool places a
  default element; select that element and open *Configure* in the Inspector to choose a type and
  edit its parameters. The dialog also imports a local `.cai` type.

## `mapping.json`

```json
{
  "version": 1,
  "views": {
    "top": "views/top.png",
    "front": "views/front.png",
    "side": "views/side.png"
  },
  "models": {
    "glb": "models/model.glb",
    "fbx": "models/model.fbx"
  }
}
```

`views.top` and one of `models.glb` or `models.fbx` are mandatory for regular assets and placed
system types; placed system types also require `views.front` and `views.side`. Line-based system
types require `views.section` only (models optional). Every mapped path must exist in the archive.

## R2 index

R2 public buckets do not expose object listing. The bucket root therefore contains `catalog.json`:

```json
{
  "version": 1,
  "source": "cloudflare-r2:archai-assets",
  "folders": ["Architecture/Openings/Doors", "Furnish"],
  "packages": [
    { "key": "Furnish/Seating/sofa-2-seat.CAI" }
  ],
  "system": [
    { "tool": "wall", "key": "system/wall/wall-brick-cavity.cai" },
    { "tool": "door", "key": "system/door/door-double-swing-1800.cai" }
  ]
}
```

System types live under `system/<tool>/` (`wall`, `column`, `door`, `window`, `stair`, `railing`)
and are listed in `system`, never in `packages`. `npm run catalog:samples -- <folder>` writes one
example package per tool to start from.

Generate and validate the index before uploading:

```powershell
npm run catalog:cai -- C:\path\to\r2-upload-folder
```

Upload `catalog.json` and the `.CAI` files while preserving their relative object keys. Invalid
packages are rejected by the generator and skipped defensively by the app.

A large library inlines each regular asset's `metadata` and `mapping` in its `packages` entry,
with the bucket keys of its top view and thumbnail, so the Assets tab lists without downloading
any package (one is fetched when it is placed or its model is needed):

```json
{ "key": "Populate/Plants/Trees/tree_small_02.cai",
  "metadata": { "caiVersion": 1, "id": "tree_small_02", "name": "Small tree", "category": "Populate/Plants/Trees", "kind": "asset", "size": { "width": 2870, "height": 2930 }, "modelHeight": 4560, "lod": { "low": true } },
  "mapping": { "version": 1, "views": { "top": "views/top.png", "preview": "views/preview.png" }, "models": { "glb": "models/model.glb", "glbLow": "models/model-low.glb" } },
  "top": "Populate/Plants/Trees/tree_small_02.top.png",
  "preview": "Populate/Plants/Trees/tree_small_02.preview.png" }
```

`scripts/asset-library.mjs` writes such entries (`index.json`) for the CC0 library.

## Assets modeled in ArchAI (levels of detail, styled views, cameras)

Packages written by the modeling workspace (`Package .CAI`) add optional fields; older readers
ignore them:

- `metadata.json`: `modelHeight` (mm, height of the model above the ground), `lod: { low }`
  (whether a low level of detail model is included) and `cameras: [{ name, eye, aim, fov }]`
  (millimetres relative to the model origin = plan centre on the ground; later the project can
  look through them from the placed asset).
- `mapping.json`: `views.preview` → `views/preview.png`, a hidden-line perspective rendered from the
  asset's **preview camera** (`cameras[].preview: true`); the Assets library shows it as the
  thumbnail while the board keeps using `views/top`. Packaging requires at least one camera
  ticked as preview. `models.glbLow` → `models/model-low.glb`, the subset of layers the author
  flagged for the low LOD; `styles.<style>.{top,front,side}` → `views/<style>/…png`, the same
  three views rendered in `color`, `shaded`, `wireframe` and `hidden-line` (the plain `views`
  are the realistic renders). Views are cut at the workspace's view planes, like its 2D panes.

The board always draws a placed asset from its 3D model: its plan symbol is a top view rendered
from the model in the board's **View style** (realistic / hidden line / shaded), and plan and
section views cut the model. The package images are used only when a package has no model or it
cannot be loaded (then `views/<style>/top.png` when the package has one, otherwise the plain image
with a CSS filter), and in static exports. The **Level of detail** setting (Inspector → Workspace →
Display) applies to 3D views only: *high* shows the full model, *low* `model-low.glb` (or a plain
box when the package has none; 2D views use the full model instead of a box). Any placed asset can
override the level of detail individually (Inspector → *Level of detail*, `meta.lod`, command
`set-element-lod`).

## Parametric assets (`models/recipe.json`)

A package modeled in ArchAI with parameters also maps `recipe` → `models/recipe.json`: the bodies,
sketches, materials, parameters and formula bindings of the modeling workspace, plus `bounds` (the
packaged model's bounds in the model frame). Body nodes in `model.glb` are named
`archai-body_<bodyId>`. Placing the asset copies the recipe onto the definition
(`definition.meta.parametric`), so documents stay self-contained. A copy whose exposed parameters
differ from the defaults (`meta.parametric.values`) is rebuilt from the recipe in the modeling
kernel worker: the body nodes are replaced, imported layers stay. Its box then follows the rebuilt
model at the same drawing scale, keeping the model origin in place (`meta.parametric.footprint`,
command `fit-parametric-footprint`). Readers that do not know the recipe show the packaged model.
