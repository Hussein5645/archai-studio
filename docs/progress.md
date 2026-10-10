# Progress bars

Long work shows its progress in ArchAI and in every plugin: exports, imports, opening and saving
files, VR links, online projects and the Live Bridge.

## ArchAI (web, desktop, Android)

`src/progress` keeps the running tasks; any command or service reports to it:

```ts
await withProgress('Exporting PDF', async (task) => {
  task.step(2, 5, 'Sheet 3 of 5');  // or task.update(detail, fraction 0..1 | null)
  await task.paint();               // let the card repaint before more synchronous work
});
```

- The **progress card** (`src/ui/ProgressCenter.tsx`, bottom right) shows each task's title, step
  and bar: filling when the amount of work is known, sweeping otherwise (animated with transforms,
  so it keeps moving while the main thread builds or parses). Tasks shorter than 350 ms never show.
- The **desktop app** also fills its taskbar button (`platform.window.setProgress`, IPC
  `archai:window:setProgress`, `BrowserWindow.setProgressBar`).
- Reported today: sheet exports (per sheet, then packing), Save and Save as (3D snapshot, writing),
  Open file (reading, checking, loading; Revit exports while building), Import 3D model, .CAI
  packages, VR links (building the model, then the upload byte by byte), Put online (upload) and
  opening an online project (download), and live-link syncs with the plugins.
- Uploads with progress use `uploadWithProgress` (XMLHttpRequest), downloads `readWithProgress`.

## Plugins

The plugin cores report progress as `(text, fraction or null)` callbacks:

| Core | Pieces |
|---|---|
| C# `Archai.Plugins.Core` | `ProgressReport`, `Progress.Range/Step/Megabytes`, `ProgressContent` (upload with progress), `LiveLink.SyncProgress` / `SyncFinished`, `VrShare.Publish(..., progress)` |
| Python `archai_core.py` | `step`, `scaled`, `megabytes`, `_send` (chunked upload), `DelayedProgress`, `LiveLink(progress=, finished=)`, `publish(..., progress)` |
| Ruby `core.rb` | `Core::Progress`, `Core.step`, `Core.scaled` |

Each host shows them in its own way:

| Host | Commands (Send, Open .AIR, Open in VR) | Live Bridge |
|---|---|---|
| Revit, AutoCAD | `ArchaiProgress` window (`plugins/dotnet/Shared.Windows`): status, percentage, filling or sweeping bar; on its own UI thread, so it moves while the host builds geometry | `LiveProgress`: the same window, only for syncs longer than a second |
| Rhino | status bar progress meter and command prompt (`RhinoProgress`) | `RhinoLiveProgress`, syncs longer than a second |
| Blender | cursor progress counter and status bar text (`Progress` in the add-on) | `DelayedProgress`, syncs longer than a second |
| 3ds Max | MAXScript progress bar and prompt line (`scene.Progress`) | `DelayedProgress` |
| Unreal | progress dialog (`ScopedSlowTask`, `scene.Progress`); imports already had one | `DelayedProgress` |
| SketchUp | status bar text with a `[#####-----] 45%` bar (`Core::Progress`): the Ruby API has no progress bar for extensions | status bar text with the percentage |

Commands report "object N of M" while reading or building, and the VR upload byte by byte. A
live-link sync reports: reading the host model, sending (bytes), ArchAI updating, ArchAI preparing
its model, receiving (bytes), building N objects.
