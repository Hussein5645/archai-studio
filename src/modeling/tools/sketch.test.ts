import { describe, expect, it } from 'vitest';
import type { SketchPlane, Vec2 } from '../kernel/types';
import { parseTypedDimensions, snapPoint } from '../snap';
import { createModelingStore } from '../store';
import { SketchTool, type ToolPointer } from './sketch';

const top: SketchPlane = { kind: 'plane', id: 'top', offset: 0 };

function pointer(point: Vec2, extra: Partial<ToolPointer> = {}): ToolPointer {
  return { plane: top, point, hit: { shape: null, body: null }, shift: false, alt: false, radius: 8, ...extra };
}

function setup(withSketch = true) {
  const store = createModelingStore();
  if (withSketch) store.getState().addSketch(top);
  const tool = new SketchTool(store);
  return { store, tool, state: () => store.getState() };
}

describe('snapPoint', () => {
  it('prefers shape points, then axis alignment with the anchor, then the grid', () => {
    const options = { grid: 10, snap: true, radius: 8, points: [[100, 100]] as Vec2[] };
    expect(snapPoint([104, 97], options)).toEqual({ point: [100, 100], kind: 'point' });
    expect(snapPoint([103, 250], { ...options, anchor: [100, 100] })).toEqual({ point: [100, 250], kind: 'align' });
    expect(snapPoint([333, 250], options)).toEqual({ point: [330, 250], kind: 'grid' });
    expect(snapPoint([333, 250], { ...options, grid: 0, snap: false })).toEqual({ point: [333, 250], kind: null });
  });

  it('locks the direction to 45 degree steps with Shift', () => {
    const { point } = snapPoint([100, 8], { grid: 10, snap: true, radius: 8, points: [], anchor: [0, 0], shift: true });
    expect(point[0]).toBeCloseTo(Math.hypot(100, 8), 6);
    expect(point[1]).toBeCloseTo(0, 6);
  });

  it('snaps to project element points with high priority', () => {
    const options = { grid: 10, snap: true, radius: 8, points: [] as Vec2[], projectPoints: [[50, 50]] as Vec2[] };
    expect(snapPoint([52, 49], options)).toEqual({ point: [50, 50], kind: 'point' });
  });

  it('parses typed dimensions', () => {
    expect(parseTypedDimensions('1200x800')).toEqual([1200, 800]);
    expect(parseTypedDimensions('300')).toEqual([300]);
    expect(parseTypedDimensions('-40, 20')).toEqual([-40, 20]);
    expect(parseTypedDimensions('abc')).toBeNull();
    expect(parseTypedDimensions('1 2 3')).toBeNull();
  });
});

describe('SketchTool', () => {
  it('keeps a live line preview and commits an open, snapping edge', () => {
    const { tool, state } = setup();
    state().setToolOptions({ chain: false });
    state().setTool('line');
    tool.pointerDown(pointer([3, 7]));
    tool.pointerMove(pointer([104, 96]));
    expect(state().sketchPreview?.shape).toMatchObject({ kind: 'polyline', points: [[0, 10], [100, 100]], closed: false });
    tool.pointerDown(pointer([104, 96]));
    expect(state().sketches[0]?.shapes[0]).toMatchObject({ kind: 'polyline', points: [[0, 10], [100, 100]], closed: false });
    expect(state().sketchPreview).toBeNull();
  });

  it('snaps sketch pointer to project elements and shows Project Element label', () => {
    const { tool, state } = setup();
    state().setTool('line');
    tool.pointerDown(pointer([0, 0]));
    tool.pointerMove(pointer([52, 49], {
      projectSnapPoints: [{ point: [50, 50], label: 'Project Element', type: 'body-vertex', screenDistance: 2, priority: 125 }],
    }));
    expect(state().sketchPreview?.inference?.label).toBe('Project Element');
    expect(state().sketchPreview?.snap).toEqual([50, 50]);
  });

  it('adds a knife segment to the picked sketch surface', () => {
    const { tool, state } = setup(false);
    const sketchId = state().addSketch(top);
    state().addShape(sketchId, { kind: 'rect', id: 'surface', x: 0, y: 0, width: 100, height: 100 });
    state().setTool('knife');
    tool.pointerDown(pointer([0, 50], { hit: { shape: { sketchId, shapeId: 'surface' }, body: null } }));
    tool.pointerMove(pointer([100, 50], { hit: { shape: { sketchId, shapeId: 'surface' }, body: null } }));
    tool.pointerDown(pointer([100, 50], { hit: { shape: { sketchId, shapeId: 'surface' }, body: null } }));
    expect(state().sketches[0]!.shapes[1]).toMatchObject({ kind: 'polyline', points: [[0, 50], [100, 50]], closed: false });
    expect(state().selection).toMatchObject({ kind: 'shape', sketchId });
  });

  it('draws and snaps on a face-derived work plane', () => {
    const { tool, state } = setup(false);
    const plane: SketchPlane = { kind: 'custom', origin: [25, 40, 60], normal: [0, 0, 1], xAxis: [1, 0, 0] };
    const viewBefore = state().panes[state().activePane];
    state().setWorkPlane(plane);
    expect(state().panes[state().activePane]).toBe(viewBefore);
    expect(state().selection?.kind).toBe('sketch');
    state().moveWorkPlane(25);
    expect(state().workPlane).toMatchObject({ kind: 'custom', origin: [25, 40, 85] });
    state().setTool('rect');
    const movedPlane = state().workPlane;
    const activeSketch = state().sketches.find((s) => s.id === (state().selection as { id: string }).id);
    expect(activeSketch?.plane).toEqual(movedPlane);
    tool.pointerDown(pointer([3, 7], { plane: movedPlane }));
    tool.pointerMove(pointer([104, 96], { plane: movedPlane }));
    tool.pointerUp(pointer([104, 96], { plane: movedPlane }));
    const updatedSketch = state().sketches.find((s) => s.id === activeSketch?.id);
    expect(updatedSketch?.shapes[0]).toMatchObject({ kind: 'rect', x: 0, y: 10, width: 100, height: 90 });
  });

  it('draws a rectangle into the explicitly selected sketch and selects the shape', () => {
    const { tool, state } = setup();
    state().setTool('rect');
    tool.pointerDown(pointer([103, 97]));
    tool.pointerMove(pointer([400, -200]));
    expect(state().sketchPreview?.shape).toMatchObject({ kind: 'rect', x: 100, y: 100, width: 300, height: -300 });
    tool.pointerUp(pointer([400, -200]));
    expect(state().sketches).toHaveLength(1);
    const sketch = state().sketches[0]!;
    expect(sketch.plane).toEqual(top);
    // Stored with positive sizes.
    expect(sketch.shapes[0]).toMatchObject({ kind: 'rect', x: 100, y: -200, width: 300, height: 300 });
    expect(state().selection).toEqual({ kind: 'shape', sketchId: sketch.id, shapeId: sketch.shapes[0]!.id });
    expect(state().sketchPreview).toBeNull();
    expect(state().past.length).toBeGreaterThan(0);
  });

  it('applies typed dimensions along the drag direction and drops zero-size shapes', () => {
    const { tool, state } = setup();
    state().setTool('rect');
    tool.pointerDown(pointer([0, 0]));
    tool.pointerMove(pointer([-50, 80]));
    for (const key of '1200x800') expect(tool.keyDown({ key })).toBe(true);
    expect(state().numericEntry).toBe('1200x800');
    tool.keyDown({ key: 'Enter' });
    expect(state().sketches[0]!.shapes[0]).toMatchObject({ kind: 'rect', x: -1200, y: 0, width: 1200, height: 800 });
    expect(state().numericEntry).toBe('');
    // A click without movement makes nothing.
    tool.pointerDown(pointer([500, 500]));
    tool.pointerUp(pointer([500, 500]));
    expect(state().sketches[0]!.shapes).toHaveLength(1);
  });

  it('keeps drawing into the selected sketch and starts a new sketch when none on the plane is selected', () => {
    const { tool, state } = setup();
    state().setTool('circle');
    tool.pointerDown(pointer([0, 0]));
    tool.pointerUp(pointer([50, 0]));
    state().setTool('circle');
    tool.pointerDown(pointer([200, 0]));
    tool.pointerUp(pointer([220, 0]));
    expect(state().sketches).toHaveLength(1);
    expect(state().sketches[0]!.shapes.map((shape) => shape.kind)).toEqual(['circle', 'circle']);
    // With nothing selected, drawing starts a fresh sketch; the one a body uses is left alone.
    const used = state().sketches[0]!.id;
    state().addBody({ id: 'b', name: 'B', visible: true, lowLod: false, material: 'oak', placement: { position: [0, 0, 0], rotation: [0, 0, 0] }, features: [{ kind: 'extrude', id: 'e', profile: used, distance: 10, op: 'new' }] });
    state().select(null);
    state().setTool('circle');
    tool.pointerDown(pointer([400, 0]));
    tool.pointerUp(pointer([420, 0]));
    expect(state().sketches).toHaveLength(2);
    expect(state().sketches.find((sketch) => sketch.id === used)?.shapes).toHaveLength(2);
    expect(state().sketches.at(-1)!.shapes).toHaveLength(1);
    // A different plane gets its own sketch rather than drawing into one on another plane.
    const front: SketchPlane = { kind: 'plane', id: 'front', offset: 300 };
    state().setTool('circle');
    tool.pointerDown(pointer([0, 0], { plane: front }));
    tool.pointerUp(pointer([30, 0], { plane: front }));
    expect(state().sketches).toHaveLength(3);
    expect(state().sketches.at(-1)!.plane).toEqual(front);
    expect(state().sketches.at(-1)!.shapes).toHaveLength(1);
  });

  it('draws rectangles by click-click as well as by dragging', () => {
    const { tool, state } = setup();
    state().setTool('rect');
    // Press and release in place: the first corner; the next press: the opposite corner.
    tool.pointerDown(pointer([0, 0]));
    tool.pointerUp(pointer([0, 0]));
    expect(state().sketches.flatMap((sketch) => sketch.shapes)).toHaveLength(0);
    tool.pointerDown(pointer([400, 300]));
    tool.pointerUp(pointer([400, 300]));
    const shapes = state().sketches.flatMap((sketch) => sketch.shapes);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.kind).toBe('rect');
    // Dragging still draws in one gesture.
    state().setTool('rect');
    tool.pointerDown(pointer([1000, 0]));
    tool.pointerUp(pointer([1200, 100]));
    expect(state().sketches.flatMap((sketch) => sketch.shapes)).toHaveLength(2);
  });

  it('builds a polyline from clicks, closes on the first point and cancels with Escape', () => {
    const { tool, state } = setup();
    state().setTool('polyline');
    for (const point of [[0, 0], [100, 0], [100, 100]] as Vec2[]) {
      tool.pointerDown(pointer(point));
      tool.pointerUp(pointer(point));
    }
    expect(state().sketchPreview?.shape).toMatchObject({ kind: 'polyline' });
    tool.pointerDown(pointer([3, -2]));
    expect(state().sketches[0]!.shapes[0]).toEqual({ kind: 'polyline', id: expect.any(String), points: [[0, 0], [100, 0], [100, 100]] });
    // Enter closes too; Escape drops the shape in progress.
    state().setTool('polyline');
    tool.pointerDown(pointer([300, 0]));
    tool.pointerDown(pointer([400, 0]));
    tool.pointerDown(pointer([400, 50]));
    tool.keyDown({ key: 'Enter' });
    expect(state().sketches[0]!.shapes).toHaveLength(2);
    state().setTool('polyline');
    tool.pointerDown(pointer([600, 0]));
    tool.pointerDown(pointer([700, 0]));
    tool.keyDown({ key: 'Escape' });
    expect(state().sketches[0]!.shapes).toHaveLength(2);
    expect(state().sketchPreview).toBeNull();
    // A typed length extends the segment along its direction.
    state().setTool('polyline');
    tool.pointerDown(pointer([0, 500]));
    tool.pointerMove(pointer([80, 500]));
    for (const key of '250') tool.keyDown({ key });
    tool.keyDown({ key: 'Enter' });
    // The preview repeats the new anchor until the pointer moves again.
    expect(state().sketchPreview?.shape).toMatchObject({ points: [[0, 500], [250, 500], [250, 500]] });
    tool.cancel();
  });

  it('selects and drags shapes with the select tool, recording one history entry', () => {
    const { tool, state } = setup();
    state().setTool('rect');
    tool.pointerDown(pointer([0, 0]));
    tool.pointerUp(pointer([100, 100]));
    const sketch = state().sketches[0]!;
    const shape = sketch.shapes[0]!;
    state().setTool('select');
    state().select(null);
    const past = state().past.length;
    tool.pointerDown(pointer([50, 50], { hit: { shape: { sketchId: sketch.id, shapeId: shape.id }, body: null } }));
    expect(state().selection).toEqual({ kind: 'shape', sketchId: sketch.id, shapeId: shape.id });
    tool.pointerMove(pointer([73, 50]));
    tool.pointerMove(pointer([94, 50]));
    expect(state().sketchPreview).toMatchObject({
      snap: [90, 50],
      inference: { label: 'Aligned', type: 'alignment', measurement: 'ΔX 40 mm  ΔY 0 mm' },
      guide: { from: [50, 50], to: [90, 50] },
    });
    tool.pointerUp(pointer([94, 50]));
    expect(state().sketches[0]!.shapes[0]).toMatchObject({ x: 40, y: 0 });
    expect(state().sketchPreview).toBeNull();
    expect(state().past.length).toBe(past + 1);
    state().undo();
    expect(state().sketches[0]!.shapes[0]).toMatchObject({ x: 0, y: 0 });
    // Clicking a body selects it; clicking nothing clears the selection.
    state().addPrimitive('box');
    const body = state().bodies[0]!;
    tool.pointerDown(pointer([0, 0], { hit: { shape: null, body: body.id } }));
    expect(state().selection).toEqual({ kind: 'body', id: body.id });
    tool.pointerDown(pointer([0, 0]));
    expect(state().selection).toBeNull();
  });

  it('draws arc segments, freehand strokes and offset copies', () => {
    const { tool, state } = setup();
    state().setTool('polyline');
    tool.pointerDown(pointer([0, 0]));
    // A toggles arc mode for the next segment; its through point comes from the next move + click.
    expect(tool.keyDown({ key: 'a' })).toBe(true);
    expect(state().toolOptions.arc).toBe(true);
    tool.pointerDown(pointer([100, 0]));
    tool.pointerMove(pointer([50, -50]));
    expect(state().sketchPreview?.shape).toMatchObject({ kind: 'polyline', bulges: [expect.closeTo(1, 6)] });
    tool.pointerDown(pointer([50, -50]));
    expect(state().toolOptions.arc).toBe(false);
    tool.pointerDown(pointer([100, 100]));
    tool.keyDown({ key: 'Enter' });
    expect(state().sketches[0]!.shapes[0]).toMatchObject({ kind: 'polyline', points: [[0, 0], [100, 0], [100, 100]], bulges: [expect.closeTo(1, 6), 0] });
    // Freehand: a stroke becomes a simplified closed outline.
    state().setTool('freehand');
    tool.pointerDown(pointer([300, 0]));
    for (let i = 1; i <= 30; i++) tool.pointerMove(pointer([300 + i * 5, i <= 15 ? i * 5 : (30 - i) * 5]));
    tool.pointerUp(pointer([450, 0]));
    const stroke = state().sketches[0]!.shapes[1]!;
    expect(stroke.kind).toBe('polyline');
    expect(stroke.kind === 'polyline' && stroke.points.length).toBe(3);
    // Offset: clicking a shape adds a copy with the option distance.
    state().setTool('offset');
    state().setToolOptions({ offset: -10 });
    tool.pointerDown(pointer([50, 20], { hit: { shape: { sketchId: state().sketches[0]!.id, shapeId: stroke.id }, body: null } }));
    expect(state().sketches[0]!.shapes).toHaveLength(3);
    expect(state().sketches[0]!.shapes[2]).toMatchObject({ kind: 'polyline', offset: -10 });
  });

  it('paints the body under the pointer', () => {
    const { tool, state } = setup();
    state().addPrimitive('box');
    const body = state().bodies[0]!;
    state().setTool('paint');
    state().setToolOptions({ paintMaterial: 'oak' });
    tool.pointerDown(pointer([0, 0], { hit: { shape: { sketchId: 'x', shapeId: 'y' }, body: body.id } }));
    expect(state().bodies[0]!.material).toBe('oak');
  });
});
