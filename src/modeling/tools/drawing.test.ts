import { describe, expect, it } from 'vitest';
import { shapeContour } from '../kernel/sketch';
import type { Shape2D, SketchPlane, Vec2 } from '../kernel/types';
import { carryJoined, dragGrip, gripAt, insertVertex, shapeGrips } from '../sketchEdit';
import { curveSnapCandidates } from '../snap';
import { createModelingStore, type ToolOptions } from '../store';
import { centerArcShape, SketchTool, tangentBulge, type ToolPointer } from './sketch';

const top: SketchPlane = { kind: 'plane', id: 'top', offset: 0 };
const line = (id: string, from: Vec2, to: Vec2): Shape2D => ({ kind: 'polyline', id, points: [from, to], closed: false });

describe('curve snaps', () => {
  it('offers midpoints, intersections, perpendicular feet, extensions and tangents', () => {
    const shapes: Shape2D[] = [line('a', [0, 0], [100, 0]), line('b', [50, -50], [50, 50]), { kind: 'circle', id: 'c', cx: 300, cy: 0, radius: 50 }];
    const types = (raw: Vec2, anchor: Vec2 | null = null) => curveSnapCandidates(shapes, raw, anchor, 5).filter((item) => item.screenDistance <= 5).map((item) => item.type);
    expect(types([50, 1])).toEqual(expect.arrayContaining(['midpoint', 'edge-intersection', 'point-on-edge']));
    expect(types([130, 1])).toContain('extension');
    expect(types([20, 1], [20, 40])).toContain('perpendicular');
    const tangent = curveSnapCandidates(shapes, [300, 50], [300, 200], 5).filter((item) => item.type === 'tangent');
    expect(tangent).toHaveLength(2);
    expect(Math.hypot(tangent[0]!.position[0] - 300, tangent[0]!.position[1])).toBeCloseTo(50, 6);
  });
});

describe('grips', () => {
  it('resizes a rectangle by corner and side, bows arcs and keeps joined ends together', () => {
    const rect: Shape2D = { kind: 'rect', id: 'r', x: 0, y: 0, width: 100, height: 50 };
    const corner = gripAt(rect, [100, 50], 5)!;
    expect(corner).toMatchObject({ kind: 'corner', index: 2 });
    expect(dragGrip(rect, corner, [150, 80])).toMatchObject({ x: 0, y: 0, width: 150, height: 80 });
    const side = shapeGrips(rect).find((grip) => grip.kind === 'side' && grip.index === 1)!;
    expect(dragGrip(rect, side, [130, 999])).toMatchObject({ width: 130, height: 50 });

    const chain = [line('a', [0, 0], [100, 0]), line('b', [100, 0], [100, 100])];
    const vertex = gripAt(chain[0]!, [100, 0], 5)!;
    const moved = dragGrip(chain[0]!, vertex, [120, 10]);
    const carried = carryJoined(chain, 'a', [{ from: [100, 0], to: [120, 10] }]);
    expect(moved.kind === 'polyline' && moved.points[1]).toEqual([120, 10]);
    expect(carried[1]!.kind === 'polyline' && carried[1]!.points[0]).toEqual([120, 10]);

    const segment = gripAt(line('s', [0, 0], [100, 0]), [50, 0], 5)!;
    expect(segment.kind).toBe('segment');
    const bowed = dragGrip(line('s', [0, 0], [100, 0]), { kind: 'bulge', index: 0, point: [50, 0] }, [50, -50]);
    expect(bowed.kind === 'polyline' && Math.abs(bowed.bulges![0]!)).toBeCloseTo(1, 6);
    expect(insertVertex(line('s', [0, 0], [100, 0]), [40, 2])).toMatchObject({ points: [[0, 0], [40, 0], [100, 0]] });
  });
});

describe('arcs', () => {
  it('continues a chain with a tangent arc and draws centre-ends arcs', () => {
    // After a segment heading +x, an arc from (100, 0) to (200, 100) leaves along +x: a quarter circle.
    expect(tangentBulge([[0, 0], [100, 0]], [0], [200, 100])).toBeCloseTo(Math.tan(Math.PI / 8), 6);
    expect(tangentBulge([[0, 0]], [], [10, 10])).toBe(0);
    const arc = centerArcShape([0, 0], [100, 0], Math.PI / 2);
    expect(arc.kind === 'polyline' && arc.points[1]![0]).toBeCloseTo(0, 6);
    expect(arc.kind === 'polyline' && arc.points[1]![1]).toBeCloseTo(100, 6);
    // The tessellated arc stays on the circle.
    for (const [x, y] of shapeContour(arc)) expect(Math.hypot(x, y)).toBeCloseTo(100, 4);

    const store = createModelingStore();
    store.getState().addSketch(top);
    store.getState().setToolOptions({ snap: false, grid: 0, arcMode: 'center' });
    store.getState().setTool('arc');
    const tool = new SketchTool(store);
    const at = (point: Vec2): ToolPointer => ({ plane: top, point, hit: { shape: null, body: null }, shift: false, alt: false, radius: 8 });
    tool.pointerDown(at([0, 0]));
    tool.pointerDown(at([100, 0]));
    tool.pointerMove(at([80, 60]));
    tool.pointerMove(at([0, 100]));
    tool.pointerDown(at([0, 100]));
    const drawn = store.getState().sketches[0]!.shapes[0]!;
    expect(drawn.kind === 'polyline' && drawn.bulges![0]).toBeCloseTo(Math.tan(Math.PI / 8), 6);
  });
});

describe('curved drawing tools', () => {
  const setup = (tool: 'circle' | 'arc' | 'ellipse' | 'spline', options: Partial<ToolOptions> = {}) => {
    const store = createModelingStore();
    store.getState().addSketch(top);
    store.getState().setToolOptions({ snap: false, grid: 0, ...options });
    store.getState().setTool(tool);
    const sketchTool = new SketchTool(store);
    const at = (point: Vec2): ToolPointer => ({ plane: top, point, hit: { shape: null, body: null }, shift: false, alt: false, radius: 8 });
    const shapes = () => store.getState().sketches.flatMap((sketch) => sketch.shapes);
    return { store, tool: sketchTool, at, shapes };
  };

  it('draws a circle through three points and one from a diameter', () => {
    const three = setup('circle', { circleMode: '3p' });
    for (const point of [[100, 0], [0, 100], [-100, 0]] as Vec2[]) three.tool.pointerDown(three.at(point));
    expect(three.shapes()[0]).toMatchObject({ kind: 'circle', radius: expect.closeTo(100, 6) });

    const two = setup('circle', { circleMode: '2p' });
    two.tool.pointerDown(two.at([0, 0]));
    two.tool.pointerUp(two.at([200, 0]));
    expect(two.shapes()[0]).toMatchObject({ kind: 'circle', cx: 100, cy: 0, radius: 100 });
  });

  it('draws an ellipse from its centre, an axis end and the other radius', () => {
    const { tool, at, shapes } = setup('ellipse');
    tool.pointerDown(at([0, 0]));
    tool.pointerDown(at([200, 0]));
    tool.pointerMove(at([30, 100]));
    tool.pointerDown(at([30, 100]));
    const ellipse = shapes()[0]!;
    expect(ellipse.kind === 'polyline' && ellipse.points).toEqual([[200, 0], [0, 100], [-200, 0], [0, -100]]);
    expect(ellipse.kind === 'polyline' && ellipse.handles).toHaveLength(4);
  });

  it('continues a curve end with a tangent arc', () => {
    const { store, tool, at, shapes } = setup('arc', { arcMode: 'tangent' });
    const sketchId = store.getState().sketches[0]!.id;
    store.getState().addShape(sketchId, line('base', [0, 0], [100, 0]));
    store.getState().select({ kind: 'sketch', id: sketchId });
    tool.pointerDown(at([100, 0]));
    tool.pointerMove(at([200, 100]));
    tool.pointerDown(at([200, 100]));
    const arc = shapes().find((shape) => shape.id !== 'base')!;
    expect(arc.kind === 'polyline' && arc.bulges![0]).toBeCloseTo(Math.tan(Math.PI / 8), 6);
  });

  it('draws pen curves: click for corners, drag for smooth points, Enter finishes', () => {
    const { tool, at, shapes } = setup('spline');
    tool.pointerDown(at([0, 0]));
    tool.pointerUp(at([0, 0]));
    // Press at (100, 0) and drag out a handle to (150, 0): a smooth point.
    tool.pointerDown(at([100, 0]));
    tool.pointerMove(at([150, 0]));
    tool.pointerUp(at([150, 0]));
    tool.pointerDown(at([200, 100]));
    tool.pointerUp(at([200, 100]));
    tool.keyDown({ key: 'Enter' });
    const pen = shapes()[0]!;
    expect(pen).toMatchObject({ kind: 'polyline', closed: false, points: [[0, 0], [100, 0], [200, 100]] });
    expect(pen.kind === 'polyline' && pen.handles).toEqual([[[0, 0], [50, 0]], [[150, 0], [200, 100]]]);
  });
});
