/**
 * The solid-from-sketch tools: extrude, revolve and push/pull. With a profile (the selected
 * sketch, or the outline of the picked face for push/pull) the tool shows a translucent preview
 * evaluated by the kernel like any body, lets the 3D gizmo or a typed number change the
 * distance, and commits the feature as a new body or as an add/cut on a target body. Reactive:
 * it watches the store while one of its tools is active.
 */
import type { StoreApi } from 'zustand';
import { evaluationContext } from '../bodies';
import { kernel, type KernelClient } from '../kernel/client';
import { faceOutline, facePlane } from '../kernel/faces';
import { DEFAULT_MATERIAL } from '../kernel/materials';
import { faceAt, pickedFaces, pointInFace, type RegionFace, type SketchArrangement } from '../kernel/regions';
import { arrangeSketch, shapesBounds } from '../kernel/sketch';
import { identityPlacement, type Body, type CurveRef, type Extrude, type Feature, type MeshData, type Placement, type Revolve, type Sketch, type Sweep, type Vec2 } from '../kernel/types';
import type { ModelingScene } from '../scene';
import { curveRefIsClosed, findBody, findSketch, newBodyId, newFeatureId, newShapeId, type ModelingState, type ProfileGroup } from '../store';

const PREVIEW_ID = '__solid-preview';

/** A face picked for push/pull: its outline as a sketch on the face plane, not yet in the store. */
export interface PendingFace {
  bodyId: string;
  faceId: number;
  sketch: Sketch;
}

/** One extrude profile group resolved against its sketch: the curves, their arrangement and the faces used. */
export interface ExtrudePart {
  sketch: Sketch;
  group: ProfileGroup;
  arrangement: SketchArrangement;
  /** The curves enclose at least one face (a solid); otherwise the group extrudes as a surface. */
  closed: boolean;
  /** Faces the extrude uses (picked, or the default solid ones). */
  faces: RegionFace[];
}

/** What the options bar reports about a multi-curve extrude profile. */
export interface ExtrudeSummary {
  groups: number;
  solids: number;
  surfaces: number;
  faces: number;
  openings: number;
  openEnds: number;
  crossings: number;
  overlapping: number;
  picked: boolean;
}

/** Every profile group of the extrude options resolved into its arrangement and faces. */
export function resolveExtrudeParts(sketches: readonly Sketch[], options: { profile: CurveRef | null; profiles?: ProfileGroup[] }): ExtrudePart[] {
  const groups: ProfileGroup[] = options.profiles?.length ? options.profiles : options.profile ? [options.profile] : [];
  const parts: ExtrudePart[] = [];
  for (const group of groups) {
    const full = sketches.find((sketch) => sketch.id === group.sketchId);
    if (!full) continue;
    const shapes = full.shapes.filter((shape) => group.shapeIds.includes(shape.id));
    if (!shapes.length) continue;
    const arrangement = arrangeSketch(shapes);
    const closed = arrangement.faces.length > 0;
    parts.push({ sketch: full, group, arrangement, closed, faces: closed ? pickedFaces(arrangement.faces, group.regions) : [] });
  }
  return parts;
}

/** Counts for the options bar. */
export function summarizeExtrude(parts: readonly ExtrudePart[]): ExtrudeSummary {
  const faces = parts.flatMap((part) => part.faces);
  return {
    groups: parts.length,
    solids: parts.filter((part) => part.closed).length,
    surfaces: parts.filter((part) => !part.closed).length,
    faces: faces.length,
    openings: faces.reduce((count, face) => count + face.holes.length, 0),
    openEnds: parts.reduce((sum, part) => sum + (part.closed ? part.arrangement.openEnds.length : 0), 0),
    crossings: parts.reduce((sum, part) => sum + part.arrangement.crossings.length, 0),
    overlapping: parts.reduce((sum, part) => sum + part.arrangement.overlapping.length, 0),
    picked: parts.some((part) => Boolean(part.group.regions?.length) && part.faces.some((face) => part.group.regions!.some((seed) => pointInFace(seed, face)))),
  };
}

export class SolidTool {
  private readonly unsubscribe: () => void;
  private lastKey = '';
  private pending: PendingFace | null = null;

  constructor(
    private readonly store: StoreApi<ModelingState>,
    private readonly scene: ModelingScene,
    private readonly client: KernelClient = kernel,
  ) {
    this.unsubscribe = store.subscribe(() => this.sync());
    this.sync();
  }

  /** The profile the tool would use: the selected sketch (extrude, revolve) or the picked face (push/pull). */
  profile(): Sketch | null {
    const state = this.store.getState();
    if (state.tool === 'pushpull') {
      const face = state.selection?.kind === 'face' ? state.selection : null;
      return face && this.pending && this.pending.bodyId === face.bodyId && this.pending.faceId === face.faceId ? this.pending.sketch : null;
    }
    let ref: CurveRef | null = null;
    if (state.tool === 'extrude') ref = state.toolOptions.extrude.profile;
    else if (state.tool === 'revolve') ref = state.toolOptions.revolve.profile;
    else if (state.tool === 'sweep') ref = state.toolOptions.sweep.profile;
    else return null;
    const sketch = ref ? findSketch(state.sketches, ref.sketchId) : null;
    return sketch && ref ? { ...sketch, shapes: sketch.shapes.filter((shape) => ref!.shapeIds.includes(shape.id)) } : null;
  }

  /** Centre of the profile in sketch coordinates (where the gizmo sits). */
  static centre(sketch: Sketch): Vec2 {
    const bounds = shapesBounds(sketch.shapes);
    return bounds ? [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2] : [0, 0];
  }

  /** Push/pull: remembers the picked face as a sketch on its plane (world space) and selects it. */
  pickFace(bodyId: string, faceId: number, mesh: MeshData, placement: Placement): boolean {
    const outline = faceOutline(mesh, faceId);
    if (!outline) return false;
    const state = this.store.getState();
    const body = findBody(state.bodies, bodyId);
    const sketch: Sketch = {
      id: `sketch-face-${Date.now().toString(36)}`,
      name: `${body?.name ?? 'Body'} face`,
      visible: true,
      plane: facePlane(outline, placement),
      shapes: outline.loops.map((points) => ({ kind: 'polyline', id: newShapeId(), points })),
    };
    this.pending = { bodyId, faceId, sketch };
    if (state.toolOptions.extrude.distance === 0) {
      state.setToolOptions({ extrude: { ...state.toolOptions.extrude, distance: 100 } });
    }
    this.store.getState().select({ kind: 'face', bodyId, faceId });
    return true;
  }

  /** The feature the current tool and options describe. `op` overrides the option for previews. */
  private feature(sketch: Sketch, op: Extrude['op']): Feature {
    const { tool, toolOptions } = this.store.getState();
    if (tool === 'revolve') {
      const { axis, at, angle, axisRef, profile } = toolOptions.revolve;
      const revolve: Revolve = { kind: 'revolve', id: newFeatureId(), profile: sketch.id, profileShapes: profile?.shapeIds, axisRef: axisRef ?? undefined, axis: axis === 'v' ? { origin: [at, 0], direction: [0, 1] } : { origin: [0, at], direction: [1, 0] }, angle, op };
      return revolve;
    }
    if (tool === 'sweep') {
      const { path, profile } = toolOptions.sweep;
      if (!path || !profile) throw new Error('Select a path and profile before sweeping');
      const sweep: Sweep = { kind: 'sweep', id: newFeatureId(), profile: sketch.id, profileShapes: profile.shapeIds, path, op };
      return sweep;
    }
    const { distance, symmetric } = toolOptions.extrude;
    const profile = toolOptions.extrude.profile;
    const extrude: Extrude = { kind: 'extrude', id: newFeatureId(), profile: sketch.id, profileShapes: tool === 'pushpull' ? undefined : profile?.shapeIds, surface: tool === 'extrude' && Boolean(profile && !curveRefIsClosed(this.store.getState().sketches, profile)), distance, symmetric: tool === 'pushpull' ? false : symmetric, op };
    return extrude;
  }

  /** The operation a commit would use (push/pull derives it from the direction). */
  operation(): Extrude['op'] {
    const { tool, toolOptions } = this.store.getState();
    if (tool === 'pushpull') return toolOptions.extrude.distance >= 0 ? 'add' : 'cut';
    if (tool === 'revolve') return toolOptions.revolve.op;
    if (tool === 'sweep') return toolOptions.sweep.op;
    return toolOptions.extrude.op;
  }

  /** Re-evaluates the preview when the tool, the profile or the options changed. */
  private sync(): void {
    const sketch = this.profile();
    const state = this.store.getState();
    if (!sketch) {
      if (this.lastKey) {
        this.lastKey = '';
        this.scene.setPreviewMesh(null, false);
        this.scene.setProfileRegions([]);
      }
      return;
    }
    const op = this.operation();
    if (state.tool === 'revolve' && !state.toolOptions.revolve.axisRef) return this.scene.setPreviewMesh(null, false);
    if (state.tool === 'sweep' && !state.toolOptions.sweep.path) return this.scene.setPreviewMesh(null, false);
    const parts = state.tool === 'extrude' ? this.extrudeParts() : [];
    const key = JSON.stringify([state.tool, sketch, state.toolOptions.extrude, state.toolOptions.revolve, state.toolOptions.sweep, parts.map((part) => part.sketch.shapes)]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (state.tool === 'extrude') this.scene.setProfileRegions(parts.map((part) => ({ plane: part.sketch.plane, arrangement: part.arrangement, picked: part.faces })));
    const features: Feature[] = state.tool === 'extrude'
      ? this.extrudeFeatures(parts, 'new').map((feature, index): Feature => ({ ...feature, id: `preview-${index}`, op: index === 0 ? 'new' : 'add' }))
      : [{ ...this.feature(sketch, 'new'), id: 'preview' }];
    if (!features.length) return this.scene.setPreviewMesh(null, false);
    const body: Body = { id: PREVIEW_ID, name: 'preview', visible: true, lowLod: false, material: DEFAULT_MATERIAL, placement: identityPlacement(), features };
    const context = evaluationContext(state.sketches, state.bodies);
    if (state.tool !== 'extrude') context.sketches[sketch.id] = sketch;
    void this.client
      .evaluate(body, context)
      .then((mesh) => {
        if (mesh && this.lastKey === key) this.scene.setPreviewMesh(mesh, op === 'cut');
      })
      .catch(() => {
        if (this.lastKey === key) this.scene.setPreviewMesh(null, false);
      });
  }

  /** Live distance from the gizmo; transient (the commit records history once). */
  setDistance(distance: number): void {
    const state = this.store.getState();
    const rounded = Math.round(distance);
    if (rounded === state.toolOptions.extrude.distance || rounded === 0) return;
    state.setToolOptions({ extrude: { ...state.toolOptions.extrude, distance: rounded } });
  }

  /** The body an add/cut goes into: the picked face's body, the chosen target, else the most recent body. */
  target(): Body | null {
    const state = this.store.getState();
    if (state.tool === 'pushpull') return this.pending ? findBody(state.bodies, this.pending.bodyId) : null;
    const chosen = state.tool === 'revolve' ? state.toolOptions.revolve.target : state.tool === 'sweep' ? state.toolOptions.sweep.target : state.toolOptions.extrude.target;
    return state.bodies.find((body) => body.id === chosen) ?? state.bodies[state.bodies.length - 1] ?? null;
  }

  /** Creates the body or the feature from the current options. Returns false when there is nothing to build. */
  commit(): boolean {
    const sketch = this.profile();
    const state = this.store.getState();
    if (!sketch || sketch.shapes.length === 0) return false;
    if (state.tool !== 'pushpull') {
      const ref = state.tool === 'extrude' ? state.toolOptions.extrude.profile : state.tool === 'revolve' ? state.toolOptions.revolve.profile : state.toolOptions.sweep.profile;
      if (!ref || (state.tool !== 'extrude' && !curveRefIsClosed(state.sketches, ref))) return false;
      if (state.tool === 'revolve' && (!state.toolOptions.revolve.axisRef || curveRefIsClosed(state.sketches, state.toolOptions.revolve.axisRef))) return false;
      if (state.tool === 'sweep' && (!state.toolOptions.sweep.path || curveRefIsClosed(state.sketches, state.toolOptions.sweep.path))) return false;
    }
    const op = this.operation();
    const target = op === 'new' ? null : this.target();
    if (state.tool === 'extrude') {
      const features = this.extrudeFeatures(this.extrudeParts(), op);
      if (!features.length) return false;
      const count = state.bodies.filter((body) => body.features[0]?.kind === 'extrude').length + 1;
      const makeBody = (index: number, list: Feature[]): Body => ({ id: newBodyId(), name: `Extrude ${count + index}`, visible: true, lowLod: false, material: DEFAULT_MATERIAL, placement: identityPlacement(), features: list });
      if (op === 'new' || !target) {
        const bodies = state.toolOptions.extrude.separate
          ? features.map((feature, index) => makeBody(index, [{ ...feature, op: 'new' }]))
          : [makeBody(0, features.map((feature, index): Feature => ({ ...feature, op: index === 0 ? 'new' : 'add' })))];
        state.addSolids(bodies, []);
      } else {
        state.addSolids([], features.map((feature) => ({ bodyId: target.id, feature })));
      }
      this.finish();
      return true;
    }
    if (state.tool === 'pushpull') {
      if (!target) return false;
      state.addSketchAndFeature({ ...sketch, visible: false }, target.id, this.feature(sketch, op));
      this.pending = null;
    } else if (op === 'new' || !target) {
      const label = state.tool === 'revolve' ? 'Revolve' : state.tool === 'sweep' ? 'Sweep' : 'Extrude';
      const featureKind = state.tool === 'revolve' ? 'revolve' : state.tool === 'sweep' ? 'sweep' : 'extrude';
      const count = state.bodies.filter((body) => body.features[0]?.kind === featureKind).length + 1;
      const body: Body = { id: newBodyId(), name: `${label} ${count}`, visible: true, lowLod: false, material: DEFAULT_MATERIAL, placement: identityPlacement(), features: [this.feature(sketch, 'new')] };
      state.addBody(body);
    } else {
      state.addFeature(target.id, this.feature(sketch, op));
    }
    this.finish();
    return true;
  }

  private finish(): void {
    this.lastKey = '';
    this.scene.setPreviewMesh(null, false);
    this.scene.setProfileRegions([]);
    this.client.drop(PREVIEW_ID);
    this.store.getState().setTool('select');
  }

  /** Every selected curve group resolved into its arrangement and the faces it would extrude. */
  extrudeParts(): ExtrudePart[] {
    const state = this.store.getState();
    return resolveExtrudeParts(state.sketches, state.toolOptions.extrude);
  }

  /**
   * One extrude per group (a surface for groups without a closed face); with `separate`, one
   * per picked face instead so each becomes its own body.
   */
  private extrudeFeatures(parts: readonly ExtrudePart[], op: Extrude['op']): Extrude[] {
    const { distance, symmetric, separate } = this.store.getState().toolOptions.extrude;
    const features: Extrude[] = [];
    for (const part of parts) {
      const base = { kind: 'extrude' as const, profile: part.sketch.id, profileShapes: [...part.group.shapeIds], distance, symmetric, op };
      if (!part.closed) {
        features.push({ ...base, id: newFeatureId(), surface: true });
        continue;
      }
      if (separate) {
        for (const face of part.faces) features.push({ ...base, id: newFeatureId(), regions: [face.seed] });
        continue;
      }
      features.push({ ...base, id: newFeatureId(), ...(part.group.regions?.length ? { regions: part.faces.map((face) => face.seed) } : {}) });
    }
    return features;
  }

  /**
   * Picks or unpicks the region under a point of a profile group's sketch (sketch coordinates).
   * Returns false when the point is not inside any face of the selected curves.
   */
  toggleRegion(sketchId: string, point: Vec2): boolean {
    const state = this.store.getState();
    const part = this.extrudeParts().find((item) => item.sketch.id === sketchId);
    if (!part?.closed) return false;
    const face = faceAt(part.arrangement.faces, point);
    if (!face) return false;
    const current = part.faces;
    const picked = current.some((item) => item.index === face.index);
    const next = picked ? current.filter((item) => item.index !== face.index) : [...current, face];
    // Keep at least one face; an empty pick would silently fall back to the defaults.
    if (!next.length) return true;
    const regions = next.map((item) => item.seed);
    const profiles = state.toolOptions.extrude.profiles.map((group) => (group.sketchId === sketchId ? { ...group, regions } : group));
    state.setToolOptions({ extrude: { ...state.toolOptions.extrude, profiles, profile: profiles[0] ?? null } });
    return true;
  }

  /** Clears region picks so every group uses its default faces (openings by nesting). */
  resetRegions(): void {
    const state = this.store.getState();
    const profiles = state.toolOptions.extrude.profiles.map(({ regions: _regions, ...group }) => group);
    state.setToolOptions({ extrude: { ...state.toolOptions.extrude, profiles, profile: profiles[0] ?? null } });
  }

  /** Counts for the options bar. */

  dispose(): void {
    this.unsubscribe();
    this.scene.setPreviewMesh(null, false);
    this.scene.setProfileRegions([]);
  }
}
