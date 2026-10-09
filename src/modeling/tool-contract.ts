/** Common lifecycle implemented incrementally by every canvas modeling tool. */
export interface ModelingTool<Pointer = unknown, Preview = unknown> {
  readonly id: string;
  readonly active: boolean;
  activate(): void;
  hover(pointer: Pointer): void;
  pointerDown(pointer: Pointer): void;
  pointerMove(pointer: Pointer): void;
  pointerUp(pointer: Pointer): void;
  keyDown(event: KeyboardEvent | { key: string }): boolean;
  preview(): Preview | null;
  commit(): boolean;
  cancel(): void;
  cleanup(): void;
}

/** Owns cancellation while changing tools, preventing unfinished previews from leaking. */
export class ModelingToolController<T extends ModelingTool> {
  private current: T | null = null;

  activate(tool: T): void {
    if (this.current === tool) return;
    this.current?.cancel();
    this.current?.cleanup();
    this.current = tool;
    tool.activate();
  }

  cancelStep(): void {
    this.current?.cancel();
  }

  dispose(): void {
    this.current?.cancel();
    this.current?.cleanup();
    this.current = null;
  }
}
