# ArchAI 0.3.0.1 — Render integration preview

This is the first implementation milestone of the Unreal rendering architecture. It is a
preview of the interchange and synchronization foundations, not a complete Unreal/XR release.

## Available

- Render opens from the Board's main top bar, independently of an open 3D viewport.
- The existing native modeling, preparation, baking and public VR-link workflows remain available.
- The separate workspace is named ArchAI Render. It identifies the active preview as native and
  explicitly reports that the Unreal runtime and cloud streaming are not connected.
- Scene updates negotiate protocol 1: an initial document snapshot followed by revisioned
  element, material, definition and embedded-resource changes. Missing revisions request a new
  snapshot. Older studios still receive the original complete-document messages.
- Lighting settings remain separate from model edits. Model changes preserve the current
  render camera. Valid camera settings restore per project after reopening the workspace.
- Export scene package produces a `.archai-scene.zip` with a textured GLB, identity and
  organization manifest, render settings, camera, navigation stops and SHA-256 integrity hashes.
- Packaging runs in a bundled worker compatible with the existing content security policy.
- A developer preparation tool validates the package and imports it into a newly created Unreal
  project through Interchange. It never replaces an existing Unreal project.

## Limitations

The scene ZIP is portable interchange, not cooked Unreal content. The Unreal preparation tool
uses editor tooling on the developer/build machine; it is not the customer-facing runtime.
Packaged-runtime loading, full actor identity round trips during live updates, exact lighting/material conversion,
HDRI resolution, legacy entourage conversion, and XR rendering still require validation.
Lighting and camera persistence remain local to this installation, consistent with the existing
preparation workflow. They are not yet synced through cloud projects or embedded into AIR.

Pixel Streaming sessions, the interactive website, private publication permissions, GPU billing
and native Unreal XR delivery are not implemented in this preview. Existing VR links retain
their existing public access behavior. No cloud resources or domain settings are deployed here.

## Validation

The release tests cover protocol recovery and project isolation, package contents and hashes,
camera parsing, actual top-bar opening, GLB object identity, export/download, live model updates
and restoration after reload. Existing VR preparation tests cover the retained bake pipeline.

The developer Unreal import reports its own success or failure in `preparation-report.json`;
an import success does not establish runtime, lighting or headset compatibility.

Verified locally with Unreal 5.8.1: a two-object scene imports and saves, with both mesh actors
bound back to their source object IDs. The production build, all 754 unit tests, the Render
export/live-update/reload browser test, and packaged desktop smoke test pass. The existing bake
locking/cancellation browser test passed. The full legacy panorama regression timed out during
the long browser shader workload; a graphics-backend retry lost its WebGL context, so that check
is not a release pass. Photorealistic Unreal rendering has not been validated by the NullRHI
import probe. This preview should not be promoted as the completed rendering release.

See [Unreal rendering integration](unreal-rendering.md) for the protocol and next milestones.
