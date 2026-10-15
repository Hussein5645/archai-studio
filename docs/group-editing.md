# Editing groups

Double-click a group on the board, in Layers, or in the 3D workspace to edit its contents. Single clicks now select members individually. Double-click a nested group to enter it one level deeper.

The **Editing group** bar shows the path from the board or sheet to the active group. Click an ancestor in that path to return to it, **Exit group** or **Esc** to go up one level, or **Board / Sheet** to leave all group levels. Double-clicking empty space also exits one level.

While editing a group:

- Layers shows only the active group's contents. Nested groups can still be expanded, reordered and entered. Double-click a group to enter it; press **F2** on a layer row to rename it.
- Outside objects fade in the 2D board and cannot be selected by clicks, box selection or Select all. The board border and breadcrumbs indicate the editing context.
- 3D clicks select the original member of a group, with its own highlight and transform handle. The same group context follows between 2D and 3D.
- Drawing and pasting go into the active group. World placement is preserved for rotated groups. Member edits remain ordinary undo steps; entering and leaving groups do not add document undo steps.
- Locked or hidden groups cannot be entered. Removing, hiding or locking the active group clears the context. Opening another document or sheet clears it too.

This applies to ArchAI document groups. An imported model stored as one mesh element still needs separate elements from its source app to expose independent members.
