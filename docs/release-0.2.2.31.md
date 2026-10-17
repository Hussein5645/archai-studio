# ArchAI 0.2.2.31

- Draw sun, wind and noise analysis origins as rectangles with mouse, pen or touch. Analysis display follows each view’s style: hidden line, wireframe, colors, shaded or realistic.
- Access View, Properties and Board Inspector tabs inside an open view. Use Edit board to add, draw and modify project content beside the live view, with shared selection and undo.
- Copy images from the board into other apps, paste screenshots/images onto the board, drag image files onto it, and save the original image through the context menu.
- Normal Copy keeps editable ArchAI element data alongside the image representation. Browser, Windows, Android and iOS use their respective clipboard APIs; tablet image saving uses the native file picker.
- Show the app version in the board header and Home screen.
- Improve large-project picking, panning, project loading and staged 3D opening. Background geometry work keeps the previous model visible while preparing updates and cancels stale work.
- Respect pinned perspective cameras, improve toolbar spacing, add local autosave controls and clickable save status, and retain automatic saving/sync for online projects.
- Resolve all Live Bridge conflicts with one action and one undo step.
- Recover context generation with proper service identification, a bounded backup map service and cached downloads.

Windows and Android contain the same web bundle as the hosted web app. The Android APK is a development-signed sideload build. The iOS package is unsigned and requires Apple signing before device installation; updated iOS source is included in this release.
