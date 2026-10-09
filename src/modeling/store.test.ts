import { describe, expect, it } from 'vitest';
import { createModelingStore, selectedSketchId } from './store';
import { identityPlacement, type Body } from './kernel/types';

describe('modeling store enhancements', () => {
  it('renames features within a body', () => {
    const store = createModelingStore();
    const body: Body = {
      id: 'body-1',
      name: 'Base Solid',
      visible: true,
      lowLod: false,
      material: 'wood',
      placement: identityPlacement(),
      features: [
        { kind: 'primitive', id: 'f-1', shape: 'box', size: [100, 100, 100], placement: identityPlacement() },
      ],
    };
    store.getState().addBody(body);
    expect(store.getState().bodies[0]?.features[0]?.name).toBeUndefined();

    store.getState().renameFeature('body-1', 'f-1', 'Main Cube');
    expect(store.getState().bodies[0]?.features[0]?.name).toBe('Main Cube');
  });

  it('moves sketch loop and translates dependent bodies', () => {
    const store = createModelingStore();
    const sketchId = store.getState().addSketch({ kind: 'plane', id: 'top', offset: 0 });
    store.getState().addShape(sketchId, { kind: 'rect', id: 'r-1', x: 0, y: 0, width: 50, height: 50 });
    const body: Body = {
      id: 'body-1',
      name: 'Extruded Body',
      visible: true,
      lowLod: false,
      material: 'metal',
      placement: identityPlacement(),
      features: [
        { kind: 'extrude', id: 'ext-1', profile: sketchId, distance: 100, op: 'new' },
      ],
    };
    store.getState().addBody(body);

    store.getState().moveSketchLoop(sketchId, ['r-1'], 20, 30);

    const updatedSketch = store.getState().sketches.find((s) => s.id === sketchId);
    const shape = updatedSketch?.shapes[0];
    expect(shape?.kind).toBe('rect');
    if (shape?.kind === 'rect') {
      expect(shape.x).toBe(20);
      expect(shape.y).toBe(30);
    }

    const updatedBody = store.getState().bodies.find((b) => b.id === 'body-1');
    expect(updatedBody).toBeDefined();
    // On top plane (X, -Z, Y), moving dx=20, dy=30 shifts in world space
    expect(updatedBody!.placement.position[0]).not.toBe(0);
  });

  it('stores one persistent direct-edit feature for a vertex gizmo drag', () => {
    const store = createModelingStore();
    store.getState().addBody({
      id: 'body-edit', name: 'Editable', visible: true, lowLod: false, material: 'metal', placement: identityPlacement(),
      features: [{ kind: 'primitive', id: 'base', shape: 'box', size: [100, 100, 100], placement: identityPlacement() }],
    });
    store.getState().select({ kind: 'vertex', bodyId: 'body-edit', vertexIndex: 0, point: [-50, 0, -50] });
    store.getState().moveVertex('body-edit', 0, [0, 10, 0], true);
    store.getState().moveVertex('body-edit', 0, [0, 5, 0], true);
    const edit = store.getState().bodies[0]!.features.at(-1)!;
    expect(edit).toMatchObject({ kind: 'direct-edit', name: 'Move vertex', delta: [0, 15, 0] });
    expect(store.getState().bodies[0]!.features).toHaveLength(2);
  });

  it('transforms whole curves and individual points for gizmo edits', () => {
    const store = createModelingStore();
    const sketchId = store.getState().addSketch({ kind: 'plane', id: 'top', offset: 0 });
    store.getState().addShape(sketchId, { kind: 'polyline', id: 'curve', points: [[0, 0], [100, 0], [100, 50]], closed: false });
    store.getState().transformCurve(sketchId, 'curve', { translate: [10, 20] }, true);
    store.getState().transformCurve(sketchId, 'curve', { rotate: 90 }, true);
    store.getState().transformCurve(sketchId, 'curve', { scale: [2, 1] }, true);
    store.getState().moveCurvePoint(sketchId, 'curve', 0, [5, 6], true);
    const shape = store.getState().sketches.find((sketch) => sketch.id === sketchId)?.shapes[0];
    expect(shape?.kind).toBe('polyline');
    if (shape?.kind === 'polyline') {
      expect(shape.points[0]).toEqual([5, 6]);
      expect(shape.points[1]).not.toEqual([110, 20]);
    }
  });

  it('adds and toggles selections across Layers and viewport interactions', () => {
    const store = createModelingStore();
    store.getState().select({ kind: 'body', id: 'body-a' });
    store.getState().select({ kind: 'body', id: 'body-b' }, true);
    expect(store.getState().selectionSet).toEqual([
      { kind: 'body', id: 'body-a' },
      { kind: 'body', id: 'body-b' },
    ]);
    expect(store.getState().selection).toEqual({ kind: 'body', id: 'body-b' });
    store.getState().select({ kind: 'body', id: 'body-a' }, true);
    expect(store.getState().selectionSet).toEqual([{ kind: 'body', id: 'body-b' }]);
    store.getState().selectMany([{ kind: 'sketch', id: 'sketch-a' }, { kind: 'body', id: 'body-c' }]);
    expect(store.getState().selectionSet).toHaveLength(2);
  });

  it('moves every curve when the sketch parent is transformed', () => {
    const store = createModelingStore();
    const sketchId = store.getState().addSketch({ kind: 'plane', id: 'top', offset: 0 });
    store.getState().addShape(sketchId, { kind: 'polyline', id: 'a', points: [[0, 0], [10, 0]], closed: false });
    store.getState().addShape(sketchId, { kind: 'circle', id: 'b', cx: 20, cy: 30, radius: 5 });
    store.getState().transformSketchShapes(sketchId, ['a', 'b'], { translate: [5, -10] }, true);
    const shapes = store.getState().sketches[0]!.shapes;
    expect(shapes[0]).toMatchObject({ points: [[5, -10], [15, -10]] });
    expect(shapes[1]).toMatchObject({ cx: 25, cy: 20 });
  });

  it('identifies sketchId when loop is selected', () => {
    expect(selectedSketchId({ kind: 'loop', sketchId: 'sk-99', loopIndex: 0, shapeIds: ['sh-1'] })).toBe('sk-99');
    expect(selectedSketchId({ kind: 'sketch', id: 'sk-42' })).toBe('sk-42');
    expect(selectedSketchId({ kind: 'shape', sketchId: 'sk-12', shapeId: 'sh-3' })).toBe('sk-12');
    expect(selectedSketchId({ kind: 'curve-point', sketchId: 'sk-12', shapeId: 'sh-3', pointIndex: 1 })).toBe('sk-12');
  });

  it('switches work plane to sketch work plane when sketch or its elements are selected', () => {
    const store = createModelingStore();
    const planeA = { kind: 'plane' as const, id: 'top' as const, offset: 0 };
    const planeB = { kind: 'plane' as const, id: 'front' as const, offset: 250 };
    const planeC = { kind: 'plane' as const, id: 'side' as const, offset: 500 };

    const sketchA = store.getState().addSketch(planeA);
    const sketchB = store.getState().addSketch(planeB);
    const sketchC = store.getState().addSketch(planeC);

    store.getState().addShape(sketchB, { kind: 'circle', id: 'circle-1', cx: 10, cy: 20, radius: 15 });
    store.getState().addShape(sketchC, { kind: 'polyline', id: 'poly-1', points: [[0, 0], [10, 10]], closed: false });

    // 1. Selecting Sketch A switches work plane to planeA
    store.getState().select({ kind: 'sketch', id: sketchA });
    expect(store.getState().workPlane).toEqual(planeA);

    // 2. Selecting shape inside Sketch B switches work plane to planeB
    store.getState().select({ kind: 'shape', sketchId: sketchB, shapeId: 'circle-1' });
    expect(store.getState().workPlane).toEqual(planeB);

    // 3. Selecting curve-point inside Sketch C switches work plane to planeC
    store.getState().select({ kind: 'curve-point', sketchId: sketchC, shapeId: 'poly-1', pointIndex: 0 });
    expect(store.getState().workPlane).toEqual(planeC);

    // 4. Selecting loop inside Sketch B switches work plane to planeB
    store.getState().select({ kind: 'loop', sketchId: sketchB, loopIndex: 0, shapeIds: ['circle-1'] });
    expect(store.getState().workPlane).toEqual(planeB);

    // 5. selectMany with elements of Sketch A switches work plane to planeA
    store.getState().selectMany([{ kind: 'sketch', id: sketchA }]);
    expect(store.getState().workPlane).toEqual(planeA);

    // 6. When work plane is locked, work plane does NOT switch
    store.getState().setWorkPlaneLocked(true);
    store.getState().select({ kind: 'sketch', id: sketchB });
    expect(store.getState().workPlane).toEqual(planeA);
  });

  it('manages work plane setup modes and 3 points creation', () => {
    const store = createModelingStore();
    expect(store.getState().settingWorkPlane).toBe(false);

    // Enter 3points mode
    store.getState().startSettingWorkPlane('3points');
    expect(store.getState().settingWorkPlane).toBe(true);
    expect(store.getState().workPlaneMode).toBe('3points');
    expect(store.getState().workPlanePoints).toEqual([]);

    // Add Point 1 (Origin)
    store.getState().addWorkPlanePoint([0, 0, 0]);
    expect(store.getState().workPlanePoints).toHaveLength(1);

    // Switch mode to surface
    store.getState().setWorkPlaneMode('surface');
    expect(store.getState().workPlaneMode).toBe('surface');
    expect(store.getState().workPlanePoints).toEqual([]);

    // Switch back to 3points
    store.getState().setWorkPlaneMode('3points');
    store.getState().addWorkPlanePoint([0, 0, 0]);
    store.getState().addWorkPlanePoint([100, 0, 0]);
    expect(store.getState().workPlanePoints).toHaveLength(2);
    expect(store.getState().settingWorkPlane).toBe(true);

    // Add 3rd point (on XY plane) -> finishes setup and creates custom plane
    store.getState().addWorkPlanePoint([0, 0, 100]);
    expect(store.getState().settingWorkPlane).toBe(false);
    expect(store.getState().workPlanePoints).toEqual([]);
    expect(store.getState().workPlane.kind).toBe('custom');
  });

  it('reuses last tool or action on double right-click', () => {
    const store = createModelingStore();
    expect(store.getState().tool).toBe('select');
    expect(store.getState().lastActiveTool).toBe('line');
    expect(store.getState().lastAction).toEqual({ kind: 'tool', tool: 'line' });

    // 1. Activate rect tool
    store.getState().setTool('rect');
    expect(store.getState().tool).toBe('rect');
    expect(store.getState().lastActiveTool).toBe('rect');
    expect(store.getState().lastAction).toEqual({ kind: 'tool', tool: 'rect' });

    // Switch back to select
    store.getState().setTool('select');
    expect(store.getState().tool).toBe('select');
    expect(store.getState().lastActiveTool).toBe('rect');

    // Trigger double right-click reuse -> restores rect tool
    store.getState().reuseLastToolOrAction();
    expect(store.getState().tool).toBe('rect');
    expect(store.getState().lastReusedNotice).toBe('Re-used: rect');

    // 2. Add primitive box
    store.getState().addPrimitive('box');
    expect(store.getState().bodies.length).toBeGreaterThan(0);
    expect(store.getState().lastAction).toEqual({ kind: 'primitive', shape: 'box' });

    const bodyCountBefore = store.getState().bodies.length;
    store.getState().reuseLastToolOrAction();
    expect(store.getState().bodies.length).toBe(bodyCountBefore + 1);
    expect(store.getState().lastReusedNotice).toBe('Re-used: Add box');

    // 3. Start setting workplane
    store.getState().startSettingWorkPlane('surface');
    expect(store.getState().settingWorkPlane).toBe(true);
    expect(store.getState().lastAction).toEqual({ kind: 'workplane', mode: 'surface' });

    // Cancel setup
    store.getState().cancelSettingWorkPlane();
    expect(store.getState().settingWorkPlane).toBe(false);

    // Reuse last action -> re-opens workplane surface mode
    store.getState().reuseLastToolOrAction();
    expect(store.getState().settingWorkPlane).toBe(true);
    expect(store.getState().workPlaneMode).toBe('surface');
    expect(store.getState().lastReusedNotice).toBe('Re-used: Set work plane (surface)');
  });

  it('keeps sketch reference plane fixed when updateSketch is called with a plane', () => {
    const store = createModelingStore();
    const planeA = { kind: 'plane', id: 'top', offset: 0 } as const;
    const planeB = { kind: 'plane', id: 'front', offset: 100 } as const;
    const sketchId = store.getState().addSketch(planeA);

    expect(store.getState().sketches[0]?.plane).toEqual(planeA);

    // Attempt to mutate the sketch's plane
    (store.getState().updateSketch as any)(sketchId, { plane: planeB, name: 'Renamed Sketch' });

    const sketch = store.getState().sketches.find((s) => s.id === sketchId);
    expect(sketch?.name).toBe('Renamed Sketch');
    // Plane must remain planeA
    expect(sketch?.plane).toEqual(planeA);
  });

  it('sets the work plane without asking and gives it a sketch to draw into', () => {
    const store = createModelingStore();
    const planeB = { kind: 'plane', id: 'front', offset: 50 } as const;
    expect(store.getState().setWorkPlane(planeB)).toBe(true);
    expect(store.getState().workPlane).toEqual(planeB);
    const sketch = store.getState().sketches.at(-1)!;
    expect(sketch.plane).toEqual(planeB);
    expect(store.getState().selection).toEqual({ kind: 'sketch', id: sketch.id });
  });

  it('reuses the sketch already on a plane and drops empty automatic sketches', () => {
    const store = createModelingStore();
    const planeA = { kind: 'plane', id: 'front', offset: 0 } as const;
    const planeB = { kind: 'plane', id: 'front', offset: 100 } as const;
    store.getState().setWorkPlane(planeA);
    const first = store.getState().sketches.at(-1)!;
    // Moving on from an untouched automatic sketch removes it.
    store.getState().setWorkPlane(planeB);
    expect(store.getState().sketches.some((s) => s.id === first.id)).toBe(false);
    const second = store.getState().sketches.at(-1)!;
    store.getState().addShape(second.id, { kind: 'rect', id: 'r', x: 0, y: 0, width: 10, height: 10 });
    store.getState().setWorkPlane(planeA);
    // A sketch with drawing stays; coming back to its plane selects it again.
    expect(store.getState().sketches.some((s) => s.id === second.id)).toBe(true);
    store.getState().setWorkPlane(planeB);
    expect(store.getState().selection).toEqual({ kind: 'sketch', id: second.id });
    expect(store.getState().sketches.filter((s) => s.plane.kind === 'plane' && s.plane.offset === 100)).toHaveLength(1);
  });

  it('moves, flips, rotates and resets the work plane directly', () => {
    const store = createModelingStore();
    expect(store.getState().moveWorkPlane(200)).toBe(true);
    expect(store.getState().workPlane).toMatchObject({ offset: 200 });
    expect(store.getState().flipWorkPlane()).toBe(true);
    expect(store.getState().rotateWorkPlane('x', 90)).toBe(true);
    expect(store.getState().resetWorkPlane('front')).toBe(true);
    expect(store.getState().workPlane).toEqual({ kind: 'plane', id: 'front', offset: 0 });
    store.getState().setWorkPlaneLocked(true);
    expect(store.getState().resetWorkPlane('top')).toBe(false);
  });
});

describe('parameters in the store', () => {
  it('drives bound numbers, follows renames, and undoes with the recipe', () => {
    const store = createModelingStore();
    const bodyId = store.getState().addPrimitive('box');
    const featureId = store.getState().bodies[0]!.features[0]!.id;
    const id = store.getState().addParameter({ name: 'panel', value: 2400 });
    store.getState().setBinding(`feature/${bodyId}/${featureId}/size/0`, { expression: '= panel / 2' });
    const size = () => { const feature = store.getState().bodies[0]!.features[0]!; return feature.kind === 'primitive' ? feature.size[0] : null; };
    expect(size()).toBe(1200);

    store.getState().updateParameter(id, { value: 3000 });
    expect(size()).toBe(1500);

    store.getState().updateParameter(id, { name: 'panelWidth' });
    expect(store.getState().bindings[`feature/${bodyId}/${featureId}/size/0`]!.expression).toBe('panelWidth / 2');
    expect(size()).toBe(1500);

    // Typing into a bound field does not stick: the formula wins.
    store.getState().updateFeature(bodyId, featureId, { size: [10, 400, 600] });
    expect(size()).toBe(1500);

    store.getState().undo(); // the typed size
    store.getState().undo(); // the rename
    store.getState().undo(); // the value change
    expect(size()).toBe(1200);
    expect(store.getState().parameterValues['panel']).toBe(2400);
  });

  it('rejects names that formulas could not read', () => {
    const store = createModelingStore();
    const id = store.getState().addParameter({ name: 'a' });
    store.getState().addParameter({ name: 'b' });
    expect(() => store.getState().updateParameter(id, { name: '2x' })).toThrow();
    expect(() => store.getState().updateParameter(id, { name: 'max' })).toThrow();
    expect(() => store.getState().updateParameter(id, { name: 'B' })).toThrow(/already/);
  });
});
