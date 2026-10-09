# Board drafting and editing

Precision drawing and Revit / AutoCAD-style edit tools on the main board and on sheets. Every
tool ends in a command (one undo step), so agents can do the same through `window.__archai`.

## Code map

| Piece | Where |
| --- | --- |
| Snap geometry of the document (segments, arcs, key points; cached per element table) | `src/drafting/geometry.ts` |
| Object snaps, tracking and polar lines | `src/drafting/osnap.ts` |
| Typed values (`3000`, `3000<30`, `@dx,dy`, `#x,y`, `WxH`) | `src/drafting/input.ts` |
| Circle / arc / polygon / ellipse builders | `src/drafting/shapes.ts` |
| World-space paths (lines, arcs, Béziers): trim, extend, split, corner, offset, join, fillet | `src/drafting/paths.ts` |
| Element ↔ path, reflections | `src/drafting/lines.ts` |
| Interactive draw / modify tools, pen tool, selection step, prompts | `src/interaction/drafting.ts` |
| Commands | `src/commands/builtin/drafting.ts`, `src/commands/builtin/sheetLayout.ts` |
| Options bar, tool prompt banner, temporary dimensions | `src/ui/DraftingBar.tsx`, `src/ui/ToolPrompt.tsx`, `src/render/TempDimensions.tsx` |
| Sheet smart guides | `src/sheets/guides.ts` |

## Drawing

- **Snaps** (status bar ⌖ menu, F3 toggles): endpoint, midpoint, centre, quadrant, intersection,
  perpendicular, tangent, extension, nearest; tracking lines through hovered points; polar angles
  (15° by default). Shift locks the direction; Alt draws free. The marker shape says what snapped.
- **Typed values** while drawing or editing, in the display unit: `3.5` (length along the
  pointer), `3.5<30` (length and angle, counter-clockwise), `1.2,-0.4` (relative), `#10,5`
  (absolute), `2x1` (rectangle size). Enter applies; the cursor box shows the value and a live
  measurement.
- **Tools**: Line `L`, Rectangle `R` (click-click, drag, `WxH`, corner radius), Circle `C`
  (centre / 2 / 3 points), Arc `A` (3 points, centre-ends, tangent), Polygon `PG`, Ellipse `EL`,
  Curve (pen) `B`: click for a corner, click-drag for a smooth curve (Alt breaks the handles),
  click the first point to close, Enter / double-click to finish.

## Editing

- **Modify menu / two-letter shortcuts**: Move `MV`, Copy `CO` (count, repeats from the base
  point), Rotate `RO`, Mirror `MM` (click a line as axis or two points; keeps the original by
  default), Scale `RE`, Array `AR` (linear / polar, live: edit items and spacing in the options
  bar, Explode to release), Offset `OF`, Trim / extend to corner `TR` (or delete a piece), Extend
  to boundary `ET`, Split `SL`, Fillet / chamfer `FL`, Match properties `MA`, Join, Explode.
  Trim, extend, split, corner, offset, fillet, join and explode work on straight lines, arcs,
  circles and Bézier curves alike.
- **Prompts**: a banner above the board says what the tool needs next — SELECT (click objects,
  Enter / Done / right-click to continue), PICK (a curve, highlighted under the cursor) or POINT.
- **Grips** on drawn lines: vertices, segment middles, arc radii, curve nodes and Bézier handles;
  connected line ends follow. Temporary dimensions on a selected line or rectangle: click a value
  and type a new one.
- **Selection**: a box dragged left→right takes what is fully inside, right→left what it touches.
  With several selected, the options bar offers a category filter, Select similar (`SA`), align,
  distribute, join and explode. Enter repeats the last tool.

## Sheets

- Items dragged on a sheet snap to the margins, the centre lines, other items' edges and centres,
  and to equal gaps; the margins and centre lines are drawn as guides.
- The sheet panel's Layout arranges the views in a grid, row or column inside the margins; views
  can be dragged from the list onto the sheet.
- Templates: save a sheet (paper, title block, notes — without views) and create new sheets from
  it in any project (stored in the app's storage).
- *Sheets for all levels* (board right-click or command palette) makes one numbered sheet per
  level plan.

## Site boundary snapping

A map's site boundary (`meta.location.boundary`) is part of the board's snap geometry
(`src/drafting/geometry.ts`): its corners snap as end points, its edges as lines (midpoint,
nearest, intersection, perpendicular...), so every drawing and modify tool snaps to it. The
boundary editor snaps its corners the same way while drawing and while dragging a corner or a
midpoint (`src/interaction/boardSnap.ts`, the snap shared with the drafting tools); a dragged
corner does not snap to its own boundary, and Alt skips snapping.

## Profile drawing mode (floors, ceilings, levels)

Choosing the Floor, Ceiling or Level tool enters the profile mode (Revit's sketch mode); the
magenta bar above the toolbar shows what is drawn and whether it is one closed loop.

- Draw the boundary with any board tool: Line, Rectangle, Arc, Circle, Polygon, Pen, trim and the
  other modify tools. Floor / Ceiling can still click inside closed walls to pick them as a loop
  (Pick walls); Level can still drag a rectangle. Everything drawn since the mode started is the
  profile (`src/drafting/profile.ts`); its curves are highlighted and open ends ringed in red.
- **Finish** joins the curves into one closed loop (arcs and Béziers stay exact) and creates the
  floor / ceiling / level, then removes the sketch curves. An open or doubled loop is refused
  with the reason, and the mode stays on. **Cancel** removes what was drawn.
- **Edit boundary** (double-click a floor, ceiling or level, or its context menu) reopens the mode
  with the outline as a sketch line; Finish reshapes the element. A level keeps a
  non-rectangular outline in `meta.level.outline`; its rectangle becomes the outline's bounds
  and what it holds stays in place.
- Commands: `begin-profile-edit { id }`, `finish-profile-edit`, `cancel-profile-edit`
  (`src/commands/builtin/profileEdit.ts`).
