# Archai 0.3.0.8

Scene baking now shows a loading bar and the current preparation, lighting or packaging stage. WebXR preparation displays its measured percentage; Unreal stages use an animated bar until the worker finishes. Returning to a view restores progress for its saved bake job.

Unreal now fills the 3D workspace behind the floating Archai panels. Native window clipping preserves panel and toolbar input without shrinking the scene. Navigation uses drag to orbit, right-drag to pan and wheel zoom; the hand tool pans and pinned cameras remain fixed. Clicks select individual elements in Archai and in exported Unreal players.

The View inspector contains four output actions: Render image, Bake/Rebake scene, Export interactive and Export to VR. The Lighting tab and toolbar VR publishing button are removed. Lighting elements are edited through their normal Properties panel. Default views can publish raw VR links; Unreal views require current saved bake data.

Spotlights have draggable source/target endpoints and separate source/target elevations. Point lights have a point symbol. Area lights have a resizable area and a distinct symbol. Switching light types retains the element identity and position. Bake geometry preserves element IDs even when multiple elements share materials. Earlier baked VR data must be rebaked to use the new selection-preserving format.

Image export offers resolution presets, custom dimensions, quality, PNG/JPEG and Unreal exposure, sun and sky settings. Unreal exports use the native high-resolution screenshot path; default views use tiled rendering and supersampling. Interactive export can include the whole scene or chosen elements and creates a portable Windows / PC OpenXR player. Browser/Quest VR links use the separate optimized WebXR bake; they do not run Unreal inside the browser.

The installed bake worker normalizes script paths before passing them to Unreal, fixing escaped backslashes in paths such as `Program Files/ArchAI/resources`. First-time material/shader preparation is reported explicitly. This computer still needs its configured Unreal build worker for baking; recipients of exported players do not need Unreal Editor.

Returning to an earlier model or style uses a fresh Unreal import source, avoiding Interchange source-cache collisions. Native errors remain visible instead of being overwritten by an older ready report. Temporary status-file replacement gaps preserve the last authenticated camera and connection metadata.

Verification artifacts are stored under `F:/Archai-Releases/0.3.0.8/`. Native tests cover embedding, workspace bounds, UI exclusions, three light types, requested PNG dimensions, the VR bake gate, selected-element export and process cleanup. Physical pointer checks cover exported element selection, orbit and wheel zoom. The installed-path worker check covers Lightmass and cooked output. Device hardware and production publishing are outside these local checks.
