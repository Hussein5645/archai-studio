# Large-document and Live Bridge performance audit

This is the original pre-fix audit. See [implemented improvements and current validation](bridge-improvements.md). Original measurements are preserved in `bridge-performance-baseline.json`; `bridge-performance-results.json` now contains the post-fix run.

Date: 14 October 2026 (Asia/Baghdad). Version: ArchAI 0.2.2.19.

**Status: large-model performance needs improvement.** The current implementation has reproducible costs that grow much faster than object count during initial import, interface-thread stalls for dense mesh plan generation, and full-scene work during incremental outbound sync. These can plausibly explain difficult large-file connections. This audit does not prove which stage failed in the user's particular file.

## Scope and evidence

Reviewed the Electron transport, exchange validation and import, bridge engine and ownership guard, pull planning and 3D export, mesh decoding and plan drawing, document persistence, and plugin export paths. No live project was modified. No bridge listener was found on the default local port during the audit, so there was no live connection or end-to-end source-application timing.

Measured synthetic valid GLBs through the real command executor, validation, Immer mutation, patches and undo. Development-only invariant checks were disabled. Hardware: Intel i5-12400F, 12 logical processors, 31.8 GiB RAM; Node 24.21.0. Each object-count case uses unique one-triangle GLBs. Dense-mesh cases use unindexed, disconnected triangles and represent a demanding edge-generation case rather than a typical building's topology.

The benchmark ran twice, with consistent initial-import scaling. The table and saved JSON use the second run, which ran without the correctness tests alongside it. Each run has one timing sample per case following a 25-object warmup; these are diagnostic measurements, not percentiles or performance guarantees. They exclude host export, HTTP, Electron IPC, asynchronous guard scheduling, GPU rendering, disk I/O and complete GLB export. The guard column measures checking every bound element separately; it is not included in the import timing. Heap snapshots in the JSON are neither peak memory nor isolated per-case memory.

## Measured results

| Mesh objects | Initial command | Unchanged full snapshot | One-object partial update | Guard check of all objects | Fresh pull planning | Working-copy serialization |
|---:|---:|---:|---:|---:|---:|---:|
| 250 | 204 ms | 17 ms | 20 ms | 18 ms | 6 ms | 2 ms |
| 1,000 | 1,512 ms | 53 ms | 73 ms | 172 ms | 15 ms | 5 ms |
| 2,500 | 10,365 ms | 118 ms | 167 ms | 1,746 ms | 41 ms | 14 ms |

The 2,500-object input was only 1,562,285 bytes (1.49 MiB). Increasing object count tenfold from 250 to 2,500 increased initial command time approximately 51-fold. Object count itself is therefore a substantial problem even before large geometry payloads are considered. A partial update becomes slower as the existing source grows, despite sending just one object.

| Triangles in one mesh | Binary GLB size | Plan calculation |
|---:|---:|---:|
| 10,000 | 0.34 MiB | 41 ms |
| 100,000 | 3.43 MiB | 261 ms |
| 500,000 | 17.17 MiB | 1,619 ms |

All three cases returned the 30,000-edge-segment limit. That limit did not bound computation time.

## Findings and priorities

### 1. High: initial creation repeatedly scans and sorts the element table

`src/revit/importRevit.ts:266` creates a rect for each imported mesh. `src/commands/builtin/create.ts:45` obtains an ordering index via `topIndex`; `src/commands/helpers.ts:61` calls `lastIndexAmong`. In `src/document/query.ts:26`, drafts cannot use the cached child index, so the full child index is rebuilt and siblings sorted for each insertion. This repeated work is a strong explanation for the measured superlinear initial import time. It has not been individually isolated with a CPU profiler.

Recommended fix: maintain a batch-local last index per parent during import and allocate subsequent indices directly, preserving ordering and existing undo semantics.

### 2. High: the ownership guard rebuilds child lookup per touched element

`src/bridge/guard.ts:44` calls `needsRevert` for touched ids; `needsRevert` at line 25 constructs `childLookup(doc.elements)` every time. A batch touching N bridge elements repeats document scanning/sorting N times. The isolated all-object check reached 1.75 seconds at 2,500 objects. Guard work is scheduled after the command, so command-only timing misses this additional potential interface stall.

Recommended fix: build the lookup once per guard batch, share it across checks, and track affected descendants when parent geometry changes.

### 3. High: incremental pulls still build the whole 3D scene

`src/live/board.ts:287` plans changed nodes, but `src/view3d/vrExport.ts:20–23` prepares assets and calls `buildScene` for the whole document. The inclusion filter at line 58 runs afterward. Small outbound changes can therefore still incur full-scene preparation and construction. Measured pull-planning times in the table do not include this expensive scene/export stage.

Recommended fix: construct only requested nodes plus required dependency context, preserving hosted openings and source-group world transforms. Handle metadata-only or empty-node deltas without constructing full scene geometry.

### 4. High: dense plan calculation blocks the interface thread

`src/render/meshPlan.ts:254` schedules work with `setTimeout`, not a worker. Its 24 ms budget is checked only after a complete blob calculation. `glbTriangles` expands geometry; `planOfTriangles` builds the entire feature-edge map before limiting returned segments at line 191. A single large blob can exceed the budget substantially; the measured 500,000-triangle case took 1.62 seconds.

Recommended fix: move plan extraction to a worker, use transferable binary buffers, support cancellation, and provide a temporary bounding-box plan until ready. Bound intermediate memory as well as returned segment count.

### 5. High: large requests require multiple full representations and face mismatched limits

`electron/liveLink.ts:35` allows 768 MiB bodies. At lines 67–78 it buffers chunks and concatenates them; line 115 converts the whole body into a string and parses JSON; line 61 sends the parsed model through Electron IPC. Plugins encode geometry as base64, adding approximately one third to binary size before JSON overhead. Python also materializes the complete JSON and encoded request (`plugins/python/archai_core.py:1230`). Writing network chunks is not incremental document processing.

The renderer reply timeout is 120 seconds (`electron/liveLink.ts:36`), while Python and .NET clients allow 180 seconds. There is no renderer cancellation attached to expiry in `ask`, so a server timeout may occur while renderer work continues. This makes a timeout an ambiguous completion signal.

The local Node runtime's maximum string length is 536,870,888 characters, approximately 512 Mi characters. An ASCII JSON/base64 payload may therefore fail during string conversion below the nominal 768 MiB request limit. The packaged Electron runtime was not running and its exact string limit was not measured. The Python core's separate 95 MiB limit applies to its cloud-model upload path, not the Live Bridge request path.

Recommended fix: use bounded binary/object batches with an explicit transaction id, acknowledgements, progress and cancellation. If batching is introduced, intermediate batches must be partial; declaring each batch a complete snapshot could delete objects from earlier batches. Align limits and timeouts across the server and clients; increasing timeouts alone will not fix scaling.

### 6. Medium: partial pushes still hash the entire bound source

`src/bridge/engine.ts:197–203` hashes every bound element before sync. The later state-reconciliation loop at line 400 hashes existing bound elements again. Even unchanged snapshots take those paths before the no-change exit at line 470. That explains why a one-object partial update remains dependent on source size.

Recommended fix: cache facet hashes against immutable element identity and dependency revisions, and reconcile only touched elements plus affected dependencies. Preserve authority, conflicts and deletion checks.

### 7. Medium: decoding has no concurrency cap and caches have no eviction

`src/view3d/meshes.ts:46–68` starts parsing every uncached mesh and awaits all jobs. Its decoded model and failed-id caches, and the plan cache in `src/render/meshPlan.ts:224`, have no visible eviction or project-reset policy in these classes. Repeated geometry replacements create new blob ids, so retained geometry can accumulate during a session. This is a code-level memory risk; retained GPU/process memory was not measured.

Recommended fix: bound decoding concurrency, wait for existing in-flight parses when needed, and implement document-aware cache eviction with appropriate geometry/material disposal.

## What already works

- Stable identity and unchanged-item skipping avoid rebuilding every item during repeat pushes.
- Protocol 2 supports partial snapshots, explicit deletion and changes-only output.
- Working copies save blob data separately and skip rewriting unchanged blobs (`src/persistence/workingCopy.ts`). Small-object metadata serialization was comparatively inexpensive in this benchmark.
- Revit tracks changed elements after the first export (`revit/Archai.Revit/Live.cs:182`). Blender's live exporter collects the scene again (`plugins/blender/archai/__init__.py:497`); Rhino and AutoCAD similarly call full scene collection from their export delegates. A partial snapshot flag alone does not mean only changed geometry was exported.
- Existing bridge, working-copy and Revit importer tests: **37 passed in 3 files**. The opt-in performance diagnostic also passed on both runs.

## Practical status and next steps

Small-model correctness is covered by the executed tests. Initial imports with thousands of individual meshes are slow in measured command processing. Dense individual meshes can stall plan generation. Very large transfers and multiple connected apps remain unverified end to end and carry additional code-level risks.

For current projects, use the plugin's visibility/selection controls where supported to send needed geometry in smaller groups, reduce unnecessary tessellation, and pause automatic sync during bulk edits. Keep source keys and object ids stable. After an ambiguous timeout, inspect the Bridge activity and applied counts before restarting a full transfer. Splitting object count helps creation; reducing triangles helps individual-mesh drawing; both matter.

Fix ordering-index reuse and shared guard lookup first, then worker-based plan generation and selective scene export. Follow with bounded transfer/decode and cache lifecycle work. Add timings for host export, bytes sent, server parse, IPC, command apply, plan calculation, scene build and first usable frame so connection failures can be distinguished from slow model processing.

For acceptance testing, use a representative source file with known object/triangle counts and test 1,000 / 5,000 / 10,000 objects, a one-object update, reconnect, cancellation, two simultaneous sources, save/reopen and memory after repeated geometry replacements. These sizes are proposed test cases, not proven capacity limits. Record median and tail latency, peak memory and interface responsiveness.

## Reproduce

```powershell
npm ci --ignore-scripts
npx vitest run --config scripts/bridge-performance.config.ts
npx vitest run src/bridge/bridge.test.ts src/persistence/workingCopy.test.ts src/revit/importRevit.test.ts
```

Raw results: `docs/bridge-performance-results.json`. Diagnostic: `scripts/bridge-performance.audit.ts` and `scripts/bridge-performance.config.ts`. Running the diagnostic replaces the results JSON. Only audit artifacts were added; production behavior was not changed.
