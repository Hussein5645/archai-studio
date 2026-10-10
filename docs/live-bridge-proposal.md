# Live Bridge — design (revision 2)

Status: **approved in principle, revised** after review. Live Bridge evolves the live link
(docs/plugins.md, "Live link"): the loopback server, the plugins, the exchange format, the command
system, undo and the `.AIR` format are kept and extended.

## 1. What exists today

| Piece | Where | What it does |
|---|---|---|
| Loopback server | `electron/liveLink.ts` | `127.0.0.1:47821`: `status`, `push`, `pull`, `stop`, `account`, forwarded to the board window over IPC |
| Board side | `src/live/board.ts` | Connected apps (in memory), a revision counter (in memory), opens/creates a project for a plugin on the Home screen (`live:project:<key>`) |
| Sync command | `src/live/sync.ts` `sync-live-link` | One undo step: deletes everything the plugin sent before and re-imports its whole model; elements tagged `meta.liveLink = { key, app }` |
| Pull | `board.ts` | The whole project minus that plugin's elements, as one binary glTF |
| Exchange format | `src/revit/exchange.ts` | Walls, openings, slabs, columns, railings, rooms, meshes, levels, materials; every item has a source `id` |
| Plugins | C# core (Revit, AutoCAD, Rhino), Python core (Blender, 3ds Max, Unreal), Ruby (SketchUp) | Push 1.5 s after an edit, poll every 2 s, pull when the revision moved; ArchAI's model goes into an "ArchAI Live" layer, replaced each time, never sent back |

Gaps: no identity across syncs (ArchAI-side edits are lost on every sync), whole models both
ways, unstable ids in Blender (`name[:12]`), no ownership/permissions/conflicts, implicit project
choice, nothing persisted per project, no management UI.

## 2. Architecture

### 2.1 Four separate concepts

| Concept | Question it answers | Stored in |
|---|---|---|
| **Source identity** | Which model in which app is this, and which project is it bound to? | `doc.bridge.sources[key]` |
| **Binding graph** | Which objects in which apps are the same thing as this ArchAI element? | `doc.bridge.elements[archaiId].refs[sourceKey]` |
| **Authority** (property level) | Who may change this element's geometry / transform / material / metadata? | per source defaults + element overrides |
| **Sync permissions** | What may a link send and receive at all? | `doc.bridge.sources[key].mode / receives`, element `share` |

### 2.2 Document data: `doc.bridge` (optional; older documents and `.AIR` files load unchanged)

```ts
bridge?: {
  version: 1,
  sources: Record<SourceKey, {
    app, name, color,                         // colour assigned once, kept
    mode: 'two-way' | 'read-only' | 'paused', // read-only: the link only receives
    receives: 'shared' | 'nothing',
    authority: Record<Facet, Owner>,          // defaults for elements this source created
    linkedAt, lastSync, lastChangeId, lastRevision,
    unsupported: { id, kind, reason }[],      // items ArchAI could not build: listed, never dropped silently
  }>,
  elements: Record<ArchaiId, {                 // the binding graph
    share?: 'shared' | 'source-only' | 'archai-only',
    owners?: Partial<Record<Facet, Owner>>,    // element-level authority overrides
    state: Record<Facet, Hash>,                // ArchAI's facets after the last sync (detects ArchAI edits)
    removed?: number,                          // deleted in ArchAI: a source sync does not bring it back
    refs: Record<SourceKey, {
      id: string, kind: string,                // the object in that app
      role: 'origin' | 'copy',                 // created there, or contributed to it from ArchAI
      fidelity: 'native' | 'converted' | 'reference' | 'unsupported',
      lossy: boolean,
      base: Record<Facet, Hash>,               // that app's facets as last received
      item?: Hash,                             // its raw exchange item (skips unchanged items fast)
    }>,
  }>,
  conflicts: { id, element, source, facet: Facet | 'delete', at, theirs? }[],
  held: { id, source, elements: ArchaiId[], at }[],   // deletions waiting for confirmation
  log: { at, source, text }[],                        // last 200 sync events
}
Facet = 'geometry' | 'transform' | 'material' | 'metadata'
Owner = 'origin' | 'archai' | 'shared' | SourceKey
```

One ArchAI element can carry refs to several apps (its Revit origin, the Rhino copy it was
contributed as, the Blender copy), so a change coming back from any of them updates the same
element instead of creating a duplicate. Bindings are keyed by ArchAI id in the document, so
copy/paste never duplicates a binding.

### 2.3 Facets and authority

An element's data is split into facets: **geometry** (kind, shape, points, sizes, `arch`, `solid`,
`mesh`, children), **transform** (x, y, rotation, elevation, level link), **material** (`materials`,
style), **metadata** (name, BIM properties, other meta). Visibility and lock are always ArchAI's.

Defaults for a new source: geometry, transform, metadata and material owned by `origin`.
Users can hand a facet to ArchAI, to `shared`, or to another app, per source or per element
(e.g. Revit owns geometry and BIM metadata, Blender owns materials).

For each incoming item and facet (three-way, with hashes):

| Source changed it? | ArchAI changed it since? | Owner | Result |
|---|---|---|---|
| no | – | – | nothing (ArchAI edits survive) |
| yes | no | this source or `shared` | apply |
| yes | yes | this source | apply, logged (undo restores) |
| yes | yes | `shared` | **conflict**, ArchAI's version kept until resolved |
| yes | – | ArchAI or another app | not applied, logged; the source gets ArchAI's version back |

### 2.4 Safe deletions

- A push says whether it is a **complete snapshot** of the source model or **partial**
  (selection, visible-only, filtered). Partial pushes never delete; only explicit `deleted` ids do.
- Old plugins (protocol 1) send everything visible; their pushes count as complete, as today.
- A deletion is not applied when the element was edited in ArchAI since, or has refs from other
  apps: it becomes a `delete` conflict.
- A push that would delete many elements (more than 20 and more than 25 % of that source's
  elements) is **held** for confirmation in the Live Bridge panel instead of applied.
- Every sync is one undo step; deleted elements come back with Undo.
- An element deleted in ArchAI is remembered (`removed`) and not re-created by the next sync.

### 2.5 Conversion fidelity

Each ref records how faithful the object in that app is: **native** (the app's own kind, editable
as such: a Revit wall in ArchAI as an ArchAI wall), **converted** (rebuilt as a different editable
kind: a Revit wall as a Blender mesh), **reference** (display only: the "ArchAI Live" layers),
**unsupported** (listed on the source, not built). `lossy` marks conversions that dropped data.
Pull tells each plugin the fidelity it may use; by default other apps receive **reference**
geometry until a user authorises editing for that app (then copies become `copy` refs whose
edits come back through the binding graph).

### 2.6 Protocol 2 (versioned, compatible with protocol 1)

```
GET  /live/status?key&app&name&project   → { protocol: 2, project: {id,name}, bound, revision, own, mismatch? }
GET  /live/projects                      → recent projects (local; online ones when signed in)
POST /live/bind   { key, app, name, project | newName }  → opens that project, registers the source
POST /live/push   { protocol: 2, key, app, name, project, changeId, complete, model, deleted? }
                  → { ack: changeId, revision, applied: { created, updated, unchanged, deleted,
                      held, conflicts, rejected, unsupported } }
GET  /live/pull?key&since                → glTF (as today); deltas in phase 3
```

- **Project binding**: a protocol-2 plugin sends the project it is bound to. If ArchAI shows
  another project, pushes are refused with `mismatch` (nothing lands in the wrong project); on the
  Home screen ArchAI opens the bound project.
- **Change ids and acks**: a push carries a `changeId`; re-sending the same change (a lost reply)
  returns the stored ack without applying it twice.
- **Revisions** persist across restarts (time-based), so a reconnecting plugin never mistakes a
  new session for "no change".
- **Loop prevention**: what a source sent is never sent back to it; each sync records its origin.

### 2.7 Visualisation and UI (phase 4)

Source colours, a source group per model (hierarchy kept), colour-by-source display mode,
*Convert to ArchAI element* (keeps the source as history), the Live Bridge panel (sources, status,
modes, authority, conflicts, held deletions, activity log), a Bridge section in element
properties, and the rename Live Link → Live Bridge.

## 3. Phases

| Phase | Content | Tested with |
|---|---|---|
| **1. Identity, project binding, sync engine** (ArchAI side) | `doc.bridge`; binding graph; facet hashes and authority; in-place updates; safe deletions; conflicts/held records; protocol 2 server (`bind`, `projects`, change ids, acks, persistent revisions, project mismatch); migration from `meta.liveLink`; protocol-1 plugins keep working | vitest: identity, ArchAI edits surviving, authority per facet, conflicts, partial/complete/held deletions, idempotent changes, two sources, migration, undo |
| **2. Two real apps, both ways** | Python core + Blender and C# core + AutoCAD on protocol 2: stable ids (Blender persistent UUID), project picker, change ids, `complete` flag, explicit deletions; editable copies (`copy` refs) | Blender headless + AutoCAD (accoreconsole) + the desktop app, scripted end to end |
| **3. Deltas** | `pull?since=` per-element deltas; plugins update their layer per element | same |
| **4. Live Bridge panel and visualisation** | §2.7 | vitest + browser |
| **5. Remaining plugins** | Rhino (full GUID), Revit, 3ds Max, Unreal, SketchUp on protocol 2; online-project conflict tests | builds; run where possible |

## 4. Decisions (from review)

| Decision | Choice |
|---|---|
| Default share mode | `shared`; other apps receive reference geometry unless authorised to edit |
| Default conflict rule | Owner wins, only for the facets it owns; unowned concurrent changes are conflicts |
| Online projects | Yes, with explicit conflict handling and tests for cloud revisions |
| Order | Identity, project binding and sync first; validate with two apps; then the rest |
