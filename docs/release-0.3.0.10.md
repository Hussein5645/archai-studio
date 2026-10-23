# Archai 0.3.0.10

Live Unreal lighting now uses a balanced physical camera, a daylight environment, restrained bloom and corrected live-mesh face winding. The previous winding conversion could turn outward-facing surfaces inward, causing black faces and glowing highlights. View controls include Daylight, Soft daylight and Interior presets, plus exposure, sun strength, sky brightness and bloom. These settings stay with the view. Exposure and bloom adjustments do not invalidate a saved scene bake. Native baked output uses its own paired sun/sky and exposure calibration.

Interactive export offers a portable folder or a published WebXR link. The dialog records the renderer and style active when it opens, shows whether a current bake exists, and lets users choose real-time or available saved baked lighting. Changed source settings require reopening the dialog. Whole scenes and selected elements are supported.

Default folders contain a self-contained local browser player with desktop and PC WebXR entry points. Unreal folders contain the Unreal runtime with desktop and Windows OpenXR launchers; saved Lightmass exports reuse the cooked scene. No Unreal Editor installation is required for visitors. Selected baked exports retain the original lighting context and preserve current exposure, bloom and camera settings.

Published links use the existing authenticated publishing service and an optimized WebXR model. They run on the visitor's device and approximate Unreal real-time lighting; they do not run the Windows Unreal executable or stream Unreal from a GPU server. Baking is optional for these links. Native-only bakes cannot supply browser baked lighting. Public and private link access continues to use the existing service controls.

Native Unreal baking starts independently of preparing the browser derivative. Browser geometry or memory limits no longer cancel the Unreal Lightmass job. The arbitrary one-million-triangle browser rejection is removed, browser preparation uses adaptive sampling and memory checks, and failures report separately while the native bake continues. Large scenes still need sufficient RAM and headset-friendly geometry. Old bake signatures require rebaking to use the corrected lighting calibration.

Verification includes targeted unit/browser tests, native Unreal rendering and selected export, a 200-column geometry-reuse check, an installed-path Lightmass bake and cooked player, and portable folder launch. Production uploads and physical headset behavior are not exercised by automated checks.
