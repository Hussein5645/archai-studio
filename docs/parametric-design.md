# Parametric node design

**Start graph** enables live updates. Use the controls on the component or origin in Layers, in the Inspector, or in the full-screen editor. **Stop graph** keeps the last result and pauses evaluation; starting again catches up with current inputs. The board preview shows running, stopped, or error state. **Run once** remains available for a single evaluation, including Copy result mode.

Running graphs react to document edits and drag previews even when the editor is closed. Derived changes share the input edit's undo entry. Invalid results stop the graph with an error and preserve its last valid result. Live mode updates existing elements; copies are created only by a single run.

Nested Layers elements appear automatically as graph references, including elements beneath the graph origin and hosted doors/windows. Component contents can be selected and moved directly on the board. An element's location output can drive a different parameter on that same element—for example, a wall's Y location can drive its exposed instance height. Driving the same field that supplies the input is rejected as feedback.

Use the parametric board tool and **drag a rectangle** to create the graph origin at the size you want. It stays on the board after drawing. Drag its body to move it, or use its edge/corner handles to resize it independently of the component's elements. New origins are unpinned; origins saved by older versions may need their pin turned off in Layers first.

Alternatively, select existing elements and choose **Create parametric component from selection** in the board's right-click menu. The component is a folder in Layers; dragging elements into it adds instance references without moving their world positions. Its **Graph origin** is a live graph preview on the board. Double-click it (or its Layers entry) to open the full-screen graph. **Back to board** restores the same board view.

Right-click anywhere on the graph and search for **Variable**, **Calculation**, or an available reference. New nodes appear at the point you clicked, including after panning and zooming. The library also provides add buttons.

Calculation nodes support addition, subtraction, multiplication, division, minimum, maximum, and powers. Set A and B directly, or drag a variable, instance parameter output, or another calculation output onto their sockets. You can also click a variable/calculation output and then an input to connect them. Click a connected input without an active source to disconnect it.

For example, connect a panel's width output to A of a Multiply node, set B to 2, then pass its result into an Add node with B set to the desired gap. Connect the final result to another instance's Location X input.

**Diamond execution pins** define Start → instance steps → Finish. **Round data pins** carry parameter values. Drag between matching pins in either direction, or click an output and then an input. A pin accepts one incoming wire; reconnecting replaces it. Click a connected input with no active source, or double-click a wire, to disconnect it. **Auto-wire execution** restores the default instance sequence. Existing graphs retain their execution-list order until you edit the pins.

**Run** (Ctrl/⌘ + Enter) applies the graph to instances as one undoable operation. Each step applies its configuration and parameters before the next step reads its outputs, including through calculation chains. Wire source instances before their dependents. Every reference must lie on the execution chain. **Copy result** applies the same rules to copies. Incomplete execution, division by zero, nonfinite results, cycles, missing references, and backwards data dependencies are rejected without partial changes.

Calculation previews use current instance outputs; staged edits to a source element become available when Run executes that element. Type-controlled parameters remain read-only outputs until exposed for instance editing in the type panel.

Use **Arrange nodes** to separate inputs, calculations, instances, and output. **Fit** shows the graph in the available canvas, and the zoom controls let you work at a comfortable size. Wires follow socket positions when nodes move, the view zooms, or parameter lists scroll; sockets outside a scrolled list are represented at its edge.

Navigation matches the board: wheel or trackpad to pan, Shift + wheel to pan horizontally, Ctrl/⌘ + wheel to zoom around the pointer, and middle-drag or Space + drag to pan. H selects the hand tool; V returns to selection. Drag a node header to move it, use arrows to nudge (Shift for larger steps), Delete to remove a reference/node, and Ctrl/⌘ + Z to undo. Removing a reference node keeps its board element. Escape cancels wiring or dismisses the node menu before returning to the board.


**Parametric .CAI assets** (modeled with parameters, see modeling.md) expose their editable parameters as instance sockets (`cai:<name>`); exposed derived parameters are outputs only. **Points** (board tool `P`, next to Line and Rectangle) are small reference elements drawn at a fixed screen size in 2D and 3D; their Location X / Y (their centre) and Elevation are sockets like any element's, and they can be moved in 3D with the gizmo, including in height. For example, put a panel asset and a point in a component, wire the point's Location X into the panel's `cai:width` input (through a Calculation if needed), and start the graph: dragging the point resizes the panel.
