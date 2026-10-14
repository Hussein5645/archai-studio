# Live Bridge

For the current workspace's performance fixes, selection-wide geometry controls, plugin deltas and validation, see [bridge improvements](bridge-improvements.md).

ArchAI as the hub of a multi-app workflow: Revit, AutoCAD, Rhino, SketchUp, Blender, 3ds Max and
Unreal link to the same ArchAI project at once. Each app's model lives in the project with its own
colour and identity; changes travel element by element; who may change what is decided per part
of an element; nothing is deleted or overwritten without a rule allowing it.

The Live Bridge evolves the live link (ArchAI 0.2.2.10–0.2.2.15, plugins 0.3–0.4): the loopback
server, the plugins, the exchange format, the command system, undo and the `.AIR` format are kept.
Plugins 0.4.x (protocol 1) keep working with it.

## How it works

| Piece | Where |
|---|---|
| Project data (`doc.bridge`: sources, binding graph, conflicts, held deletions, log) | `src/document/bridge.ts` |
| Sync engine (identity, facets, authority, deletions, copies) | `src/bridge/engine.ts`, `src/bridge/facets.ts` |
| Commands | `src/bridge/commands.ts` |
| What each app receives (changes only, updates for its own objects) | `src/bridge/pull.ts` |
| Server (protocol 1 and 2) | `src/live/board.ts`, `electron/liveLink.ts` |
| Panel, inspector section, board colours, project picker | `src/bridge/LiveBridgePanel.tsx`, `BridgeInspector.tsx`, `src/render/BridgeOverlay.tsx`, `src/bridge/ProjectPicker.tsx` |
| Plugin cores | `plugins/python/archai_core.py`, `plugins/dotnet/Archai.Plugins.Core/LiveLink.cs`, `plugins/sketchup/archai/live.rb` |

### Four separate concepts

| Concept | Question | Stored in |
|---|---|---|
| **Source identity** | Which model in which app, bound to which project? | `doc.bridge.sources[key]`; the plugin remembers its project in `%LOCALAPPDATA%\ArchAI\live-bridge.json` |
| **Binding graph** | Which objects in which apps are this element? One element can have refs to several apps (its origin and copies) | `doc.bridge.elements[id].refs[key]` (id, kind, role origin/copy, fidelity, base hashes, where the app has it) |
| **Authority** | Who decides each part (facet) of an element: geometry, transform, material, metadata | per source (`authority`), element overrides (`owners`); owner `origin` (default), `archai` or `shared`, never another app |
| **Permissions** | What a link sends and receives | link `mode` (two-way, read-only, paused), `receives` (shared, nothing), element `share` (shared, source-only, archai-only), `offers` (editable copies) |

Bindings are keyed by ArchAI element id inside the project, so copy/paste never duplicates them,
undo restores them with the elements, and online projects carry them to collaborators like any
other edit.

### The same meshes in every app

Every link carries generic meshes: each app sends each of its objects as triangles (Revit too:
walls, doors, floors and families all go as meshes on the Live Bridge), ArchAI keeps them as mesh
elements, and every other linked app receives exactly those triangles. Nothing is rebuilt as a
different kind of element on the way, so a Revit wall looks the same in ArchAI, Rhino and Blender.
(Send to ArchAI, the .AIR file, still rebuilds Revit's walls, doors and slabs as editable ArchAI
elements.) Links made by Revit 0.5.0 become these meshes in place on the next sync.

### Geometry from an app is edited only in that app

**Materials always remain ArchAI-controlled.** Slot assignments, whole-object paint and surface
paint survive source geometry updates, even for source-controlled and shared presets. Imported
material entries keep stable source identities, so source colour changes do not replace finishes
edited in ArchAI. Whole-object paint also covers new or renamed source material slots. Unpainted
mesh slots continue to use their embedded source appearance. Material authority controls are
read-only and editable copies never grant another app permission to replace ArchAI materials.

**Revit Live Bridge uses the active 3D view.** Start it from a non-template 3D view; plans and
sheets suspend outgoing geometry without clearing the last linked scene. View-scoped collection,
geometry extraction at the view's detail level, permanent/category hiding and temporary hide/isolate
determine what is shared. Switching views or changing visibility refreshes the visible scope.
Objects leaving the source view are hidden in ArchAI and excluded from outgoing geometry, while
their binding and ArchAI paint remain for unhide. Actual source deletions still follow existing
conflict and mass-deletion protections. Manual `.AIR` exports remain document exports.

An element that came from an app (it has an `origin` ref) is changed only by that app. **Edited
in ArchAI** (moved, reshaped, renamed or deleted), it is put back right away as the
app sent it (`src/bridge/guard.ts`, command `bridge-revert`, from the snapshot ArchAI keeps of
each element as its app last sent it), with a message saying which app decides it; moving the
app's whole model group stays possible (it places the model). Parts handed to ArchAI or shared in
the Live Bridge panel stay editable in ArchAI. Another app can never change it: it cannot be offered as an editable copy, its parts cannot be handed
to another app's authority, and a copy another app sends anyway changes nothing and adds nothing.
Other apps receive it as reference geometry only. **Edited anyway in another app** (moved,
reshaped, copied or deleted there), it is **reset**: the plugin notices and ArchAI's version is
put back at the next sync.

To let other apps edit it, **release** it first with **Convert to ArchAI element**: it becomes
ArchAI's own element (the app it came from is kept as history; that app's object no longer
changes it and is not added again). Then offer it as an editable copy to any app (Inspector →
Live Bridge → Editable in other apps). Elements made in ArchAI can be offered directly.

### A push (an app sends its model)

1. Items are matched to their element by the app's own id (`was` moves a link when an older
   plugin used another id). Unchanged items (same hash of the item and what it depends on) are
   skipped; new ones are built and bound (into the app's **source group** on the board).
2. Changed items are rebuilt aside and merged facet by facet with three-way hashes:

   | App changed it | ArchAI changed it | Owner | Result |
   |---|---|---|---|
   | no | – | – | nothing (ArchAI edits survive) |
   | yes, to what ArchAI has | – | – | in sync (an update ArchAI sent came back) |
   | yes | no | this app, `shared`, or offered to it (ArchAI's own elements only) | applied |
   | yes | yes | this app | applied, logged (Undo restores) |
   | yes | yes | `shared` or offered | **conflict**, ArchAI's kept until resolved |
   | yes | – | ArchAI, or the app only has a copy of another app's element | not applied, logged |

3. Deletions only from complete snapshots or explicit `deleted` ids (protocol-2 plugins send
   visible objects as a partial snapshot and list the ids gone from the model: hiding deletes
   nothing). An element edited in ArchAI or linked to other apps becomes a deletion conflict;
   more than 20 deletions that are over a quarter of the app's model wait for confirmation.
   Elements deleted in ArchAI are not brought back.
4. All of it is one command: one undo step, one document change. A push that changes nothing
   changes nothing (no needless pulls elsewhere). A repeated change id gets the stored answer.

### A pull (an app receives)

- **Nodes**: elements shared with it, with a hash (including the elements they depend on), source,
  colour and the facets it may edit; elements it already has with the same hash are left out and
  listed in `present`, so the app also learns what was removed.
- **Updates** for its own objects, for facets it does not own: a move (plan translation and
  elevation; rotations stay in ArchAI) and a name. Its editable copies come again when ArchAI's
  geometry changed.
- Never: what the app sent itself (no loops), source-only and ArchAI-only elements, elements
  converted from it, anything when its link is paused or receives nothing.

### Fidelity

Each ref records how faithful an object is: **native**, **converted** (rebuilt as another
editable kind, e.g. a Revit wall as an ArchAI wall), **reference** (display only) or
**unsupported** (listed on the source in the panel, never dropped silently), and whether the
conversion was lossy. Other apps get **reference** geometry (their ArchAI Live layer). An
ArchAI element (made in ArchAI or released from an app) can be offered to them as an **editable
copy**: they make it their own object, send it back with `archai: <element>`, and ArchAI links it
as a `copy` ref of the same element; only the offered parts of their edits apply.

### Protocol 2

```
GET  /live/status?key&app&name&protocol=2&project   { protocol, document, bound, mismatch?, revision, own }
GET  /live/projects                                 { open, projects: [{ id, name, updatedAt, online, open }] }
POST /live/bind   { key, app, name, project | newName | choose: true }   { document, revision } | { cancelled }
POST /live/push   { protocol: 2, key, app, name, project, changeId, complete, deleted, model }
                  { protocol, ack, revision, document, applied: { created, updated, unchanged, deleted, held,
                    conflicts, rejected, unsupported, migrated, linked } } | { refused, message }
GET  /live/pull?key&protocol=2&project[&fresh=1]    glTF; nodes' extras.archai = { id, hash, source, color,
                                                    editable?, ref? }; root extras.archaiBridge =
                                                    { present, updates, document, revision }
```

A plugin bound to another project than the one ArchAI shows is refused (`project-mismatch`);
revisions are time-based, so a reconnect after a restart never looks unchanged. **Link to
project...** in every plugin asks ArchAI, which shows one picker (an existing project or a new
one).

## In ArchAI

- **Top bar**: the Live Bridge chip (with a badge for conflicts and held deletions) opens the
  panel: each app with its colour, status, elements, last sync; link mode, what it receives, who
  decides each part; select its model, pause/resume, sync now, disconnect; conflicts (take the
  app's, keep ArchAI's); held deletions; activity.
- **Board**: each model is a group (select it, move it as one); "Show each app's elements in its
  colour" outlines and tints them. Mesh elements are drawn as a CAD plan (`src/render/meshPlan.ts`):
  bold section lines where a 1.2 m cut crosses them, thin visible edges below the cut; objects up
  to 1.5 m high (furniture, slabs) show all their edges from above.
- **Inspector**: source, refs and fidelity, where it goes, who decides its parts, editable copies
  for other apps (ArchAI's own elements only), **Convert to ArchAI element** (releases it: no
  longer synced, the source is kept as history and it is not sent back to that app).

## In the plugins

| App | Received elements | Editable copies | ArchAI's moves | Stable ids |
|---|---|---|---|---|
| Revit | DirectShapes "ArchAI Live", one per element; sends generic meshes, only changed elements after the first sync; Pause / resume on the ribbon | DirectShapes "ArchAI Copy" | ElementTransformUtils.MoveElement | element ids |
| AutoCAD | blocks on "ArchAI Live" layers, XData `ARCHAI` | blocks on "ArchAI Copies" | TransformBy | handles |
| Rhino | meshes on "ArchAI Live", user string `archai.id` | one mesh on "ArchAI Copies" | Transform | object GUIDs (was: first 12 digits) |
| SketchUp | groups in the "ArchAI Live" group, attribute `ArchAI/id` | top-level groups (`ArchAI/copy`) | transform! | persistent ids |
| Blender | "ArchAI Live" collection, property `archai_id`, source colour | "ArchAI Copies" collection | matrix_world | `archai_uid` (duplicates get new ones; was: name) |
| 3ds Max | "ArchAI Live" layers, user property `archai_id` | "ArchAI Copies" layer | move | node handles |
| Unreal | actors tagged `ArchAILive` and `archai:<id>`, one asset each | "ArchAI Copies" folder | add_actor_world_offset | actor names |

## Status by app (2026-10-11, ArchAI 0.2.2.19, plugins 0.5.2)

How far each app's Live Bridge has been tested, and how well its geometry travels. "Run" means
the plugin's own code ran in the real app against the ArchAI desktop app; "built" means it
compiles (or passes a syntax check) but has not been run in that app yet.

| App | Live Bridge 0.5.0 tested | What was checked | Sent to ArchAI | Received from ArchAI | Rating |
|---|---|---|---|---|---|
| **Blender** 4.2 | **Run**: two Blender processes (headless) with the desktop app, `scripts/bridge-e2e.mjs` | connect and bind to one project, receive the other app's model in its colour, moves both ways, ArchAI's move applied to Blender's own object, hide (nothing deleted), delete, editable copy linked back, offered rename applied, owner wins; stable ids across duplicates | meshes, curves, surfaces, metaballs and text, with modifiers and instances applied; materials as colour, opacity, roughness, metalness | one mesh object per element in "ArchAI Live", source colour; editable copies in "ArchAI Copies" | **Good**: exact triangles both ways; tested end to end |
| **AutoCAD** 2026 | **Run**: accoreconsole with the plugin's drawing code (`Archai.AutoCAD.BridgeTest`) next to Blender and the desktop app | join a project, receive Blender's model on an ArchAI Live layer (tagged), its box moving in ArchAI and Blender, ArchAI's move applied to its own solid, editable copy on "ArchAI Copies" linked back, delete | 3D solids, surfaces, regions, meshes, 3D faces and blocks (faceted); 2D lines and hatches are not sent | one block (SubD meshes) per element on "ArchAI Live" layers; copies refilled in place | **Good** for 3D drawings; the ribbon/Idle loop of full AutoCAD was not run, only the console |
| **Revit** 2024–2027 | **Built** (all four versions). The released 0.4.1 plugin ran live against this ArchAI in a real Revit (85 elements bound and kept across syncs, protocol 1) | 0.5.1 element-by-element apply, reset, pause, Link to project and copies not run in Revit yet | every model element as a generic mesh (walls, doors, floors, roofs, stairs, families), materials as colours; only changed elements after the first sync | DirectShapes (Generic Models), one per element, reset when edited in Revit; copies as "ArchAI Copy" DirectShapes; ArchAI's moves of Revit elements when Revit does not own their position | **Good**: the same meshes in ArchAI and every app; **reference only** back into Revit (DirectShapes, not editable walls) |
| **Rhino** 8 | **Built**. The released 0.4.1 plugin connected live to this ArchAI in a real Rhino (an empty, unsaved model, so nothing synced) | 0.5.0 not run in Rhino yet | breps, extrusions, surfaces, meshes, SubD and blocks, meshed with Rhino's render mesh settings; NURBS become triangles (lossy) | meshes on "ArchAI Live", tagged per element, source colour; copies joined into one mesh | **Expected good** (same core as AutoCAD); NURBS precision is lost both ways |
| **SketchUp** 2021+ | **Built**: Ruby syntax checked (ruby.wasm); not run | none in SketchUp | top-level groups and components (one object each), loose faces as one object | groups in the "ArchAI Live" group; copies as top-level groups | **Not tested**: the protocol code is new and only read and syntax-checked |
| **3ds Max** 2025+ | **Built**: Python compiles; 3ds Max is not installed here | none in 3ds Max | geometry nodes as snapshot meshes (modifiers applied) | meshes on "ArchAI Live" layers, user property per element; copies reshaped in place | **Not tested** |
| **Unreal** 5.1+ | **Built**: Python compiles; not run | none in Unreal | static mesh actors (instanced meshes too) | one static mesh asset and actor per element, tagged; copies re-imported in place | **Not tested**; first syncs of large models import one glTF per pull and may be slow |

What travels the same way for every app:

- **Geometry** goes as triangle meshes in millimetres, the same triangles in ArchAI and in every
  linked app; positions are exact (up to 0.1 mm rounding). In ArchAI they are mesh elements that
  can be moved, coloured and converted but not reshaped.
- **Another app's geometry edited in a plugin is reset** to ArchAI's version, and **an app's
  geometry edited in ArchAI is put back** to the app's version, until it is released with Convert
  to ArchAI element (then offered as an editable copy if another app should edit it).
- **Materials** carry colour, opacity, roughness and metalness; textures and UV maps do not
  travel yet.
- **Back into the apps** everything arrives as display geometry (reference). Only ArchAI's own
  elements (made in ArchAI, or released from an app with Convert to ArchAI element) can be offered
  as editable copies, which are plain meshes there (not native walls, solids or NURBS).
- **ArchAI's changes to an app's own objects** are moves (plan and elevation) and names; rotations
  made in ArchAI stay in ArchAI. AutoCAD and Revit have no object names, so only moves apply there.
- **Ids**: stable in every app (Revit element ids, AutoCAD handles, Rhino GUIDs, SketchUp
  persistent ids, Blender's own id property, 3ds Max handles, Unreal actor names). Objects synced
  by 0.4.x with older ids are moved to the new ids on the first 0.5.0 sync (Blender, Rhino).

To test an app that is marked "built": turn on Live Bridge in it next to the ArchAI desktop app
0.2.2.16, then check the panel in ArchAI (top bar) and its activity log after each step: send,
move, rename, hide, delete, and an editable copy from Inspector → Live Bridge.

## Tests

- `src/bridge/bridge.test.ts`: identity, in-place updates, ArchAI edits surviving, owner wins,
  conflicts, ArchAI-owned facets, partial/complete/held deletions, repeated changes, several
  sources, read-only links, migration from the live link, undo, deleted-in-ArchAI, unsupported
  items, hosted openings, protocol 1, pulls with changes only, updates and convergence, editable
  copies, id changes, source groups, conversion, export flattening, online projects.
- `scripts/bridge-e2e.mjs`: the desktop app with two real Blender processes and AutoCAD
  (accoreconsole, `plugins/autocad/Archai.AutoCAD.BridgeTest`): connect, exchange, moves both
  ways, hide, delete, received geometry moved or deleted in Blender is reset, another app refused
  an app's geometry, release then editable copies in Blender and AutoCAD, a released element no
  longer changed by its app (31 checks). Run it with
  the Blender profile isolated (the script does): a factory-startup Blender on your own profile
  removes your extensions' Python packages.
- See "Status by app" above for what was run in each app. Rhino, Revit, 3ds Max, Unreal and SketchUp compile (SketchUp: Ruby syntax checked) but were not
  run here.
