import { describe, expect, it } from 'vitest';
import type { Shape2D, SketchPlane, Vec2 } from '../kernel/types';
import { createModelingStore } from '../store';
import { SketchTool, type ToolPointer } from './sketch';

const top: SketchPlane = { kind: 'plane', id: 'top', offset: 0 };

function setup(shapes: Shape2D[] = []) {
  const store = createModelingStore();
  const sketchId = store.getState().addSketch(top);
  store.getState().setSketchShapes({ [sketchId]: shapes });
  store.getState().setToolOptions({ snap: false, grid: 0 });
  const tool = new SketchTool(store);
  const state = () => store.getState();
  const shapesNow = () => state().sketches.find((sketch) => sketch.id === sketchId)!.shapes;
  const at = (point: Vec2, shapeId?: string, extra: Partial<ToolPointer> = {}): ToolPointer => ({ plane: top, point, hit: { shape: shapeId ? { sketchId, shapeId } : null, body: null }, shift: false, alt: false, radius: 8, ...extra });
  return { store, tool, state, sketchId, shapesNow, at };
}

const line = (id: string, from: Vec2, to: Vec2): Shape2D => ({ kind: 'polyline', id, points: [from, to], closed: false });

describe('sketch edit mode', () => {
  it('draws into the edited sketch, keeps the tool, and folds every change into one undo step', () => {
    const { tool, state, sketchId, shapesNow, at } = setup([line('a', [0, 0], [100, 0])]);
    const pastBefore = state().past.length;
    state().enterSketchEdit(sketchId);
    state().setTool('line');
    // Chain: three clicks give two connected lines and the tool stays active.
    tool.pointerDown(at([0, 100]));
    tool.pointerDown(at([100, 100]));
    tool.pointerDown(at([100, 200]));
    expect(shapesNow()).toHaveLength(3);
    expect(state().tool).toBe('line');
    tool.keyDown({ key: 'Escape' });
    // Undo inside the session stops at its start.
    state().undo();
    expect(shapesNow()).toHaveLength(2);
    state().undo();
    state().undo();
    state().undo();
    expect(shapesNow()).toHaveLength(1);
    state().redo();
    state().redo();
    state().finishSketchEdit();
    expect(state().sketchEdit).toBeNull();
    expect(state().past.length).toBe(pastBefore + 1);
    expect(shapesNow()).toHaveLength(3);
    state().undo();
    expect(shapesNow()).toHaveLength(1);
  });

  it('cancel restores the sketch as it was', () => {
    const { tool, state, sketchId, shapesNow, at } = setup([line('a', [0, 0], [100, 0])]);
    const pastBefore = state().past.length;
    state().enterSketchEdit(sketchId);
    state().setTool('rect');
    tool.pointerDown(at([0, 0]));
    tool.pointerMove(at([50, 50]));
    tool.pointerUp(at([50, 50]));
    expect(shapesNow()).toHaveLength(2);
    state().cancelSketchEdit();
    expect(shapesNow()).toHaveLength(1);
    expect(state().past.length).toBe(pastBefore);
  });

  it('rounds chain joints with the draw radius', () => {
    const { tool, state, shapesNow, at } = setup();
    state().setToolOptions({ drawRadius: 20 });
    state().setTool('line');
    tool.pointerDown(at([0, 0]));
    tool.pointerDown(at([100, 0]));
    tool.pointerDown(at([100, 100]));
    const shapes = shapesNow();
    expect(shapes).toHaveLength(3);
    const arc = shapes.find((shape) => shape.kind === 'polyline' && shape.bulges?.[0]);
    expect(arc).toBeDefined();
  });
});

describe('modify tools', () => {
  it('moves the selected curves by base and target points, or a typed distance', () => {
    const { tool, state, sketchId, shapesNow, at } = setup([line('a', [0, 0], [100, 0])]);
    state().select({ kind: 'shape', sketchId, shapeId: 'a' });
    state().setTool('smove');
    tool.pointerDown(at([0, 0]));
    tool.pointerMove(at([10, 10]));
    expect(state().sketchPreview?.shapes).toHaveLength(1);
    tool.pointerDown(at([0, 50]));
    expect(shapesNow()[0]).toMatchObject({ id: 'a', points: [[0, 50], [100, 50]] });
    state().setTool('smove');
    tool.pointerDown(at([0, 0]));
    tool.pointerMove(at([10, 0]));
    for (const key of '25') tool.keyDown({ key });
    tool.keyDown({ key: 'Enter' });
    expect(shapesNow()[0]).toMatchObject({ points: [[25, 50], [125, 50]] });
  });

  it('copies as an array, picks the curve first when nothing is selected, and rotates / mirrors / scales', () => {
    const { tool, state, sketchId, shapesNow, at } = setup([line('a', [0, 0], [100, 0])]);
    state().setTool('scopy');
    state().setToolOptions({ modify: { ...state().toolOptions.modify, copies: 3 } });
    tool.pointerDown(at([50, 0], 'a'));
    expect(state().selection).toMatchObject({ kind: 'shape', shapeId: 'a' });
    tool.pointerDown(at([0, 0]));
    tool.pointerDown(at([0, 10]));
    expect(shapesNow()).toHaveLength(4);
    expect(shapesNow()[3]).toMatchObject({ points: [[0, 30], [100, 30]] });

    state().select({ kind: 'shape', sketchId, shapeId: 'a' });
    state().setTool('srotate');
    tool.pointerDown(at([0, 0]));
    tool.pointerDown(at([10, 0]));
    tool.pointerDown(at([0, 10]));
    const rotated = shapesNow().find((shape) => shape.id === 'a')!;
    expect(rotated.kind === 'polyline' && rotated.points[1]![0]).toBeCloseTo(0, 6);
    expect(rotated.kind === 'polyline' && rotated.points[1]![1]).toBeCloseTo(100, 6);

    state().select({ kind: 'shape', sketchId, shapeId: 'a' });
    state().setTool('smirror');
    tool.pointerDown(at([-10, 0]));
    tool.pointerDown(at([-10, 10]));
    // Mirror copies by default: the original stays.
    expect(shapesNow()).toHaveLength(5);
    expect(shapesNow()[4]).toMatchObject({ points: [[-20, 0], [-20, 100]] });

    state().select({ kind: 'shape', sketchId, shapeId: 'a' });
    state().setTool('sscale');
    tool.pointerDown(at([0, 0]));
    tool.keyDown({ key: '2' });
    tool.keyDown({ key: 'Enter' });
    const scaled = shapesNow().find((shape) => shape.id === 'a')!;
    expect(scaled.kind === 'polyline' && scaled.points[1]![1]).toBeCloseTo(200, 6);
  });

  it('trims two lines to their corner, deletes a piece, splits, extends and fillets', () => {
    const { tool, state, shapesNow, at } = setup([line('a', [0, 0], [120, 0]), line('b', [100, -20], [100, 80])]);
    state().setTool('trim');
    tool.pointerDown(at([10, 0], 'a'));
    tool.pointerDown(at([100, 50], 'b'));
    expect(shapesNow().map((shape) => shape.kind === 'polyline' && shape.points)).toEqual([[[0, 0], [100, 0]], [[100, 0], [100, 80]]]);

    state().setTool('fillet');
    state().setToolOptions({ modify: { ...state().toolOptions.modify, filletSize: 10 } });
    tool.pointerDown(at([99, 1], 'a'));
    expect(shapesNow()).toHaveLength(1);
    const rounded = shapesNow()[0]!;
    expect(rounded.kind === 'polyline' && rounded.bulges?.some((bulge) => bulge)).toBe(true);

    const second = setup([line('a', [0, 0], [100, 0]), line('c1', [30, -10], [30, 10]), line('c2', [70, -10], [70, 10]), line('wall', [200, -50], [200, 50])]);
    second.state().setTool('trim');
    second.state().setToolOptions({ modify: { ...second.state().toolOptions.modify, trimMode: 'segment' } });
    second.tool.pointerDown(second.at([50, 0], 'a'));
    expect(second.shapesNow().filter((shape) => shape.id !== 'c1' && shape.id !== 'c2' && shape.id !== 'wall')).toHaveLength(2);

    second.state().setTool('split');
    second.tool.pointerDown(second.at([0, 0], 'c1'));
    second.state().setTool('extend');
    second.tool.pointerDown(second.at([200, 0], 'wall'));
    const tail = second.shapesNow().find((shape) => shape.kind === 'polyline' && shape.points[1]?.[0] === 100)!;
    second.tool.pointerDown(second.at([90, 0], tail.id));
    expect(second.shapesNow().find((shape) => shape.id === tail.id)).toMatchObject({ points: [[70, 0], [200, 0]] });
  });
});
