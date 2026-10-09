# Proposal: material system

Status: **implemented** (2026-10-07).

Decisions from review: all five phases in the first release; **zones** on surfaces are needed now
(see §3.1); the Graphics dialog's 3D `material.*` colours become the built-in default materials
(Graphics keeps 2D / line settings); textures come from uploads, procedural patterns and the
built-in presets (no online texture search).

Goal: create rich materials (colour, textures, real-world tiling, procedural patterns, glass,
metal, emissive), put them on an element's **slots** (wall layers, door leaf, stair treads...)
and on individual **surfaces** (one face of a wall, the top of a slab), and see them in every 3D
view, renders, section/plan views and published VR tours.

## Today

- 3D colours come from the Graphics dialog: one `material.*` colour per type (`wall /
  material.core`, `door / material.leaf`...), document-wide, with roughness and metalness hard-coded
  in `materialsFor` (`src/view3d/geometry.ts`). Every wall core in the document is the same colour.
- Column / floor / ceiling / railing parameters have a `material` *enum* (`concrete`, `timber`...)
  that only picks a colour.
- The modeling workspace already has `PbrMaterial { name, color, roughness, metalness, opacity }`,
  presets (`src/modeling/kernel/materials.ts`) and per-face overrides inside an asset.
- Generated geometry has no UVs, so no texture can be mapped yet.

## 1. Material definition

A material lives in the document's library, shared by every element that uses it:

```ts
interface Material {
  id: string; name: string;
  category: 'masonry' | 'concrete' | 'wood' | 'metal' | 'glass' | 'stone' | 'tile' | 'finish' | 'fabric' | 'other';
  base: { color: string; map?: TextureRef };          // albedo
  roughness: { value: number; map?: TextureRef };
  metalness: { value: number; map?: TextureRef };
  normal?: { map: TextureRef; strength: number };
  ao?: { map: TextureRef; strength: number };
  opacity: number;                                     // < 1 → blended (glass)
  transmission?: number; ior?: number;                 // physical glass
  emissive?: { color: string; intensity: number };
  /** Real-world size of one texture tile, mm, plus rotation/offset: textures never stretch. */
  mapping: { tileWidth: number; tileHeight: number; rotation: number; offsetX: number; offsetY: number };
  /** 2D: what the material looks like cut / in elevation (hatch + colour), so plans follow 3D. */
  graphics?: { cutHatch?: HatchSpec; surfaceHatch?: HatchSpec };
}
type TextureRef = { blobId: string } | { pattern: PatternSpec };
```

- **Image textures** are stored as document blobs (deduplicated by hash, like images today).
- **Procedural patterns** (`PatternSpec`) cover most architecture without image files and stay
  tiny: brick (stretcher / stack / herringbone / flemish, brick size, joint width, joint colour,
  colour variation), tiles (grid / offset / hexagon, size, grout), planks (width, length range,
  stagger, grain tint), stone / terrazzo (noise), stripes / louvres. Each generates albedo +
  matching normal / roughness maps on a canvas at load time.
- A **preset library** ships with the app (brick, concrete, oak, walnut, steel, brass, glass,
  frosted glass, terrazzo, marble, plaster, tiles...). Using one copies it into the document, so
  files stay self-contained (same rule as modeling assets).
- **Share**: export / import material libraries as `.cai` packages (`type: 'material'`), so the
  R2 catalog can later serve material packs like it serves assets.

Storage: a new `materials: Record<id, Material>` on the document (default `{}`, so existing files
open unchanged).

## 2. Slots: what an element exposes

Every element type declares named slots. Defaults come from today's Graphics colours, so nothing
changes visually until a material is assigned.

| Type | Slots |
|---|---|
| Wall | one per layer (`layer:0`, `layer:1`... named after the layer, e.g. *Plaster*, *Brick*) |
| Door | leaf, frame, handle |
| Window | frame, glass, sill |
| Column | body |
| Stair | tread, riser, landing, stringer |
| Railing | post / rail, panel |
| Curtain wall | glass, mullion, transom |
| Floor / ceiling | top, body, bottom |
| Room | floor finish |
| Facade element, rect / line solids | body |
| Assets (GLB) | each material inside the model, by name (*Fabric*, *Legs*...) |

Assignment order (first wins):
1. **Surface override** on that element (§3).
2. **Instance slot** override: `meta.materials = { [slot]: materialId }`.
3. **Type slot**: wall layers carry `material` in the layer itself (so a wall *type / preset* such as
   "Brick cavity 300" carries its materials, and saved presets keep them); other system types keep
   `materials` in their parameters / presets.
4. **Built-in default** (Graphics colour, as today).

## 3. Surfaces

A surface is a named face group of an element, so overrides survive edits (moving, re-lengthening,
changing thickness) instead of pointing at triangles that get rebuilt:

| Type | Surfaces |
|---|---|
| Wall | side A (exterior / first layer face), side B (interior / last), top, ends, opening reveals |
| Floor / ceiling | top, bottom, edge |
| Column | sides, top |
| Stair | per flight: treads top, risers front, soffit, sides |
| Box / rect solids | top, bottom, sides |

Meshes are built with these groups (geometry groups + `userData.slot` / `userData.surface`), so
picking a face in 3D resolves to `(element, slot, surface)`. `meta.surfaces = { [surface]: materialId }`.

Example: a wall with *Brick* core and *Plaster* finish layers, where side B in the kitchen is
overridden to *Ceramic white tiles* up to its full height. (Partial-height zones like a tiled
dado are a later step; see open questions.)

### 3.1 Zones

A surface override can be limited to a **zone**: a rectangle on the face in face coordinates
(`u` along the face from its start, `v` up from its bottom, mm), e.g. a tiled dado
`{ v: [0, 1200] }` or an accent strip `{ u: [2000, 2600] }`. Zones are listed per surface,
later ones on top: `meta.surfaces[surface] = [{ material, zone? }]`. The face is split along the
zone edges when it is built, so each piece gets one material and UVs stay continuous.

## 4. Texture mapping

All generated geometry gets UVs in **world millimetres** (box / triplanar projection per face
direction), then divided by the material's tile size. A 215 × 65 brick is 215 × 65 on every wall,
whatever its length, and courses line up across corners and between walls. Wall faces map along
the wall (u = distance along the path, v = height) so curved walls do not smear. Assets keep their
own UVs.

## 5. UI

- **Materials panel** (left panel tab next to Layers / Assets): the document library as swatches
  (rendered sphere / tile thumbnails), search, categories, **+ New** (blank / from preset / from
  image), duplicate, delete (blocked while used, with "show users"), import / export pack.
- **Material editor** (dialog): live 3D preview (sphere / cube / wall sample, with a light
  environment), and sections *Base*, *Pattern* (procedural parameters with live preview),
  *Textures* (drop image maps), *Surface* (roughness / metalness / normal strength), *Glass*,
  *Emission*, *Mapping* (tile size in mm, rotation, offset), *2D* (cut hatch / surface hatch).
- **Inspector → Materials** section for the selection: one row per slot with a swatch picker
  (shows *By type* / *Override*, reset to type). Wall layer rows also appear in the wall
  Configure dialog next to each layer's thickness.
- **Paint tool in 3D** (workspace bar *Paint*, shortcut `B`): pick a material, then
  - click a surface → assigns it to that **surface**;
  - Shift+click → assigns it to the whole **slot** of that element;
  - Alt+click → eyedropper (picks the material under the cursor).
  Hovering highlights the surface that would be painted.
- Drag a swatch from the Materials panel onto an element in 3D = paint that surface.

## 6. Rendering

- `MeshPhysicalMaterial` when transmission / clearcoat are used, `MeshStandardMaterial`
  otherwise; one three.js material per (document material) cached by content, textures cached by
  blob / pattern hash, anisotropic filtering on.
- **Realistic** style gets an environment map (room environment) so metal and glass read; the
  other styles (shaded, consistent, hidden-line, wireframe) keep working, *consistent* uses the
  material's base colour.
- Section caps / plan cuts can use the material's cut hatch (opt-in per material) instead of the
  type's cut graphics.
- **VR tours** carry the materials and textures in the exported GLB (the exporter already embeds
  textures); patterns are baked to images at export.
- The board's 2D (plan) is unchanged except for optional material hatch in cut views.

## 7. Commands (AI-operable, undoable)

`create-material`, `update-material`, `duplicate-material`, `delete-material`,
`import-materials`, `export-materials`, `assign-material { ids, slot?, surface?, materialId | null }`,
`set-wall-layer-material`. All one undo step each; assignments validate that the slot / surface
exists on that element type.

## 8. Phases

1. **Core**: material schema + library on the document, presets, colour / roughness / metalness /
   opacity / emissive, slots for every system type, Inspector slot pickers, wall layer materials
   in types and presets. Rendering through the slots. (Replaces the per-type `material` enums,
   migrated to presets.)
2. **Textures**: world-mm UVs on all generated geometry, image maps (albedo / normal / roughness /
   AO), mapping controls, environment map, editor with live preview.
3. **Procedural patterns**: brick / tile / plank / stone generators with normal maps.
4. **Surfaces + paint tool**: face groups on generated meshes, surface overrides, 3D paint /
   eyedropper / drag-drop, asset GLB slots.
5. **Packs and 2D**: material `.cai` packs (export / import, R2 catalog), cut / surface hatch from
   materials, VR export baking.

Each phase ships on its own and is usable.

## Open questions

1. **Scope of a first release:** phases 1–2 (materials + textures on slots), or all the way to
   the paint tool (phase 4) before shipping?
2. **Partial surfaces:** is per-face enough, or do you need zones on a face (tiled dado up to
   1200 mm, an accent strip)? Zones mean splitting faces by height / region; I would do them
   after phase 4.
3. **Graphics colours:** once materials exist, should the Graphics dialog's `material.*` colours
   become the built-in default materials (one place to edit), or stay as a separate quick colour?
   I propose: they become the defaults and the Graphics dialog keeps only 2D / line settings.
4. **Image sources:** only images you upload, or also a free texture source (e.g. Poly Haven, CC0)
   searchable from the editor? That needs network access and download sizes in mind.

## Libraries and smart assignment (2026-10-08)

- **Materials panel** has three tabs, like the Assets tab: **Project** (the document's materials
  and the built-in defaults), **Library** (ArchAI's default materials on R2: 93 scanned CC0 PBR
  materials from Poly Haven in groups Brick, Concrete, Wood, Plaster, Stone, Tiles, Metal, Fabric,
  Roofing, Ground; a click adds one to the project and takes it in hand) and **My materials** (the
  user's own materials on this device: uploaded images or packs, or *Save to My materials* from a
  project; reusable in every project). Code: `src/materials/library.ts`. A material remembers
  where it came from (`Material.source` = `library:<id>` / `mine:<id>`), so adding it again picks
  the project's copy. Library and My materials tiles can be dragged onto a surface in 3D.
- **Paint scopes** (3D workspace bar while painting, `materialUi.scope`): **Face** (a surface),
  **Part** (the slot: a wall layer, a door leaf, one model material), **Object** (every part of the
  element: `paint-element`) and **Replace all** (the clicked material everywhere:
  `replace-material`; replacing a built-in default changes every part that shows it; a model's
  own material is painted on every copy of that asset). Shift = Part, Ctrl = Object for one click.
- Right-click a project material: *Apply to selected* (every part), *Replace everywhere with* the
  material in hand, *Select objects using it*, *Save to My materials*.
- ArchAI Render paints the same way (Materials tab; the board applies it, one undo step there).
- Built-in defaults got better looks: wood grain on door leaves and timber, textured concrete on
  slabs and concrete columns, physical glass (transmission) for windows, curtain walls and railing
  panels, metallic frames, rails and steel.
- R2: `archai-assets/materials/{library.json, packs/<id>.cai, thumbs/<id>.png}`, built by
  `node scripts/material-library.mjs <work dir>` and uploaded with
  `node scripts/r2-upload.mjs <work dir>/out/materials archai-assets/materials`.
  `VITE_MATERIAL_LIBRARY_URL` overrides the location.

## Panel layout and in-scene controls (0.2.2.10.1)

- The Materials tab is laid out like the Assets tab: **Create** (blank, image, internet, preset,
  import / export pack) and **Upload** (to Local) at the top, **Project / Online / Local** sources
  with counts, folders (Online groups, the project's Defaults) and cards with the tile size.
- **Pick** (3D workspace bar or `I`; Alt+click while painting) picks the material under the
  cursor and opens the **quick material panel** (`src/ui/MaterialAdjust.tsx`): texture width
  (with aspect lock), rotation, offset, tint, roughness, metal, bump and opacity, previewed live
  while dragging and committed as one undo step on release; **Make unique** gives the picked face
  (or part) its own copy first; **All settings** opens the full editor. While painting or picking,
  a bar at the bottom of the 3D view holds the material in hand, Face / Part / Object / Replace all,
  Pick and Adjust (`src/ui/SceneMaterialTools.tsx`).
- Dragging a material onto a surface in 3D paints it and keeps the paint tool on; dropping one on
  the board opens the 3D workspace in paint mode with it in hand.

## As built

- Code: `src/document/material.ts` (schema), `src/materials/` (built-in defaults and presets, slots
  and resolution, patterns, three.js materials, swatches, packs, UI store),
  `src/commands/builtin/materials.ts`, `src/view3d/surfaceUv.ts` (face groups, world-mm UVs), the
  builders in `src/view3d/geometry.ts`, paint / eyedropper / hover in `SceneView`, UI in
  `src/ui/MaterialsLibrary.tsx`, `MaterialEditor.tsx`, `MaterialPreview.tsx`, `MaterialSlots.tsx`
  (Inspector), and the wall layer picker in the Configure dialog.
- Commands: `create-material`, `update-material`, `duplicate-material`, `delete-material`,
  `set-material-texture`, `assign-material`, `set-surface-paint`, `import-material-pack`,
  `export-material-pack`, `list-material-presets`, `show-materials`.
- Zones apply to wall sides A / B (the dado / accent-strip case); other surfaces take whole-surface
  paint. Stairs, doors, windows and railings take materials per slot (no surfaces).
- Paint tool: workspace bar **Paint** or `B`; or drag a swatch from the Materials tab onto a surface.
- Material packs are `.cai` ZIPs of `kind: "materials"` (metadata.json + textures/); publishing them
  in the R2 catalog is not wired yet.
- VR tours export the materials (textures with KHR_texture_transform) in their GLB.
