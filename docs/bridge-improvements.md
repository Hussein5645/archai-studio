# Bridge performance and geometry control improvements

14 October 2026. Changes are implemented in this workspace. App bundles and several plugin binaries were built; installed app/plugin copies and published downloads were not replaced.

## Performance results

Measured with the same synthetic one-triangle mesh fixtures and command executor as the original audit. The final diagnostic ran without other build/test processes alongside it, after a 25-object warmup. One sample per size; these are diagnostic comparisons, not end-to-end source-software timings or capacity guarantees.

| Operation | Before | After |
|---|---:|---:|
| Initial import, 250 objects | 204 ms | 138 ms |
| Initial import, 1,000 objects | 1,512 ms | 476 ms |
| Initial import, 2,500 objects | 10,365 ms | 1,162 ms |
| Ownership check of 2,500 objects | 1,746 ms | 5.23 ms |
| One-object partial update in a 2,500-object model | 167 ms | 126 ms |
| Fresh pull planning, 2,500 objects | 41 ms | 25 ms |

The 2,500-object initial import is approximately **8.9 times faster**, with about 89% less elapsed command time. Ownership checks use a shared child lookup and immutable-leaf facet hashes. Initial creation uses a scoped ordering-index allocator rather than rebuilding the index on every insertion. Ordering and undo/redo are regression-tested.

Dense plan extraction now runs in a dedicated worker, one blob at a time. Its geometric calculation still takes time; the improvement is that it no longer runs on the interactive board's UI thread. The browser test verifies plans arrive from the worker. Synchronous sheet/export rendering retains its synchronous calculation path.

Outbound scene export selects requested output roots before constructing their 3D geometry and prepares their subtrees. Geometry builders retain the full document for host, opening, level and material context. A regression test checks selective wall output keeps its opening geometry. Mesh decoding is limited to four active jobs and concurrent consumers wait for existing jobs instead of treating pending models as ready.

Retired and rejected imported mesh blobs are collected when no document element, definition, bridge snapshot or conflict references them. This prevents repeated geometry replacement from continually growing the saved document. Undo restores collected bytes, and shared blob references are retained; both are tested.

## More consistent controls

The Live Bridge panel exposes **Send and receive**, **Send only**, **Receive only** and **Paused**. Status advertises the source's mode to the shared Python, .NET and Ruby plugin cores. Updated plugins avoid export/upload while paused or receiving only, retain pending source edits, and continue receiving when appropriate. Older plugins still require updating to gain this behavior.

The geometry inspector offers three selection-wide presets:

- **Source controls all:** geometry, placement, materials and names belong to the source app.
- **Place in ArchAI:** geometry and materials stay controlled by the source; ArchAI controls position and names.
- **Shared control:** concurrent changes to a part use the existing conflict-resolution workflow.

Individual part controls also work on multiple selected elements and show mixed ownership. Selecting a bridge source's model group expands the inspector's controls to its bridged descendants. Conversion to ArchAI elements and editable-copy rules remain available.

World placement is now part of outbound node identity. Moving a source group updates the geometry sent to other apps. When ArchAI owns placement, permitted moves also reach the source objects, and successive group moves receive distinct update tokens rather than being skipped as already applied.

**Sync now** requests a source refresh as well as resending ArchAI's shared geometry. Updated plugin cores consume the request during normal status polling. It remains disabled for paused sources. This does not bypass a plugin's local pause or the source's receive-only mode.

## Plugin delivery logic

Shared Python code covers Blender, 3ds Max and Unreal; shared .NET code covers Revit, AutoCAD and Rhino; SketchUp's Ruby core follows the same behavior.

- Partial protocol-2 pushes send only mesh versions different from the last acknowledged export. Material/level context participates in change detection. Host extraction may still inspect the full scene; this reduces transmitted and applied geometry, not every host's extraction cost.
- Hidden objects remain known. Explicit source deletion detection uses all source ids before delta filtering, so filtering an unchanged or hidden object does not turn it into a deletion.
- Unacknowledged payloads are retained and retried with their original change id, rather than exporting a different payload under a new transaction after a lost reply. Newer host edits remain queued behind the pending payload. Mesh fingerprints are committed only after an acknowledgement.
- Changing project bindings discards pending geometry from the old binding. Both push and pull paths check project identity. A project switch during export aborts that pull.
- Pull replies carry the revision of the exported snapshot, so an edit made while export is running remains visible as a newer revision on the next poll.
- The server's renderer response budget is 170 seconds; current Python, .NET and Ruby transfer requests allow 180 seconds. This gives the server time to report a failure before the client's transfer timeout. It does not cancel renderer work on timeout.

## Validation

| Check | Result |
|---|---|
| Application tests | **620 passed**, 93 files |
| Type checks, web build, Electron source build | Passed |
| Lint of changed app, diagnostic and browser-test files | Passed |
| Browser integration check | Passed: worker plans, source-group selection, bulk control, direction and pause |
| Python plugin core | 7 passed, including acknowledgement retry and pause/receive-only behavior |
| .NET plugin core | 7 passed, including acknowledged mesh deltas and dependency invalidation |
| Blender 4.2 add-on export/import | Passed in an isolated headless profile |
| AutoCAD 2026 plugin build | Passed; two assembly-reference warnings |
| Rhino 8 plugin build | Passed |
| Revit 2024, 2025, 2026 plugin builds | Passed using community-packaged API references |
| Revit 2027 plugin build | Not validated: this environment has .NET SDK 9, while the project targets .NET 10 |
| SketchUp Ruby bridge | Syntax checked with Ruby 3.3 WASM; not run inside SketchUp |

No full large-file live transfer was run inside every source application. 3ds Max and Unreal host runtime behavior is covered only by their shared core changes and core tests. Existing build warnings about bundle size and ineffective dynamic imports remain.

## Remaining limits

The HTTP transport still carries a monolithic JSON/base64 request. Very large individual transfers can still incur full-buffer memory pressure and string-size limits; transaction-aware binary batching remains future work. Source collection in several plugins still runs on the host thread. Decoded mesh and plan caches do not yet have a comprehensive eviction policy. These changes improve the measured bottlenecks and bridge correctness but do not establish unlimited model capacity.

Use the updated app and matching plugin builds together for testing. Start with a copy of a representative large source model, record object and triangle counts, then check initial sync, a one-object change, source-group movement, pause/resume, reconnect, save/reopen and memory during repeated replacements.

Raw data: `bridge-performance-baseline.json` and `bridge-performance-results.json`. Reproduce the diagnostic with:

```powershell
npx vitest run --config scripts/bridge-performance.config.ts
```

The command replaces the post-fix result file. Screenshot from the browser control check: `test-results/bridge-controls.png`.
