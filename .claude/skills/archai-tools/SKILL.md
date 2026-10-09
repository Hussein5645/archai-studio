---
name: archai-tools
description: How to drive the ArchAI web app programmatically instead of clicking through its UI — discovering commands, dispatching them, reading state, undo/redo, and safety notes. Use whenever an agent needs to operate the running ArchAI web app (localhost or deployed) to create, edit, or inspect an architectural project.
---

# Operating ArchAI (web)

ArchAI is a command-driven 2D architectural workboard. Every action the UI can take — every
button, shortcut, and menu item — goes through one command bus. On the **web build**, that bus is
exposed on `window.__archai` for exactly this purpose (it also backs the app's own e2e tests, so
it is a stable, intentional surface, not an accident of the build).

This skill covers the *mechanics* of driving ArchAI. For architectural design judgment (what to
actually build, spatial planning, sequencing a design), use the `archai-architect` skill on top of
this one.

## Prerequisites

You need a way to run JavaScript in the ArchAI page (a browser automation tool with a JS-eval
action, or an MCP browser tool). There is no separate server or API endpoint for this yet — you
must be driving the actual open tab.

Confirm the bridge is present before doing anything else:

```js
if (!window.__archai) throw new Error('window.__archai not found — is this the ArchAI web app?');
window.__archai.platform.kind; // 'web' (also exists as 'electron'/'native' on those builds, untested there)
```

## 1. Discover commands — always, every session

Never assume you remember the command list from a previous session; it changes as the app
evolves. Call `describe()` first and treat its output as the live, authoritative tool catalog:

```js
const commands = window.__archai.executor.describe();
// commands: Array<{
//   id: string;              // e.g. 'create-wall-segments'
//   label: string;           // human label, e.g. 'Create wall segments'
//   description?: string;    // one-line explanation
//   group: string;           // 'create' | 'edit' | 'transform' | 'arrange' | 'select' |
//                             // 'view' | 'history' | 'document' | 'shell'
//   kind: 'mutation' | 'effect';
//   available: boolean;      // true if it can run against the CURRENT state right now
//   palette: boolean;        // whether it's exposed in the human command palette (irrelevant to you)
//   aliases: string[];
//   shortcuts: string[];
//   inputSchema: object;     // JSON Schema (draft 2020-12) for the input, incl. defaults/enums
// }>
```

Filter to `available: true` before trying a command — many commands require a selection or a
specific screen (`ui.screen === 'project'`) and will otherwise fail predictably. Read
`inputSchema` for each command you intend to call; it carries `required`, `default`, `minimum`,
`enum`, patterns (e.g. hex colors), etc. — don't guess field names or units. **Coordinates and
sizes are in millimetres** unless a schema says otherwise.

## 2. Read current state

```js
const state = window.__archai.store.getState();
// state.ui.screen: 'home' | 'project' | ...
// state.doc: the whole document — .meta.name, .elements (keyed by id), .levels, ...
// state.ui.selection: string[] of selected element ids
// state.history.past / .future: undo/redo stacks

// Or the convenience read used by commands' `when` guards:
const ctx = window.__archai.executor.read();
// { state, doc, ui, selection, hasSelection, canUndo, canRedo }
```

Use this to confirm you're on the right screen/document before acting, and to verify effects
after acting (don't just trust that a dispatch "should have" worked — re-read state).

## 3. Dispatch a command

```js
const result = await window.__archai.executor.dispatch(commandId, input);
```

Always check `result.ok`:

```js
// success:
{ ok: true, commandId, value, patches, changedIds, historyEntryId }
// failure (never throws — always check ok):
{ ok: false, commandId, error: { code, message, details } }
```

`error.code` is one of `unknown-command | invalid-input | unavailable | rejected | cancelled |
failed`. Input is zod-validated server-side, so a malformed payload comes back as
`invalid-input` with details rather than corrupting state.

Two kinds of command:
- **`mutation`** — synchronous document edit, undoable (grouped into one history entry unless the
  command opts out). Safe to try; you can always undo.
- **`effect`** — async, may touch the platform (file dialogs, clipboard, network). On the web
  build there's no native file system, so file-picker-shaped effects (open/save dialogs) either
  won't behave usefully for a headless agent or need a different path — check `available` and
  prefer the direct mutation form of an action when one exists (e.g. `new-document` instead of the
  UI's `prompt-new-document` flow).

You do not need to enter the project screen manually via UI — dispatch `set-screen` with
`{ screen: 'project' }` (or open/create a document, which does this for you) before dispatching
element-creation commands.

## 4. Undo / redo

```js
await window.__archai.executor.dispatch('undo');
await window.__archai.executor.dispatch('redo');
```

Every mutation with `history: 'record'` (the default) is a clean undo step. This makes
exploration safe: try something, inspect the result via `store.getState()`, undo it if it's wrong.

## Worked example (verified live)

```js
const a = window.__archai;
await a.executor.dispatch('set-screen', { screen: 'project' });
const r = await a.executor.dispatch('create-rect', {
  x: 0, y: 0, width: 3000, height: 2000, name: 'Example',
});
r.ok; // true — r.value is the new element id
Object.keys(a.store.getState().doc.elements).length; // 1
await a.executor.dispatch('undo');
Object.keys(a.store.getState().doc.elements).length; // 0
```

## Gotchas (learned editing Meridian Tower)

- **Levels share plan coordinates.** Every level's walls sit at the same XY; filter by
  `meta.levelConstraint.levelId` for anything per-floor. New walls/doors/rooms/stairs don't get a
  level automatically — follow creation with `set-element-level-link { id, levelId, offset: 0 }`.
- **`delete-selection` needs a selection** even when you pass `ids`: dispatch `select`
  `{ ids, mode: 'replace' }` first or it returns `unavailable`.
- **Doors/windows don't auto-host** when made with `create-arch-element`. Set
  `meta.arch.opening = { wallId, segment, start, end }` (mm along the wall from its start) via
  `set-property` (`key: 'meta'` replaces the whole meta — send the full object). The element's
  `x,y` is the opening's start point.
- **Rooms only re-derive when walls or room names change**, not when a room is moved. To re-seat a
  room: `set-transform` it so its polygon *centroid* sits inside the target space, then make any
  boundary change (e.g. create and delete a throwaway wall far off-plan).
- **Room faces can't have holes.** A room that surrounds another enclosure (a roof deck around a
  penthouse) needs a `room-divider` (`create-arch-element`, `tool: 'room-divider'`) to become a
  simple polygon.
- **Walls must meet on centrelines** to enclose rooms; ends stopping short of another wall leave a
  real gap and no room face.
- `move-line-endpoint` with `followJoined: true` drags every wall listed in `joints`, which may
  include walls on other levels — prefer `followJoined: false`.

## Safety notes

- Treat `window.__archai` as internal API surface: no semver guarantees, but it is intentionally
  maintained (used by the app's own tests), so it will not disappear without notice.
- Prefer many small dispatches you can verify and undo individually over one large blind sequence.
- Don't dispatch commands whose `label`/`description` suggest destructive, irreversible, or
  account-wide effects (e.g. anything that deletes a whole project/document, not just an element)
  without the user's explicit go-ahead — the same rule that applies to UI actions applies here.
- This bridge is currently **web-only** in practice; it also exists on Electron/native builds but
  hasn't been exercised there yet — verify before relying on it in those hosts.
