# Live Bridge

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
| **Authority** | Who decides each part (facet) of an element: geometry, transform, material, metadata | per source (`authority`), element overrides (`owners`); owner `origin` (default), `archai`, `shared` or another app |
| **Permissions** | What a link sends and receives | link `mode` (two-way, read-only, paused), `receives` (shared, nothing), element `share` (shared, source-only, archai-only), `offers` (editable copies) |

Bindings are keyed by ArchAI element id inside the project, so copy/paste never duplicates them,
undo restores them with the elements, and online projects carry them to collaborators like any
other edit.

### A push (an app sends its model)

1. Items are matched to their element by the app's own id (`was` moves a link when an older
   plugin used another id). Unchanged items (same hash of the item and what it depends on) are
   skipped; new ones are built and bound (into the app's **source group** on the board).
2. Changed items are rebuilt aside and merged facet by facet with three-way hashes:

   | App changed it | ArchAI changed it | Owner | Result |
   |---|---|---|---|
   | no | – | – | nothing (ArchAI edits survive) |
   | yes, to what ArchAI has | – | – | in sync (an update ArchAI sent came back) |
   | yes | no | this app, `shared`, or offered to it | applied |
   | yes | yes | this app | applied, logged (Undo restores) |
   | yes | yes | `shared` or offered | **conflict**, ArchAI's kept until resolved |
   | yes | – | ArchAI or another app | not applied, logged |

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
conversion was lossy. Other apps get **reference** geometry (their ArchAI Live layer) unless an
element is offered to them as an **editable copy**: they make it their own object, send it back
with `archai: <element>`, and ArchAI links it as a `copy` ref of the same element.

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
  colour" outlines and tints them.
- **Inspector**: source, refs and fidelity, where it goes, who decides its parts, editable copies
  for other apps, **Convert to ArchAI element** (no longer synced; the source is kept as history
  and it is not sent back to that app).

## In the plugins

| App | Received elements | Editable copies | ArchAI's moves | Stable ids |
|---|---|---|---|---|
| Revit | DirectShapes "ArchAI Live", one per element | DirectShapes "ArchAI Copy" | ElementTransformUtils.MoveElement | element ids |
| AutoCAD | blocks on "ArchAI Live" layers, XData `ARCHAI` | blocks on "ArchAI Copies" | TransformBy | handles |
| Rhino | meshes on "ArchAI Live", user string `archai.id` | one mesh on "ArchAI Copies" | Transform | object GUIDs (was: first 12 digits) |
| SketchUp | groups in the "ArchAI Live" group, attribute `ArchAI/id` | top-level groups (`ArchAI/copy`) | transform! | persistent ids |
| Blender | "ArchAI Live" collection, property `archai_id`, source colour | "ArchAI Copies" collection | matrix_world | `archai_uid` (duplicates get new ones; was: name) |
| 3ds Max | "ArchAI Live" layers, user property `archai_id` | "ArchAI Copies" layer | move | node handles |
| Unreal | actors tagged `ArchAILive` and `archai:<id>`, one asset each | "ArchAI Copies" folder | add_actor_world_offset | actor names |

## Tests

- `src/bridge/bridge.test.ts`: identity, in-place updates, ArchAI edits surviving, owner wins,
  conflicts, ArchAI-owned facets, partial/complete/held deletions, repeated changes, several
  sources, read-only links, migration from the live link, undo, deleted-in-ArchAI, unsupported
  items, hosted openings, protocol 1, pulls with changes only, updates and convergence, editable
  copies, id changes, source groups, conversion, export flattening, online projects.
- `scripts/bridge-e2e.mjs`: the desktop app with two real Blender processes and AutoCAD
  (accoreconsole, `plugins/autocad/Archai.AutoCAD.BridgeTest`): connect, exchange, moves both
  ways, hide, delete, editable copies in Blender and AutoCAD, owner wins (26 checks). Run it with
  the Blender profile isolated (the script does): a factory-startup Blender on your own profile
  removes your extensions' Python packages.
- Rhino, Revit, 3ds Max, Unreal and SketchUp compile (SketchUp: Ruby syntax checked) but were not
  run here.
