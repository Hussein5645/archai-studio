# Proposal: element graphics (default look per type, per view, per render style)

Status: **implemented** (2026-09-19) with the decisions below.

Decisions from review: overrides live in the document and new documents start from the built-in
defaults (they do not inherit the previous document's overrides); the plan view can share the
section cut graphics per type (the wall's *Use section cut graphics in plan* toggle) or keep its
own; section caps use the stencil buffer so catalog assets are capped too, with cut outlines from
triangle/plane intersection; the dialog opens from the bottom-right chip, `Mod+Shift+E`, the View
menu, and from the Inspector's **Display settings** button on any system element (focused on its
type); system elements no longer show Fill/Stroke/Opacity in the Inspector — their look comes from
the graphics card only, while plain rect/line/text/image keep their per-element style.

## What shipped

- `src/graphics/schema.ts` registry (types, parameters, locks, per-style defaults),
  `resolve.ts` (cached resolver, validation, new-element defaults), `hatch.ts` (SVG pattern +
  canvas tile), `presets.ts` (file format `{ archaiGraphics: 1, presets: [...] }`, sanitising,
  built-in *Default* and *Ink* presets).
- `doc.workspace.graphics` (`{ [type]: { [view]: { [style | '*']: { [parameter]: value } } } }`).
- Commands: `open-graphics`, `close-graphics`, `set-graphic` (undoable), `reset-graphics`,
  `apply-graphics`, `save-graphics-preset`, `delete-graphics-preset`, `apply-graphics-preset`,
  `export-graphics-presets`, `import-graphics-presets`. User presets are stored in platform
  storage under `graphics-presets`.
- Board: walls, columns, door/window/facade symbols (restyled by ink class), stair children (by
  `meta.role`, inferred for older stairs), railings, curtain walls, room dividers, rooms and
  labels, measure, section and camera markers, paper, missing images/assets, and the defaults
  new rect/line/text/image elements are created with.
- 3D: every built-in material comes from the *Materials* group (walls, doors, windows, columns,
  stairs incl. separate riser plates and optional stringers, railings, rooms, generic solids,
  asset fallback); scene background and ground grid from *3D scene*.
- Section: stencil-based cut surfaces per cut material (wall core/finish, column, door, window
  frame/glass, stair, railing, generic), hatch pattern/colour/spacing/angle, cut outline colour
  and pixel weight, edges beyond the cut, background — all from *Section view* and each type's
  *Cut surface* group.
- `src/ui/GraphicsDialog.tsx`: type list by category (dot = has overrides), Board/Section/3D
  tabs, board style chips (All / Realistic / Hidden line / Shaded), live SVG preview of a sample
  element, grouped parameter rows with per-row reset, locked rows greyed with the reason, preset
  picker with Save / Delete / Import / Export, Reset type / Reset all.

## 1. Entry point

A fourth button in the bottom-right chip (grid / snap / zoom): **Graphics** (palette icon,
`Mod+Shift+E`). It opens the *Element graphics* dialog (`ui.graphicsDialog: { open, type }`, command
`open-graphics`). Same dialog is reachable from the Inspector's Display section.

## 2. Model

### 2.1 Graphic schema (code, not data)

`src/graphics/schema.ts` declares, for every element type, the graphic parameters it has. A
parameter is:

```ts
{
  id: 'cut.fill',                      // stable key
  label: 'Cut fill',
  kind: 'color' | 'width' | 'opacity' | 'dash' | 'hatch' | 'toggle' | 'choice',
  views: ['board', 'section', '3d'],   // where it applies
  styles?: BoardViewStyle[] | ViewStyle[], // undefined = every render style
  default: <value>,                    // or a function of (view, style) for style-dependent defaults
  locked?: true,                       // shown greyed with a lock, never overridable
  group: 'Cut' | 'Lines' | 'Fills' | 'Symbol' | 'Material' | ...
}
```

Element types listed (every default the app can draw):

| Category | Types |
|---|---|
| Structure | wall, column, facade element |
| Openings | door, window |
| Circulation | stair, railing |
| Envelope | curtain wall, room divider |
| Spaces | room (enclosure) |
| Drawing | line, rectangle, text, image |
| Assets | catalog asset (instance) |
| Annotation | measure, section marker, camera marker, 3D/section/camera portal frame, paper |
| Section (special) | cut surface, cut outline, beyond lines, background |

Values are only *defaults*: an element's own `style` (set through the Inspector) still wins,
exactly as today. This dialog changes what new elements get and what is drawn for parameters an
element does not carry itself (a wall's layer lines, a stair's riser lines, 3D materials).

### 2.2 Overrides (data)

`doc.workspace.graphics` (new, defaults to `{}` so existing files load unchanged):

```ts
{ [typeId]: { [view]: { [style | '*']: { [parameterId]: value } } } }
// e.g. graphics.wall.board['hidden-line']['layer.stroke'] = '#5b5b60'
```

Resolution: `resolveGraphic(doc, type, view, style, id)` = override for that style
?? override for `'*'` ?? schema default. One cached resolver per render so `shapes.tsx` /
`geometry.ts` stay cheap.

Overrides live in the document (a file looks the same on another machine). The *active preset
name* is remembered app-wide so new documents start from it. (Alternative: app-wide only, see
open question 1.)

### 2.3 What is locked

Locked parameters are the ones that carry meaning, so a drawing cannot become unreadable:

- section marker: arrow / bubble geometry, dash pattern (colour and line weight are editable);
- door: swing arc presence; window: pane line presence; stair: direction arrow and `UP` label
  presence, riser lines presence (their colour/weight editable);
- wall: openings are always cut out; hidden-line style keeps white body + black outline
  (outline weight editable);
- selection / hover accent, handles, snap guides (these are UI, not element graphics);
- cut outline is always drawn in sections (weight and colour editable).

Everything else (fills, strokes, widths, opacities, dashes, hatches, materials, toggles such as
nosing lines or stair stringers) is editable.

### 2.4 Per-type parameters (first pass)

| Type | Board (per style) | Section | 3D (per style) |
|---|---|---|---|
| Wall | body fill (realistic / shaded), outline colour+weight (hidden-line), layer line colour/weight/visible | cut fill, core fill, finish fill, hatch, cut outline weight | core material colour, finish material colour, roughness |
| Door | leaf stroke/width, swing arc colour/dash/width, frame stroke | leaf/frame fill, glass | leaf colour, frame colour |
| Window | frame stroke, pane line colour/width, sill line | frame fill, glass fill/opacity | frame colour, glass colour/opacity |
| Column | fill per material (concrete/steel/timber), outline | cut fill + hatch per material | material colours |
| Stair | tread fill, landing fill, riser line colour/weight, nosing line on/off + colour, closed-riser double line, direction line colour/weight, UP label colour/size | tread/riser colour, landing colour, stringer visible + colour, cut fill + hatch, step outline weight | tread colour, riser colour, landing colour, stringer visible + colour |
| Railing | rail stroke, baluster colour/spacing marks, glass tint | post/rail colour, panel fill | post/rail material, panel material/opacity |
| Curtain wall / room divider / facade element | stroke/fill/width | cut fill + hatch | material |
| Room | fill, fill opacity, label colour/size, outline | floor fill | floor colour |
| Line / rect / text / image | default style for new elements (fill, stroke, width, opacity, radius; text colour/size; image opacity) | - | extrusion colour when `meta.solid.height > 0` |
| Catalog asset | placeholder stroke, missing-definition colour | - | fallback box colour |
| Measure | colour, tick length, label size | - | - |
| Section marker / camera marker | colour, line weight, label size | - | - |
| Portal frame / paper | frame stroke, paper fill/border/title colour | - | - |
| **Section** | - | cut surface: fill, hatch pattern (none / diagonal / cross / dots), hatch colour, spacing, angle; cut outline weight+colour; beyond-cut line weight/colour/opacity; background colour; grid visible | - |

Per-style: a parameter can be set for one render style (e.g. wall body fill in *shaded* only)
or for all (`'*'`). The dialog shows a style chip row at the top; "All styles" is the default.

## 3. Section cut surface (new rendering)

Today a section is a clipped 3D scene: the cut leaves hollow shells. This pass adds real caps:

- **Stencil caps** in `SceneView`: for every mesh crossing the cut plane, render back faces
  (stencil +1) and front faces (stencil -1), then draw a screen-aligned quad on the cut plane
  where stencil != 0 with the type's *cut* material. Works for built-in solids and GLB assets alike.
- Cut material = fill colour + optional hatch (a small repeating canvas texture: diagonal /
  cross / dots at the configured spacing, angle, colour) + cut outline (edges of the cap polygon,
  drawn at the *cut outline* weight; edges beyond the cut keep the lighter *beyond* weight).
- Walls cap per layer band (core vs finish) since each band is its own mesh; columns/stairs per
  material.
- The plan view is a cut too: the *Cut* group of a type (fill, hatch, outline) can optionally
  drive the plan wall/column body as well ("Use cut graphics in plan", off by default).

Risk: this is the largest piece (stencil rendering plus PDF snapshots must keep it, which they do
since they rasterize the same renderer). If it slips, everything else ships and the Section tab
edits background / beyond lines / cut outline only.

## 4. Presets

A graphics preset is one portable JSON file:

```json
{ "archaiGraphics": 1, "name": "Office standard", "graphics": { ...overrides... } }
```

Dialog header: preset picker (**Built-in: Default**, **Built-in: Ink** (monochrome hidden-line
office look), **My presets...**), **Save as preset** (name prompt, stored locally in
`local-graphics-presets` next to the system presets), **Delete**, **Import...** (file picker,
one or many presets), **Export** (downloads `<name>.graphics.json`; exporting *all* my presets
gives a `graphics-presets.json` with a `presets` array, same shape the importer accepts).
**Reset** per parameter (small arrow), per type, or the whole document.

Commands (all through the palette / AI as well): `open-graphics`, `set-graphic` (undoable),
`reset-graphics`, `apply-graphics-preset`, `save-graphics-preset`, `delete-graphics-preset`,
`export-graphics-presets`, `import-graphics-presets`.

## 5. Dialog layout

```
+-- Element graphics ----------------------------- [Preset: Default v] [Save] [Import] [Export] --+
| Structure        |  Wall                                 Board | Section | 3D                    |
|   Wall     *     |  Style: [All] [Realistic] [Hidden line] [Shaded]                              |
|   Column         |  +------------------ live preview (SVG / small three.js) ------------------+ |
| Openings         |  |                                                                          | |
|   Door           |  +--------------------------------------------------------------------------+ |
|   Window         |  Fills                                                                        |
| Circulation      |    Body fill            [#3a3a3f]  (reset)                                    |
|   Stair          |    Layer lines          [x] visible  [#ffffff]  [4] px                        |
|   Railing        |  Lines                                                                        |
| ...              |    Outline (hidden line)  lock  #1f1f24         [6] px                        |
| Section          |  ...                                                                          |
+---------------------------------------------------------------------------------------------------+
```

`*` marks types with overrides in this document. Locked rows show the value greyed with a lock
icon and a tooltip saying why. Changes apply live to the board and open 3D/section portals.

## 6. Files

- `src/graphics/schema.ts` (parameter registry), `src/graphics/resolve.ts` (resolver + cache),
  `src/graphics/presets.ts` (built-in presets, file format, local store), `src/graphics/hatch.ts`
  (hatch textures for 3D, SVG patterns for 2D).
- `src/document/schema.ts`: `workspace.graphics` (default `{}`); serializer untouched.
- `src/render/shapes.tsx`, `src/render/wallBody.ts`, `src/assets/system-geometry.ts`: read
  colours/weights from the resolver instead of constants (`INK`, `LIGHT_INK`, wall fills, stair
  fills, marker colours).
- `src/view3d/geometry.ts`: `MATERIALS` built from the resolver per document; `SceneView.ts`:
  stencil caps, section graphics.
- `src/commands/builtin/graphics.ts` (commands above), `src/ui/GraphicsDialog.tsx`,
  `src/ui/StatusBar.tsx` (button), keymap, i18n strings, tests for resolver / presets / commands.

## Open questions

1. Overrides in the document (proposed) or app-wide settings only? Document keeps files
   portable; app-wide means every file on your machine looks the same without importing.
2. Should the plan view share the *Cut* graphics (wall fill + hatch) with sections, as an option?
3. Section caps by stencil (works for assets too, larger effort) versus analytic caps computed
   from my own solids only (smaller, no caps on GLB assets)?
4. Is the bottom-right chip the right home, or do you also want it in the top bar next to the
   Display style control?
5. Any type or parameter missing from the table that you already know you need?
