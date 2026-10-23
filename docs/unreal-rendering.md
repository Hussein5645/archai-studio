# Unreal rendering integration

## Product boundary

ArchAI owns modeling and editing. A separate render document owns visualization settings.
Unreal is a connected rendering layer. Publications freeze a model/render revision pair.
The intended delivery architecture is Unreal Pixel Streaming for high-fidelity screen viewing
and an optimized WebXR output for economical browser delivery and local headset tracking.

Release 0.3.0.1 implements the native workspace entry, interchange export, revisioned scene
link and developer import probe. It does not expose a simulated Unreal renderer.
Release 0.3.0.2 adds the compiled Windows companion and a revisioned local desktop handoff.
See [standalone preview verification and limits](release-0.3.0.2.md).
Release 0.3.0.3 makes Unreal the exclusive Render engine and introduces the local Lightmass
bake worker. See [the current workflow](render-studio.md) and [current verification](release-0.3.0.3.md).
Release 0.3.0.9 replaces the live viewport's full-scene handoff with a direct mesh bridge.
See [direct bridge verification and limits](release-0.3.0.9.md). Default rendering remains available per saved view.

## Scene package v1

`scenePackage.ts` creates three entries:

| Entry | Purpose |
|---|---|
| `manifest.json` | Project, source/render hashes, object IDs and parent IDs, materials, navigation, coordinate contract and limitations |
| `scene.glb` | Renderable surfaces, embedded textures, per-element `extras.archai.id` and `parentId` |
| `render.json` | Independent, versioned settings and camera; positions remain in source scene millimetres |

The GLB uses right-handed Y-up metres. Source Board +y corresponds to glTF +z.
Unreal positions in centimetres are `(100*x, 100*z, 100*y)` from glTF coordinates.
Importers must account for handedness and triangle winding when doing manual conversion;
Unreal Interchange already performs its own format conversion, so do not convert twice.

Source and visualization revisions use SHA-256 over deterministic JSON. Model bytes have
their own SHA-256 digest. Source changes cannot overwrite the captured visualization snapshot.
The manifest's material table retains source IDs; exact material-slot round trips through
Unreal still require a validated importer mapping. Objects that produce no surfaces can appear
in the organization manifest without corresponding mesh nodes. HDRI library IDs are references,
not embedded HDRI assets. Library authentication tokens are not exported.

The current export uses a complete GLB with textures capped at 4096 pixels. It is not a
content-addressed per-mesh asset stream or a headset optimization profile.

## Live scene protocol v1

The studio sends `{type: 'hello', sceneProtocol: 1}`. The Board replies with `render-scene`
and a snapshot frame. Subsequent frames contain per-table upserts/deletions and document
metadata/workspace. Each frame carries a connection stream ID, project ID and revision;
deltas additionally identify the required base revision. The receiver validates the resulting
document before committing it. A rejected delta requests another snapshot. Settings live
outside the streamed source document and are not overwritten by these updates.

This protocol serves the native preparation workspace over the existing IPC/tab channel.
For live views the desktop companion receives the `UnrealLiveInput` protocol: content-addressed
binary mesh sections and PNG textures, stable element/part IDs, world transforms, material
parameters and separate lighting/camera settings. The host validates assets, caches them within
the session and sends only node upserts/removals in an authenticated ticket with a required base
revision. Unreal builds runtime static meshes directly and retains unchanged actors/assets.
No GLB exporter, archive compressor or Interchange import runs for the live viewport. Shared
geometry remains individually selectable. Baking, baked previews and portable exports retain
their separate GLB-based output paths.
There is no claim of cloud job acknowledgments or durable network retry in this version.

Model changes preserve navigation. Explicitly sending a camera from a source view still moves
the render camera. Camera storage uses `render-camera:<project id>`; lighting continues using
`render:<project id>` for compatibility. Baking and export freeze their inputs while the latest
incoming model state waits to be applied afterward.

## Developer Unreal import probe

Use Node and a local Unreal installation:

```powershell
node scripts/unreal-prepare.mjs --engine 'F:\ur5.5\new\UE_5.8' --package '<scene.archai-scene.zip>' --output '<new project directory>'
```

The output directory must not exist. The tool validates allowed ZIP entries, expansion limits
and asset integrity before writing a dedicated project. It runs UnrealEditor-Cmd with the
Python preparation script. The script imports the GLB using Interchange, creates initial sun/sky
actors, saves the map and writes a report. The initial light mapping is an approximation; site
time/physical exposure, HDRIs and portable baked illumination are later work.
The default import check uses NullRHI and does not validate rendered appearance. Add `--render`
to enable commandlet rendering; initial shader compilation can take several minutes.

Missing platform SDK warnings for targets other than Windows are unrelated to the Windows
import probe. Any import or save failure remains a failed stage and must not be presented as a
ready publication. The tool never publishes or changes an existing project.

## Next implementation milestones

1. Validate imported identity, hierarchy, transforms, UVs, normals, material slots and textures on
   interior, glass-heavy and multi-floor projects. Establish a minimum supported Unreal version.
2. Extend the compiled companion's sample verification to large interiors and glass-heavy
   projects, multiple GPUs and a clean Windows machine without Unreal development tools.
   The local process lifecycle, session tokens and cooked runtime are implemented in 0.3.0.2.
3. Persist a complete render document, including independent material overrides and lights,
   through project storage/cloud. Define migration and conflict semantics.
4. Build separate Unreal cooking and portable WebXR preparation workers with immutable jobs,
   cancellation, retry, progress and asset caching.
5. Add publications, revision activation/rollback, scoped private-asset delivery and browser
   sessions using existing ArchAI identities. Deploy the interactive domain only with those
   access controls in place.
6. Integrate Pixel Streaming session allocation, TURN, quotas, cost telemetry and regional GPU
   capacity. Validate independent visitor navigation and fallback to the optimized viewer.
7. Validate desktop, touch and headset controls on actual supported devices. Treat streamed VR
   as experimental until latency and comfort measurements justify broader support.
