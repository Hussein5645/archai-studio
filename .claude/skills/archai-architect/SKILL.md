---
name: archai-architect
description: How to think and work as the project's architect while producing or reviewing an actual design inside ArchAI — reading a brief, sequencing levels/walls/rooms/stairs/views, spatial-planning and code-adjacent sizing heuristics, and a critique loop. Use together with archai-tools (which covers the mechanical how-to-dispatch) whenever the task is to actually design something in ArchAI, not just operate it.
---

# Designing as ArchAI's architect

This skill is about judgment: what to draw, in what order, and how to check it's sound. Use the
`archai-tools` skill for the mechanics (discovering and dispatching commands, reading state,
undo). This skill assumes you already know how to call `window.__archai.executor.dispatch(...)`.

## Ground yourself in the real command surface first

Don't work from memory of "what CAD tools usually have." Call `describe()` and filter by `group`
to see what's actually available in this build (`create`, `edit`, `transform`, `arrange`,
`select`, `view`, `document`, `history`, `shell`). The vocabulary below names real, current
command ids as landmarks, but always re-check `describe()` — commands get added/renamed.

Key building blocks, roughly in the order a project usually touches them:

| Stage | Representative commands |
|---|---|
| Start | `new-document` / `create-project-from-template`, `set-screen` |
| Levels | `create-level` — a rectangular level extent + 3D datum; most elements attach to one |
| Enclosure | `create-wall-segments` (endpoint-snapped, join-aware), `create-curved-wall`, `create-room-enclosure` (room face + area label from a closed wall/divider boundary), `create-slab-enclosure` (floor/ceiling from a closed boundary) |
| Vertical circulation | `create-stair` (runs + landings, step by step), `add-stair-railing` |
| Openings & fixtures | `place-catalog-asset` (CAI catalog, e.g. doors/windows/furniture), `apply-system-asset` (system package applied to an existing element, e.g. a wall) |
| Parametric/custom | `create-parametric-component` + its node graph, for anything not covered by a catalog asset |
| Review | `create-view3d` / `open-view3d`, `create-camera-view`, `create-section-view`, `set-plan-cut-height` |
| Output | `create-paper`, `set-paper`, `export-paper-pdf` |
| Organize | `show-layers`, `group-selection`, `toggle-visibility`, `lock-selection` |

## Workflow: brief → design

1. **Read the brief.** Extract: site/plot constraints, program (room list + rough areas),
   occupancy/use type, any explicit code or client constraints, and what "done" looks like
   (a floor plan? a 3D massing? a reviewable set with sections and a PDF?).

2. **Set up structure before content.** Create the document/project, then levels
   (`create-level`) for each storey before drawing anything on it — walls, rooms, and stairs are
   usually placed relative to a level's extent and elevation, not floating in space.

3. **Block out enclosure, then verify closure before rooms.** Draw walls
   (`create-wall-segments`) as closed loops for anything you intend to turn into a room —
   `create-room-enclosure` needs a closed wall/divider boundary to produce a face and area label.
   Read state back after drawing to confirm the loop actually closed (no dangling endpoints)
   before calling it.

4. **Place vertical circulation deliberately.** Stairs (`create-stair`) connect levels; decide run
   direction, landing count, and railing side (`set-stair-railing-side`) based on the plan's
   circulation, not just wherever there's empty space.

5. **Populate with catalog assets, not ad-hoc geometry, when a fitting asset exists.**
   `place-catalog-asset` for discrete furniture/fixtures/doors/windows keeps the model consistent
   and swappable; only fall back to raw `create-rect`/`create-line`/parametric components for
   things the catalog doesn't cover.

6. **Review in 3D and section before calling it done.** `create-view3d`/`open-view3d` for a
   massing/spatial sanity check, `create-section-view` for vertical relationships (floor-to-floor
   heights, stair headroom), `create-camera-view` for a specific vantage the brief cares about.

7. **Output only once the review passes.** `create-paper` + `set-paper` + `export-paper-pdf` for a
   deliverable sheet — don't export mid-iteration.

## Spatial-planning and sizing heuristics (defaults to reason from, not hard rules)

Use these as a sanity check on dimensions you're about to dispatch (all figures approximate,
metric, residential/light-commercial baseline — override with anything the brief specifies):

- **Circulation width:** primary corridors ≥ 1200 mm clear (900 mm absolute minimum for a
  secondary passage); door clear openings ≥ 800 mm for accessible routes, 700 mm minimum
  elsewhere.
- **Stairs:** rise 150–180 mm, going (tread) 250–300 mm, and roughly `2×rise + going ≈ 600–650 mm`
  as a comfort check. Headroom ≥ 2000 mm along the full run. Flight width ≥ 900 mm (≥ 1000 mm if
  it's a required egress path for more than a couple of people).
- **Room floor-to-ceiling height:** 2400–2700 mm habitable, 2100 mm minimum for non-habitable
  utility space.
- **Room sizing (rough minimums, habitable):** bedroom ≥ 7 m² (single) / ≥ 9–11 m² (double),
  bathroom ≥ 3.5–4.5 m², kitchen work core ≥ 5–6 m² excluding dining. Living spaces scale with
  program, not a fixed minimum — size to furniture layout instead.
- **Egress:** every habitable space needs a route to an exit that doesn't pass through a single
  point of failure; don't design a plan where the only stair also chokes a fire-rated corridor
  without flagging it.

These are heuristics for a first-pass layout and for catching an obviously broken dimension (a
1400 mm "bedroom", a stair with 400 mm going) — they are not a substitute for the applicable local
building code on a real project. Flag to the user when a dimension is code-adjacent and
jurisdiction-specific rather than silently picking a number.

## Critique loop

After drafting a stage, re-read state and ask:
- Do the walls actually close where a room is expected (`create-room-enclosure` will fail or
  produce a degenerate face otherwise)?
- Does circulation reach every room without doubling back through another room unnecessarily?
- Do stated room dimensions/areas roughly match the brief's program list?
- Does the section view show sane floor-to-floor heights and stair headroom?
- Is there anything a human should confirm before it's treated as final (structural sizing,
  code compliance, anything safety-critical)? Say so explicitly rather than presenting a guess as
  settled.

Iterate with small, undoable dispatches (see `archai-tools`) rather than one large batch — it's
much easier to spot and fix a bad wall placement immediately than after twenty more commands
depend on it.
