---
name: archai-live-bridge
description: How an agent or script sends 3D geometry into a running ArchAI desktop app and reads ArchAI's model back, over the Live Bridge (the same loopback HTTP protocol the Revit, Rhino, Blender, AutoCAD, SketchUp, 3ds Max and Unreal plugins use). Use when generated or computed geometry (massing studies, meshes from another tool, script output) should appear in an ArchAI project and stay in sync, or when an agent needs ArchAI's model as glTF — without driving the UI.
---

# ArchAI Live Bridge for agents

The ArchAI **desktop app** (Electron) runs an HTTP server on `127.0.0.1:47821` (env
`ARCHAI_LIVE_PORT` overrides). An agent can join it as one more "app": its objects become mesh
elements in the open project, in their own source group and colour, and later pushes update them
element by element (one undo step each). Full reference: `docs/live-bridge.md`; server:
`electron/liveLink.ts`, `src/live/board.ts`.

Use this skill for **geometry in/out**. To create native ArchAI elements (walls, rooms, stairs,
levels, sheets) use `archai-tools` (the command bus); for design judgment use `archai-architect`.

## The client: `archai_bridge.py`

Next to this file. Python 3, standard library only; it imports the plugins' own core
(`plugins/python/archai_core.py`; set `ARCHAI_CORE` to its folder if the script is moved). Every
command prints JSON.

```bash
python archai_bridge.py status   --key my-study --name "Massing study" --app Agent
python archai_bridge.py push     --key my-study --name "Massing study" --app Agent --spec objects.json
python archai_bridge.py push     --key my-study ... --spec changed.json --partial [--delete id1,id2]
python archai_bridge.py pull     --key my-study ... --out archai.glb [--fresh]
python archai_bridge.py projects
```

(On this Windows machine there may be no `python` on PATH; Blender's bundled interpreter works:
`"C:/Program Files/Blender Foundation/Blender 4.2/4.2/python/bin/python.exe" -I archai_bridge.py ...`.)

### Push spec (`objects.json`)

```json
{ "objects": [
  { "id": "core",   "name": "Core",   "category": "Massing", "color": "#c0504d", "box": [0, 0, 0, 6000, 4000, 12000] },
  { "id": "podium", "name": "Podium", "category": "Massing", "color": "#4f81bd", "box": [-4000, -3000, 0, 14000, 10000, 4000] },
  { "id": "roof",   "name": "Roof",   "positions": [0,0,12000, 6000,0,12000, 6000,4000,12000], "indices": [0,2,1] }
] }
```

- **Units and axes: millimetres; x right, plan y DOWN, z = elevation up.** A point from a Z-up
  right-handed tool (x, y, z) in metres is `(x*1000, -y*1000, z*1000)`.
- `box` = `[x, y, z, width, depth, height]` (min corner + size). `positions`/`indices` = a flat
  triangle mesh, wound like a Z-up tool's outward faces after that y flip (the box helper shows it).
- **`id` is the identity.** Keep ids stable across pushes: the same id updates its element, a new
  id creates one. Ids are yours (max 64 chars), scoped to your `--key`.
- `--key` names your model (one source in ArchAI, one source group on the board). Reuse it to keep
  syncing the same model; a new key makes a new source.

### Push semantics (what the reply's `applied` counts mean)

- **Full push** (default, `complete: true`): your whole model. Objects you no longer send are
  **deleted** from ArchAI (unless that deletion is held: >20 and >25% of your model waits for the
  user to confirm in the Live Bridge panel, or the element was edited in ArchAI / linked to other
  apps, which makes it a conflict).
- **`--partial`**: only the objects given are created/updated; nothing is deleted except ids listed
  in `--delete`. Prefer this for incremental edits.
- Unchanged objects are skipped (`unchanged`); a push that changes nothing changes nothing.
- Each push has a `changeId`; resending the same one returns the stored answer (safe retry).
- Reply `{ refused, message }`: e.g. `project-mismatch` — ArchAI shows another project than the
  one your key is linked to. Tell the user; don't fight it.

### Pull

`pull` writes binary glTF (metres, y up) of what ArchAI shares with you: other apps' and ArchAI's
elements, never your own objects back. Node `extras.archai = { id, hash, source, color, editable?,
ref? }`; the summary prints the root `archaiBridge = { present, updates, document, revision }`
(`updates` = moves/renames ArchAI made to *your* objects). Without `--fresh` only changes since
your last pull come; 204/`{"changed": false}` means nothing new.

## Workflow

1. **Is ArchAI running?** `status`. Connection refused → the desktop app isn't open (the web app has
   no Live Bridge). Ask the user to start it; don't launch installers yourself.
2. **Which project?** `status` returns `document {id, name}`. If ArchAI is on its Home screen, the
   first `status` makes it open (or create) a project named after `--name`; call `status` again
   after a few seconds. The client links your key to the shown project on first push.
3. **Push**, read `applied`, and verify (`created`/`updated` match what you sent; `held`,
   `conflicts`, `rejected` > 0 need the user's attention in the Live Bridge panel).
4. Iterate with `--partial` pushes under the same key and ids.

## Rules ArchAI enforces (don't try to work around them)

- Geometry from an app (including yours) is **owned by that app**: if the user edits your element
  in ArchAI it is put back on the next change, and other apps only get it as reference geometry.
  The user releases it with *Convert to ArchAI element*; after that your pushes no longer touch it.
- Elements deleted in ArchAI are not brought back by later pushes.
- Every push is one undo step in ArchAI.

## Safety

- Only push into the project the user intends; check `document.name` from `status` first and say
  which project you are writing to.
- Use a distinctive `--key`/`--name` (e.g. `agent-massing`) so your source is obvious in the
  panel and can be removed there (Forget source).
- Full pushes delete what you omit — when unsure, use `--partial`.
- The server only accepts loopback requests with header `X-ArchAI-Live: 1` and no `Origin`; it is
  not reachable from web pages, and `/live/account` (the user's sign-in token) is not for agents.

## Raw protocol (if not using Python)

```
GET  /live/status?key&app&name&protocol=2&project      -> { protocol, document, bound, mismatch?, revision, own }
POST /live/bind   { key, app, name, project }            -> { document, revision }
POST /live/push   { protocol: 2, key, app, name, project, changeId, complete, deleted: [], model }
                                                         -> { ack, revision, applied: {...} } | { refused, message }
GET  /live/pull?key&protocol=2&project[&fresh=1]         -> model/gltf-binary (X-ArchAI-Revision) or 204
```

`model` is the exchange format (`src/revit/exchange.ts`): `{ archaiRevit: 1, app, name,
meshes: [{ id, name, category, level: null, origin: [x, y, z], size: [w, d, h], glb }] }` where
`glb` is base64 binary glTF with vertices in mm as (x, elevation, plan y) relative to `origin`
(see `write_exchange` in `archai_core.py`).
