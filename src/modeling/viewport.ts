/**
 * Renders the modeling scene into one canvas split into panes (single, 2 or 4). Each pane has
 * its own camera, controls and display style, bound to its own overlay element; the canvas
 * underneath is drawn with scissor rectangles. 2D panes are orthographic views locked to a view
 * plane with the model clipped at it and are the sketching surface (pointer events go to the
 * sketch tool in sketch coordinates); 3D panes orbit and let the user grab planes, cameras and
 * bodies (the gizmo moves or rotates a body's placement) or drag the extrude arrow; a camera
 * pane looks through one of the cameras and writes orbit changes back to it.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { effectiveModifiers, isOn, PalmRejection, touchModifiers } from '@/interaction/touchModifiers';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { StoreApi } from 'zustand';
import { dot, planeFrame, samePlane, shapeContour, shapesBounds, toPlane, toWorld } from './kernel/sketch';
import type { Shape2D, SketchPlane } from './kernel/types';
import { faceOutline, facePlane } from './kernel/faces';
import { extractProjectElementSnapPoints } from './projectReference';
import { pickTopology, type PickTarget, type TopologyHit } from './topology';
import { modelingScene, type ModelingScene } from './scene';
import { cameraOfPane, isOrthoView, isParametricBody, MODIFY_TOOLS, newShapeId, ORTHO_VIEWS, PLANE_TOOLS, SKETCH_TOOLS, viewPlaneOf, type ModelingState, type PaneView, type PlaneId, type SelectedItem } from './store';
import { SolidTool } from './tools/extrude';
import { nearestSegment, offsetPoints } from './sketchEdit';
import { SketchTool, type ToolHits, type ToolPointer } from './tools/sketch';

interface Pane {
  index: number;
  element: HTMLElement;
  view: PaneView;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  gizmo: TransformControls | null;
  gizmoHelper: THREE.Object3D | null;
  /** The object the gizmo drives (a plane mesh or a camera part). */
  grabbed: THREE.Object3D | null;
  halfHeight: number;
  pointerDown: { x: number; y: number } | null;
  marquee: HTMLDivElement;
  marqueeStart: { x: number; y: number; additive: boolean } | null;
  dispose: () => void;
}

/** Where a 2D pane looks from and which way is up on screen. */
function orthoFrame(plane: SketchPlane): { dir: THREE.Vector3; up: THREE.Vector3; clip: THREE.Vector3; origin: THREE.Vector3 } {
  const frame = planeFrame(plane);
  const dir = new THREE.Vector3(...frame.normal).negate();
  return { dir, up: new THREE.Vector3(...frame.v), clip: dir.clone(), origin: new THREE.Vector3(...frame.origin) };
}

/** The plane a pane looks at (views only show: drawing goes on the work plane, see sketchPointer). */
function planeForView(view: PaneView, state: ModelingState): SketchPlane | null {
  return viewPlaneOf(view, state);
}

const LONG_PRESS_MS = 550;
/** A finger wobbles more than a mouse: movement below this is still a press. */
const TOUCH_SLOP_PX = 10;

const isTouchEvent = (event: PointerEvent) => event.pointerType === 'touch';
const touchMode = () => document.documentElement.getAttribute('data-touch') === 'true';

export class ModelingViewport {
  private readonly renderer: THREE.WebGLRenderer;
  private panes: Pane[] = [];
  private frame = 0;
  private disposed = false;
  private readonly resize: ResizeObserver;
  private readonly unsubscribe: () => void;
  private readonly toolUnsubscribe: () => void;
  private readonly raycaster = new THREE.Raycaster();
  /** The 2D tools and the solid (extrude / revolve / push-pull) tool; the app routes key presses to them. */
  readonly tools: { sketch: SketchTool; solid: SolidTool };
  /** What the extrude gizmo drags: an invisible handle on the profile's centre, its Z along the normal. */
  private readonly extrudeHandle = new THREE.Object3D();
  private readonly loopHandle = new THREE.Object3D();
  private readonly vertexHandle = new THREE.Object3D();
  private readonly edgeHandle = new THREE.Object3D();
  private lastLoopPos: THREE.Vector3 | null = null;
  private lastCurveQuaternion: THREE.Quaternion | null = null;
  private lastCurveScale: THREE.Vector3 | null = null;
  private lastVertexPos: THREE.Vector3 | null = null;
  private lastEdgePos: THREE.Vector3 | null = null;
  private curveTargets: { sketchId: string; shapeIds: string[] } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly store: StoreApi<ModelingState>,
    private readonly world: ModelingScene = modelingScene,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xf3f4f6);
    this.renderer.localClippingEnabled = false;
    const canvas = this.renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    container.prepend(canvas);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.unsubscribe = world.onChange(() => this.requestRender());
    this.tools = { sketch: new SketchTool(store), solid: new SolidTool(store, world) };
    let previousTool = store.getState().tool;
    this.toolUnsubscribe = store.subscribe((state) => {
      if (state.tool === previousTool) return;
      // Mark the new tool before cleanup because cleanup itself writes transient state.
      previousTool = state.tool;
      // Avoid a nested store write when there is no temporary sketch state to clear: it can
      // make later React subscribers observe the nested update instead of the tool change.
      if (this.tools.sketch.active || state.sketchPreview || state.numericEntry) this.tools.sketch.cancel();
    });
    world.scene.add(this.extrudeHandle, this.loopHandle, this.vertexHandle, this.edgeHandle);
    this.fit();
  }

  /** Rebuilds the panes for a new layout; camera positions of unchanged views are kept. */
  configure(panes: { element: HTMLElement; view: PaneView }[]): void {
    const previous = new Map(this.panes.map((pane) => [pane.view, { position: pane.camera.position.clone(), target: pane.controls.target.clone() }]));
    for (const pane of this.panes) pane.dispose();
    this.panes = panes.map(({ element, view }, index) => this.createPane(index, element, view, previous.get(view)));
    this.fit();
    this.syncCameraPanes();
  }

  private createPane(index: number, element: HTMLElement, view: PaneView, previous?: { position: THREE.Vector3; target: THREE.Vector3 }): Pane {
    const is3d = view === '3d';
    const sketchPlane = planeForView(view, this.store.getState());
    const cameraId = cameraOfPane(view);
    const user = cameraId ? this.store.getState().cameras.find((camera) => camera.id === cameraId) : undefined;
    const camera = is3d || cameraId ? new THREE.PerspectiveCamera(user?.fov ?? 45, 1, 10, 200_000) : new THREE.OrthographicCamera(-1, 1, 1, -1, -100_000, 100_000);
    const controls = new OrbitControls(camera, element);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    const navigationDown = (event: PointerEvent) => {
      if (event.button === 1) controls.mouseButtons.MIDDLE = event.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      // A short swipe should not spin the model half way round.
      controls.rotateSpeed = isTouchEvent(event) ? 0.45 : 1;
    };
    const navigationUp = () => {
      controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    };
    element.addEventListener('pointerdown', navigationDown, true);
    element.addEventListener('pointerup', navigationUp, true);
    const marquee = document.createElement('div');
    marquee.style.cssText = 'position:absolute;display:none;pointer-events:none;border:1px solid #2f6fed;background:rgba(47,111,237,.12);z-index:6;';
    element.appendChild(marquee);
    const pane: Pane = { index, element, view, camera, controls, gizmo: null, gizmoHelper: null, grabbed: null, halfHeight: 2000, pointerDown: null, marquee, marqueeStart: null, dispose: () => {} };

    if (is3d) {
      camera.position.copy(previous?.position ?? new THREE.Vector3(4000, 3000, 4000));
      controls.target.copy(previous?.target ?? new THREE.Vector3(0, 500, 0));
      const gizmo = new TransformControls(camera, element);
      gizmo.setSize(0.7);
      const helper = gizmo.getHelper();
      helper.visible = false;
      gizmo.enabled = false;
      this.world.scene.add(helper);
      gizmo.addEventListener('dragging-changed', (event) => {
        const dragging = (event as unknown as { value: boolean }).value;
        controls.enabled = !dragging;
        // The same pointer event also reaches the pane. Mark it as consumed so releasing a
        // gizmo handle cannot be misread as an empty-canvas click that clears selection.
        if (dragging) pane.pointerDown = null;
        // One history entry per drag: the transient placement updates during it skip the history.
        if (dragging && (pane.grabbed === this.loopHandle || this.store.getState().selection?.kind === 'body' || this.store.getState().selection?.kind === 'workplane' || this.store.getState().selection?.kind === 'shape' || this.store.getState().selection?.kind === 'loop' || this.store.getState().selection?.kind === 'sketch' || this.store.getState().selection?.kind === 'curve-point' || this.store.getState().selection?.kind === 'vertex' || this.store.getState().selection?.kind === 'edge')) this.store.getState().recordHistory();
        // Releasing the extrude arrow commits the extrusion.
        if (!dragging && pane.grabbed === this.extrudeHandle) this.tools.solid.commit();
        if (!dragging) this.syncGizmos();
      });
      gizmo.addEventListener('objectChange', () => this.onGizmoChange(pane));
      pane.gizmo = gizmo;
      pane.gizmoHelper = helper;
      element.addEventListener('pointerdown', this.onPointerDown);
      element.addEventListener('pointerup', this.onPointerUp);
      element.addEventListener('pointermove', this.onPointerMove);
    } else if (cameraId) {
      camera.position.copy(user ? new THREE.Vector3(...user.eye) : new THREE.Vector3(3000, 1600, 3000));
      controls.target.copy(user ? new THREE.Vector3(...user.aim) : new THREE.Vector3(0, 600, 0));
      controls.addEventListener('end', () => this.writeCameraBack(pane));
    } else if (sketchPlane) {
      const frame = orthoFrame(sketchPlane);
      controls.enableRotate = false;
      camera.up.copy(frame.up);
      const bounds = this.world.bounds();
      const centre = bounds?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3(0, 500, 0);
      controls.target.copy(previous?.target ?? centre);
      camera.position.copy(controls.target).sub(frame.dir.clone().multiplyScalar(50_000));
      pane.halfHeight = Math.max(1500, bounds ? bounds.getSize(new THREE.Vector3()).length() * 0.6 : 1500);
    }
    // Sketch tools project onto the pane plane in orthographic views and onto the active work
    // plane in perspective/camera views, so drawing is available without changing view.
    element.addEventListener('pointerdown', this.onSketchPointerDown);
    element.addEventListener('pointermove', this.onSketchPointerMove);
    element.addEventListener('pointerleave', this.onSketchPointerLeave);
    element.addEventListener('pointerup', this.onSketchPointerUp);
    element.addEventListener('dblclick', this.onSketchDoubleClick);
    element.addEventListener('pointerdown', this.onRightPointerDown);
    element.addEventListener('pointerup', this.onRightPointerUp);
    element.addEventListener('contextmenu', this.onContextMenu);
    element.addEventListener('pointercancel', this.onPalmCancel);
    element.addEventListener('pointermove', this.onTopologyHover);
    element.addEventListener('pointerleave', this.onTopologyLeave);
    controls.update();
    controls.addEventListener('change', () => this.requestRender());

    pane.dispose = () => {
      element.removeEventListener('pointerdown', this.onPointerDown);
      element.removeEventListener('pointerup', this.onPointerUp);
      element.removeEventListener('pointermove', this.onPointerMove);
      element.removeEventListener('pointerdown', this.onSketchPointerDown);
      element.removeEventListener('pointermove', this.onSketchPointerMove);
      element.removeEventListener('pointerleave', this.onSketchPointerLeave);
      element.removeEventListener('pointerup', this.onSketchPointerUp);
      element.removeEventListener('dblclick', this.onSketchDoubleClick);
      element.removeEventListener('pointerdown', this.onRightPointerDown);
      element.removeEventListener('pointerup', this.onRightPointerUp);
      element.removeEventListener('contextmenu', this.onContextMenu);
      element.removeEventListener('pointercancel', this.onPalmCancel);
      element.removeEventListener('pointermove', this.onTopologyHover);
      element.removeEventListener('pointerleave', this.onTopologyLeave);
      element.removeEventListener('pointerdown', navigationDown, true);
      element.removeEventListener('pointerup', navigationUp, true);
      if (pane.gizmoHelper) this.world.scene.remove(pane.gizmoHelper);
      pane.gizmo?.dispose();
      controls.dispose();
      marquee.remove();
    };
    return pane;
  }

  private paneAt(element: EventTarget | null): Pane | undefined {
    return this.panes.find((pane) => pane.element === element || pane.element.contains(element as Node));
  }

  private beginMarquee(pane: Pane, event: PointerEvent): void {
    pane.marqueeStart = { x: event.clientX, y: event.clientY, additive: effectiveModifiers(event).additive };
    // A finger box-selecting (Select area) must not also orbit/pan the view.
    if (isTouchEvent(event)) pane.controls.enabled = false;
    pane.marquee.style.display = 'block';
    this.updateMarquee(pane, event.clientX, event.clientY);
  }

  private updateMarquee(pane: Pane, clientX: number, clientY: number): void {
    const start = pane.marqueeStart;
    if (!start) return;
    const paneRect = pane.element.getBoundingClientRect();
    pane.marquee.style.left = `${Math.min(start.x, clientX) - paneRect.left}px`;
    pane.marquee.style.top = `${Math.min(start.y, clientY) - paneRect.top}px`;
    pane.marquee.style.width = `${Math.abs(clientX - start.x)}px`;
    pane.marquee.style.height = `${Math.abs(clientY - start.y)}px`;
  }

  private finishMarquee(pane: Pane, event: PointerEvent): void {
    const start = pane.marqueeStart;
    if (!start) return;
    pane.marqueeStart = null;
    pane.marquee.style.display = 'none';
    const left = Math.min(start.x, event.clientX);
    const right = Math.max(start.x, event.clientX);
    const top = Math.min(start.y, event.clientY);
    const bottom = Math.max(start.y, event.clientY);
    if (right - left < 4 && bottom - top < 4) {
      const topology = this.selectableTopology(pane, event.clientX, event.clientY);
      if (topology) this.selectTopology(topology, start.additive);
      else if (!start.additive) this.store.getState().select(null);
      return;
    }
    pane.camera.updateMatrixWorld();
    this.world.scene.updateMatrixWorld(true);
    const paneRect = pane.element.getBoundingClientRect();
    const projected = (point: THREE.Vector3) => {
      const p = point.clone().project(pane.camera);
      return { x: paneRect.left + (p.x + 1) * paneRect.width / 2, y: paneRect.top + (1 - p.y) * paneRect.height / 2 };
    };
    const overlaps = (points: { x: number; y: number }[]) => {
      if (!points.length) return false;
      const minX = Math.min(...points.map((point) => point.x));
      const maxX = Math.max(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y));
      const maxY = Math.max(...points.map((point) => point.y));
      return maxX >= left && minX <= right && maxY >= top && minY <= bottom;
    };
    const state = this.store.getState();
    const selections: SelectedItem[] = [];
    for (const sketch of state.sketches) {
      if (!sketch.visible) continue;
      for (const shape of sketch.shapes) {
        const points = shapeContour(shape).map((point) => projected(new THREE.Vector3(...toWorld(sketch.plane, point))));
        if (overlaps(points)) selections.push({ kind: 'shape', sketchId: sketch.id, shapeId: shape.id });
      }
    }
    for (const body of state.bodies) {
      if (!body.visible) continue;
      const object = this.world.bodyObject(body.id);
      if (!object) continue;
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) continue;
      const corners: THREE.Vector3[] = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
      if (overlaps(corners.map(projected))) selections.push({ kind: 'body', id: body.id });
    }
    state.selectMany(selections, start.additive);
  }

  // ---- 2D panes: sketching -------------------------------------------------------------------

  /** Sketch units per screen pixel in an orthographic or perspective pane. */
  private unitsPerPixel(pane: Pane): number {
    const rect = pane.element.getBoundingClientRect();
    if (pane.camera instanceof THREE.OrthographicCamera) {
      return (2 * pane.halfHeight) / pane.camera.zoom / Math.max(1, rect.height);
    }
    if (pane.camera instanceof THREE.PerspectiveCamera) {
      const dist = pane.camera.position.distanceTo(pane.controls.target);
      const vFov = (pane.camera.fov * Math.PI) / 180;
      return (2 * Math.tan(vFov / 2) * dist) / Math.max(1, rect.height);
    }
    return 1;
  }

  /** The pointer in the pane's plane coordinates with what lies under it (a shape or a body). */
  private sketchPointer(pane: Pane, event: PointerEvent | MouseEvent): ToolPointer | null {
    const state = this.store.getState();
    const viewPlane = planeForView(pane.view, state);
    // A view only decides what is seen. New drawing always lands on the work plane (or keeps the
    // plane of the shape being drawn); the user moves the work plane on purpose (Set work plane).
    // Selecting and moving shapes in a flat view still works in that view's own plane.
    const drawing = PLANE_TOOLS.includes(state.tool) || this.tools.sketch.active;
    // Modify tools work in the plane of the curves they change.
    const modifyPlane = MODIFY_TOOLS.includes(state.tool) ? this.tools.sketch.modify.plane() : null;
    let plane: SketchPlane = this.tools.sketch.active && this.tools.sketch.currentPlane ? this.tools.sketch.currentPlane : modifyPlane ?? (drawing ? state.workPlane : (viewPlane ?? state.workPlane));
    // Drawing in a flat view that sees the work plane edge-on (the ground plane from the front,
    // say) draws on that view's own plane instead, as Revit does in elevations; the work plane
    // follows on the first press (see onSketchPointerDown).
    if (drawing && !this.tools.sketch.active && !modifyPlane && viewPlane && !state.workPlaneLocked && Math.abs(dot(planeFrame(viewPlane).normal, planeFrame(state.workPlane).normal)) < 0.02) plane = viewPlane;
    const rect = pane.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    // The camera may have moved since the last frame (or none was drawn yet in a hidden tab).
    pane.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, pane.camera);
    const frame = planeFrame(plane);
    const normal = new THREE.Vector3(...frame.normal);
    // Edge-on: every ray grazes the plane and the drawing would shoot off to infinity.
    if (Math.abs(normal.dot(this.raycaster.ray.direction)) < 0.02) return null;
    const target = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(normal, -dot(frame.normal, frame.origin)), target)) return null;
    const point = toPlane(plane, [target.x, target.y, target.z]);
    const touch = event instanceof PointerEvent && (event.pointerType === 'touch' || document.documentElement.getAttribute('data-touch') === 'true');
    const radius = (touch ? 18 : 8) * this.unitsPerPixel(pane);
    this.raycaster.params.Line = { threshold: radius };

    const projectSnapPoints: NonNullable<ToolPointer['projectSnapPoints']>[number][] = [];
    const unitsPerPx = this.unitsPerPixel(pane);
    const tolerancePx = touch ? 18 : 8;
    const screenDistance = (world: THREE.Vector3): number => {
      const projected = world.clone().project(pane.camera);
      if (projected.z > 1) return Infinity;
      return Math.hypot(event.clientX - (rect.left + ((projected.x + 1) / 2) * rect.width), event.clientY - (rect.top + ((1 - projected.y) / 2) * rect.height));
    };

    // Where the project's edges cross the drawing plane.
    const projectRef = this.world.getProjectReference();
    if (projectRef && projectRef.visible) {
      for (const candidate of extractProjectElementSnapPoints(projectRef, plane)) {
        if (candidate.type !== 'edge-intersection') continue;
        const distance = screenDistance(new THREE.Vector3(...candidate.point3D));
        if (distance > tolerancePx * 1.6) continue;
        projectSnapPoints.push({ point: candidate.point, label: 'Crosses plane', type: 'edge-intersection', screenDistance: distance * unitsPerPx, priority: 10 });
      }
    }

    // The vertex or edge of a body or of the project under the pointer, projected onto the plane.
    const topology = pickTopology(this.topologyTargets(true), { camera: pane.camera, rect, clientX: event.clientX, clientY: event.clientY }, { vertexPx: tolerancePx * 1.6, edgePx: tolerancePx });
    if (topology && topology.kind !== 'face') {
      const project = topology.source.kind === 'project';
      if (topology.kind === 'vertex') {
        const world = new THREE.Vector3(...topology.point);
        projectSnapPoints.push({ point: toPlane(plane, topology.point), label: project ? 'Project vertex' : 'Vertex', type: 'body-vertex', screenDistance: screenDistance(world) * unitsPerPx, priority: 12, target: topology });
      } else {
        const middle = new THREE.Vector3(...topology.a).lerp(new THREE.Vector3(...topology.b), 0.5);
        const middleDistance = screenDistance(middle);
        if (middleDistance <= tolerancePx * 1.6) {
          projectSnapPoints.push({ point: toPlane(plane, [middle.x, middle.y, middle.z]), label: project ? 'Project midpoint' : 'Midpoint', type: 'midpoint', screenDistance: middleDistance * unitsPerPx, priority: 12, target: { ...topology, point: [middle.x, middle.y, middle.z] } });
        }
        projectSnapPoints.push({ point: toPlane(plane, topology.point), label: project ? 'On project edge' : 'On edge', type: 'body-edge', screenDistance: screenDistance(new THREE.Vector3(...topology.point)) * unitsPerPx, priority: 0, target: topology });
      }
    }

    return {
      plane,
      point,
      hit: this.hitAt(viewPlane ?? plane),
      ...(() => {
        const mods = effectiveModifiers(event);
        return { shift: mods.shift, alt: mods.alt, additive: mods.additive };
      })(),
      radius,
      screen: [event.clientX, event.clientY],
      projectSnapPoints: projectSnapPoints.length > 0 ? projectSnapPoints : undefined,
    };
  }

  /**
   * What the last raycast crossed: the nearest shape (those on the pane's plane offset first) and
   * the nearest body. Anything the pane clips away (beyond its plane) does not count.
   */
  private hitAt(plane: SketchPlane): ToolHits {
    this.world.scene.updateMatrixWorld();
    const hits = this.world.withDoubleSidedBodies(() => this.raycaster.intersectObjects(this.world.pickables(true), true));
    const sketches = this.store.getState().sketches;
    const frame = planeFrame(plane);
    let shape: ToolHits['shape'] = null;
    let onPlane: ToolHits['shape'] = null;
    let body: string | null = null;
    for (const hit of hits) {
      if (!(hit.object instanceof THREE.Mesh || hit.object instanceof THREE.Line) || !this.shown(hit.object)) continue;
      // Sketch overlays float 1 mm above their plane; keep them when they sit on this plane.
      const along = (hit.point.x - frame.origin[0]) * frame.normal[0] + (hit.point.y - frame.origin[1]) * frame.normal[1] + (hit.point.z - frame.origin[2]) * frame.normal[2];
      if (along > 2) continue;
      const shapeId = hit.object.userData['shapeId'] as string | undefined;
      const sketchId = hit.object.userData['sketchId'] as string | undefined;
      if (shapeId && sketchId) {
        shape ??= { sketchId, shapeId };
        const sketch = sketches.find((item) => item.id === sketchId);
        if (!onPlane && sketch && samePlane(sketch.plane, plane)) onPlane = { sketchId, shapeId };
        continue;
      }
      const bodyId = hit.object.userData['bodyId'] as string | undefined;
      if (bodyId) body ??= bodyId;
    }
    return { shape: onPlane ?? shape, body };
  }

  private readonly onSketchPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    // Palm rejection: a palm under the pen is ignored; right after the pen, fingers only navigate.
    if (this.palm.down(event) !== null) return;
    if (isTouchEvent(event) && !event.isPrimary) {
      // A second finger means pan/zoom (OrbitControls): it never draws or selects, and a
      // shape this gesture had just started is abandoned.
      this.clearLongPress();
      if (this.touchStartedDrag) this.tools.sketch.keyDown({ key: 'Escape' });
      this.touchStartedDrag = false;
      this.touchOwnsFinger = false;
      for (const pane of this.panes) pane.controls.enabled = true;
      for (const pane of this.panes) if (pane.marqueeStart) this.cancelMarquee(pane);
      return;
    }
    const pane = this.paneAt(event.currentTarget);
    const state = this.store.getState();
    if (pane && isTouchEvent(event) && state.tool === 'select') this.startLongPress(pane, event);
    if (!pane || (!planeForView(pane.view, state) && !PLANE_TOOLS.includes(state.tool) && !this.tools.sketch.active)) return;
    const pointer = pane && this.sketchPointer(pane, event);
    if (!pointer) return;
    // A drawing started on a view's own plane moves the work plane (and its sketch) there.
    if (SKETCH_TOOLS.includes(state.tool) && !this.tools.sketch.active && !state.sketchEdit && !samePlane(pointer.plane, state.workPlane)) state.setWorkPlane(pointer.plane);
    try {
      pane.element.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events (tests) have no active pointer to capture.
    }
    if (state.tool === 'pickline') {
      this.pickLineAt(pane, event.clientX, event.clientY);
      pane.pointerDown = null;
      return;
    }
    if (state.tool === 'extrude' && this.extrudeRegionClick(pane, event.clientX, event.clientY)) {
      pane.pointerDown = null;
      this.regionPressAt = event.timeStamp;
      return;
    }
    if (state.tool === 'select' && !pointer.hit.shape && !pointer.hit.body) {
      // A finger on empty space navigates (orbit in 3D, pan in plan views); "Select area" boxes.
      if (!isTouchEvent(event) || isOn(touchModifiers.get().selectArea)) this.beginMarquee(pane, event);
    } else {
      const wasActive = this.tools.sketch.active;
      this.tools.sketch.pointerDown(pointer);
      this.touchStartedDrag = isTouchEvent(event) && !wasActive && this.tools.sketch.active;
      // The tool owns this finger (drawing, or grabbing a shape): the view must not pan/orbit too.
      this.touchOwnsFinger = isTouchEvent(event) && (this.touchStartedDrag || Boolean(pointer.hit.shape));
      if (this.touchOwnsFinger) pane.controls.enabled = false;
    }
    // In a perspective pane the general picker also receives this gesture. A sketch hit belongs
    // to the sketch tool so the later general pointer-up must not clear or replace its selection.
    if (pointer.hit.shape) pane.pointerDown = null;
  };

  private readonly onSketchPointerMove = (event: PointerEvent) => {
    if (this.palm.ignores(event)) return;
    if (this.longPress && Math.hypot(event.clientX - this.longPress.x, event.clientY - this.longPress.y) > TOUCH_SLOP_PX) this.clearLongPress();
    if (isTouchEvent(event) && !event.isPrimary) return;
    const pane = this.paneAt(event.currentTarget);
    if (!pane) return;
    const state = this.store.getState();
    const tool = state.tool;
    if (pane.marqueeStart) {
      this.updateMarquee(pane, event.clientX, event.clientY);
      pane.element.style.cursor = 'crosshair';
      return;
    }
    if (tool === 'select' && !this.tools.sketch.active) {
      if (!planeForView(pane.view, state)) return;
      const pointer = this.sketchPointer(pane, event);
      state.setHoveredShape(pointer?.hit.shape ?? null);
      pane.element.style.cursor = pointer?.hit.shape ? 'grab' : '';
      return;
    }
    state.setHoveredShape(null);
    pane.element.style.cursor = PLANE_TOOLS.includes(tool) ? 'crosshair' : tool === 'paint' ? 'copy' : '';
    if (!PLANE_TOOLS.includes(tool) && !this.tools.sketch.active) return;
    const pointer = this.sketchPointer(pane, event);
    if (pointer) this.tools.sketch.pointerMove(pointer);
  };

  private readonly onSketchPointerLeave = () => {
    this.store.getState().setHoveredShape(null);
    this.world.setFaceHighlight('hover', null);
  };

  private readonly onSketchPointerUp = (event: PointerEvent) => {
    if (this.palm.up(event)) return;
    if (event.button !== 0) return;
    this.clearLongPress();
    if (isTouchEvent(event) && !event.isPrimary) return;
    const pane = this.paneAt(event.currentTarget);
    if (this.touchOwnsFinger && pane) pane.controls.enabled = true;
    this.touchStartedDrag = false;
    this.touchOwnsFinger = false;
    const state = this.store.getState();
    if (!pane || (!planeForView(pane.view, state) && !PLANE_TOOLS.includes(state.tool) && !this.tools.sketch.active)) return;
    const pointer = pane && this.sketchPointer(pane, event);
    if (!pointer) return;
    if (pane.element.hasPointerCapture(event.pointerId)) pane.element.releasePointerCapture(event.pointerId);
    if (pane.marqueeStart) {
      this.finishMarquee(pane, event);
      pane.controls.enabled = true;
      touchModifiers.consumeOnce();
      return;
    }
    this.tools.sketch.pointerUp(pointer);
    touchModifiers.consumeOnce();
  };

  // ---- touch: long-press is the right-click --------------------------------------------------

  private readonly palm = new PalmRejection();
  private readonly onPalmCancel = (event: PointerEvent) => {
    this.palm.up(event);
  };

  private longPress: { x: number; y: number; timer: number } | null = null;
  /** The primary finger started a shape in this gesture (a second finger abandons it). */
  private touchStartedDrag = false;
  /** The press already picked an extrude region; the general click handler must not pick it again. */
  private regionPressAt = -1;
  /** The primary finger belongs to the tool (drawing or a grabbed shape), not to navigation. */
  private touchOwnsFinger = false;

  private startLongPress(pane: Pane, event: PointerEvent): void {
    this.clearLongPress();
    const x = event.clientX;
    const y = event.clientY;
    const timer = window.setTimeout(() => {
      this.longPress = null;
      // Nothing under the finger drags or clicks after the menu opens.
      pane.pointerDown = null;
      if (navigator.vibrate) navigator.vibrate(40);
      this.openContextMenuAt(pane, x, y);
    }, LONG_PRESS_MS);
    this.longPress = { x, y, timer };
  }

  private clearLongPress(): void {
    if (this.longPress) window.clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  private cancelMarquee(pane: Pane): void {
    pane.marqueeStart = null;
    pane.marquee.style.display = 'none';
    pane.controls.enabled = true;
  }

  /** Double-click finishes a polyline. */
  private readonly onSketchDoubleClick = (event: MouseEvent) => {
    if (this.tools.sketch.active) {
      this.tools.sketch.keyDown({ key: 'Enter' });
      return;
    }
    // Double-clicking a curve with Select edits its sketch in isolation (Revit's Edit Boundary).
    const state = this.store.getState();
    const pane = this.paneAt(event.currentTarget);
    if (!pane || state.tool !== 'select') return;
    // On a selected polyline: add a vertex there (then drag it).
    const pointer = this.sketchPointer(pane, event);
    if (pointer && this.tools.sketch.insertVertexAt(pointer)) return;
    if (state.sketchEdit) return;
    const sketchId = this.pick(pane, event.clientX, event.clientY)?.userData['sketchId'] as string | undefined;
    if (sketchId) state.enterSketchEdit(sketchId);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if ((isTouchEvent(event) && !event.isPrimary) || this.palm.down(event) !== null) return;
    if (PLANE_TOOLS.includes(this.store.getState().tool) || this.tools.sketch.active) return;
    const pane = this.paneAt(event.currentTarget);
    if (!pane || event.button !== 0) return;
    const state = this.store.getState();
    if (state.tool === 'select' && !state.settingWorkPlane && !this.pick(pane, event.clientX, event.clientY)) {
      this.beginMarquee(pane, event);
      pane.pointerDown = null;
      return;
    }
    pane.pointerDown = this.regionPressAt === event.timeStamp ? null : { x: event.clientX, y: event.clientY };
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if ((isTouchEvent(event) && !event.isPrimary) || this.palm.ignores(event)) return;
    const pane = this.paneAt(event.currentTarget);
    if (PLANE_TOOLS.includes(this.store.getState().tool) || this.tools.sketch.active) return;
    if (pane?.marqueeStart && event.button === 0) {
      this.finishMarquee(pane, event);
      return;
    }
    if (!pane || !pane.pointerDown || event.button !== 0) return;
    const down = pane.pointerDown;
    pane.pointerDown = null;
    // A drag (orbit) or a press on a gizmo handle is not a click.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4 || pane.gizmo?.dragging) return;
    const state = this.store.getState();
    // Work-plane mode accepts surface/face, reference plane, or 3 points.
    if (state.settingWorkPlane) {
      if (state.workPlaneMode === 'surface') {
        const face = this.pickFace(pane, event.clientX, event.clientY);
        if (face) {
          const data = this.world.bodyMeshData(face.bodyId);
          const body = state.bodies.find((item) => item.id === face.bodyId);
          const outline = data && faceOutline(data, face.faceId);
          if (body && outline) {
            state.setWorkPlane(facePlane(outline, body.placement));
            return;
          }
        }
        const surface = this.pickSurfacePlane(pane, event.clientX, event.clientY);
        if (surface) {
          state.setWorkPlane(surface);
          return;
        }
      } else if (state.workPlaneMode === 'plane') {
        const target = this.pick(pane, event.clientX, event.clientY);
        const fixed = target?.userData['plane'] as PlaneId | undefined;
        if (fixed) {
          state.setWorkPlane({ kind: 'plane', id: fixed, offset: state.planes[fixed] });
          return;
        }
      } else if (state.workPlaneMode === '3points') {
        const pt = this.snap3DPoint(pane, event.clientX, event.clientY);
        if (pt) {
          state.addWorkPlanePoint(pt);
          return;
        }
      }
      return;
    }
    // Push/pull picks a face of a body; the tool keeps its outline for the extrusion.
    if (state.tool === 'pushpull') {
      const face = this.pickFace(pane, event.clientX, event.clientY);
      if (face) {
        const data = this.world.bodyMeshData(face.bodyId);
        const body = state.bodies.find((item) => item.id === face.bodyId);
        if (data && body) this.tools.solid.pickFace(face.bodyId, face.faceId, data, body.placement);
      } else {
        state.select(null);
      }
      return;
    }
    const additive = effectiveModifiers(event).additive;
    // Extrude: a click inside a selected profile (not on one of its curves) picks or drops that
    // region; clicking a curve still adds / replaces curves as a selection.
    if (this.extrudeRegionClick(pane, event.clientX, event.clientY)) return;
    // A project vertex / edge / face wins over the view planes seen through it.
    if (state.tool === 'select') {
      const topology = this.selectableTopology(pane, event.clientX, event.clientY);
      if (topology && topology.source.kind !== 'body') {
        this.selectTopology(topology, additive);
        return;
      }
    }
    const hit = this.pick(pane, event.clientX, event.clientY);
    if (!hit) {
      if (!additive) state.select(null);
      return;
    }
    // Sketch edit mode: only the edited sketch's curves respond; everything else is locked.
    if (state.sketchEdit && (hit.userData['sketchId'] !== state.sketchEdit.sketchId || !hit.userData['shapeId'])) {
      if (!additive) state.select(null);
      return;
    }
    const plane = hit.userData['plane'] as PlaneId | undefined;
    const workPlane = hit.userData['workPlane'] as boolean | undefined;
    const cameraId = hit.userData['cameraId'] as string | undefined;
    const part = hit.userData['cameraPart'] as 'eye' | 'aim' | undefined;
    const nodeId = hit.userData['nodeId'] as string | undefined;
    const layerId = hit.userData['layerId'] as string | undefined;
    const bodyId = hit.userData['bodyId'] as string | undefined;
    const shapeId = hit.userData['shapeId'] as string | undefined;
    const sketchId = hit.userData['sketchId'] as string | undefined;
    if (cameraId && part) state.select({ kind: 'camera', id: cameraId, part }, additive);
    else if (shapeId && sketchId) {
      const sketch = state.sketches.find((item) => item.id === sketchId);
      const shape = sketch?.shapes.find((item) => item.id === shapeId);
      const alreadySelected = (state.selection?.kind === 'shape' || state.selection?.kind === 'curve-point') && state.selection.shapeId === shapeId;
      if (sketch && shape?.kind === 'polyline' && alreadySelected) {
        const rect = pane.element.getBoundingClientRect();
        let closest = -1;
        let distance = Infinity;
        shape.points.forEach((point, index) => {
          const projected = new THREE.Vector3(...toWorld(sketch.plane, point)).project(pane.camera);
          const x = rect.left + (projected.x + 1) * rect.width / 2;
          const y = rect.top + (1 - projected.y) * rect.height / 2;
          const next = Math.hypot(event.clientX - x, event.clientY - y);
          if (next < distance) { distance = next; closest = index; }
        });
        if (closest >= 0 && distance <= 16) {
          state.select({ kind: 'curve-point', sketchId, shapeId, pointIndex: closest }, additive);
          return;
        }
      }
      state.select({ kind: 'shape', sketchId, shapeId }, additive);
    }
    else if (bodyId && state.tool === 'paint') state.updateBody(bodyId, { material: state.toolOptions.paintMaterial });
    else if (bodyId && state.tool === 'boolean' && state.selection?.kind === 'body' && state.selection.id !== bodyId) state.setToolOptions({ boolean: { ...state.toolOptions.boolean, tool: bodyId } });
    else if (bodyId) {
      // Once a body is selected, clicking near one of its vertices or edges picks that part.
      const topology = this.selectableTopology(pane, event.clientX, event.clientY);
      if (topology && topology.source.kind === 'body' && topology.source.bodyId === bodyId) {
        this.selectTopology(topology, false);
        return;
      }
      state.select({ kind: 'body', id: bodyId }, additive);
    }
    else if (nodeId && layerId) state.select(this.nodeSelection(layerId, nodeId), additive);
    else if (plane) state.select({ kind: 'plane', id: plane }, additive);
    else if (workPlane) state.select({ kind: 'workplane' }, additive);
  };

  /**
   * Clicking the model selects the top-level node of the hit mesh's layer unless something in
   * that layer is already selected, in which case the click goes down to the exact mesh — so a
   * first click grabs the part and a second refines it.
   */
  private nodeSelection(layerId: string, nodeId: string): ModelingState['selection'] {
    const { selection } = this.store.getState();
    const insideLayer = (selection?.kind === 'layer' && selection.id === layerId) || (selection?.kind === 'node' && selection.layerId === layerId);
    if (insideLayer) return { kind: 'node', layerId, nodeId };
    const top = nodeId.split('/').slice(0, 2).join('/');
    return { kind: 'node', layerId, nodeId: top };
  }

  /**
   * With Select, the vertex / edge / face the pointer is on is highlighted before clicking: always
   * for the project reference, and for a body once that body is selected (a first click picks
   * the whole body, a second one its part).
   */
  private readonly onTopologyHover = (event: PointerEvent) => {
    const pane = this.paneAt(event.currentTarget);
    const state = this.store.getState();
    const idle = pane && !pane.marqueeStart && !pane.gizmo?.dragging && event.buttons === 0 && state.tool === 'select' && !state.settingWorkPlane && !this.tools.sketch.active && !isTouchEvent(event);
    this.world.highlights.set('hover', idle ? this.selectableTopology(pane, event.clientX, event.clientY) : null);
    this.requestRender();
  };

  private readonly onTopologyLeave = () => {
    this.world.highlights.set('hover', null);
    this.requestRender();
  };

  private selectableTopology(pane: Pane, clientX: number, clientY: number): TopologyHit | null {
    const state = this.store.getState();
    const selection = state.selection;
    const bodies = new Set<string>();
    const selectedBody = selection?.kind === 'body' ? selection.id : selection?.kind === 'vertex' || selection?.kind === 'edge' ? selection.bodyId : null;
    const body = selectedBody ? state.bodies.find((item) => item.id === selectedBody) : null;
    // Curve-driven bodies are reshaped through their sketches, not by dragging mesh parts.
    if (body && !isParametricBody(body)) bodies.add(body.id);
    // A sketch shape, camera or other body in front keeps its own click behaviour.
    const front = this.pick(pane, clientX, clientY);
    if (front && !front.userData['plane'] && !front.userData['workPlane']) {
      const frontBody = front.userData['bodyId'] as string | undefined;
      if (!frontBody || !bodies.has(frontBody)) return null;
    }
    const rect = pane.element.getBoundingClientRect();
    const hit = pickTopology(this.topologyTargets(bodies, { layers: false }), { camera: pane.camera, rect, clientX, clientY }, { vertexPx: 12, edgePx: 7, faces: true });
    if (hit?.kind === 'face' && hit.source.kind !== 'project') return null;
    return hit;
  }

  private selectTopology(hit: TopologyHit, additive: boolean): void {
    const state = this.store.getState();
    if (hit.source.kind !== 'body') {
      state.select({ kind: 'reference', target: hit }, additive);
      return;
    }
    const bodyId = hit.source.bodyId;
    const mesh = this.world.bodyObject(bodyId);
    const data = this.world.bodyMeshData(bodyId);
    if (!mesh || !data || hit.kind === 'face') return;
    mesh.updateMatrixWorld(true);
    const local = (point: readonly number[]): [number, number, number] => {
      const v = mesh.worldToLocal(new THREE.Vector3(point[0], point[1], point[2]));
      return [v.x, v.y, v.z];
    };
    const nearestVertex = (point: [number, number, number]) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < data.positions.length / 3; i++) {
        const d = (data.positions[i * 3]! - point[0]) ** 2 + (data.positions[i * 3 + 1]! - point[1]) ** 2 + (data.positions[i * 3 + 2]! - point[2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };
    if (hit.kind === 'vertex') {
      const point = local(hit.point);
      state.select({ kind: 'vertex', bodyId, vertexIndex: nearestVertex(point), point });
    } else {
      const p1 = local(hit.a), p2 = local(hit.b);
      state.select({ kind: 'edge', bodyId, edgeIndex: nearestVertex(p1) * 100_000 + nearestVertex(p2), p1, p2 });
    }
  }

  /** Hovering with push/pull or work-plane highlights faces or guides points. */
  private readonly onPointerMove = (event: PointerEvent) => {
    const pane = this.paneAt(event.currentTarget);
    if (!pane) return;
    if (pane.marqueeStart) {
      this.updateMarquee(pane, event.clientX, event.clientY);
      pane.element.style.cursor = 'crosshair';
      return;
    }
    const tool = this.store.getState().tool;
    const settingWorkPlane = this.store.getState().settingWorkPlane;
    const workPlaneMode = this.store.getState().workPlaneMode;
    pane.element.style.cursor = settingWorkPlane || tool === 'pushpull' || tool === 'paint' || tool === 'boolean' ? 'crosshair' : '';

    if (settingWorkPlane && workPlaneMode === '3points') {
      const pt = this.snap3DPoint(pane, event.clientX, event.clientY);
      this.world.setWorkPlaneMarkers(this.store.getState().workPlanePoints, pt);
      this.world.setFaceHighlight('hover', null);
      return;
    }

    if ((!settingWorkPlane && tool !== 'pushpull') || pane.gizmo?.dragging) {
      this.world.setFaceHighlight('hover', null);
      return;
    }
    if (settingWorkPlane && workPlaneMode === 'surface') {
      this.world.setFaceHighlight('hover', this.pickFace(pane, event.clientX, event.clientY));
    } else if (tool === 'pushpull') {
      this.world.setFaceHighlight('hover', this.pickFace(pane, event.clientX, event.clientY));
    }
  };

  /** Snaps to a 3D coordinate: vertex near pointer (<= 14px), solid surface, current work plane, or ground. */
  private snap3DPoint(pane: Pane, clientX: number, clientY: number): [number, number, number] | null {
    const rect = pane.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    pane.camera.updateMatrixWorld();
    this.world.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, pane.camera);

    // 1. Vertex snap: test visible body mesh vertices projected to screen coordinates
    const v = new THREE.Vector3();
    const projected = new THREE.Vector3();
    let bestDist = 14; // pixels
    let bestPt: [number, number, number] | null = null;
    const considerPoint = (point: THREE.Vector3) => {
      projected.copy(point).project(pane.camera);
      if (projected.z > 1) return;
      const sx = ((projected.x + 1) / 2) * rect.width + rect.left;
      const sy = ((-projected.y + 1) / 2) * rect.height + rect.top;
      const dist = Math.hypot(clientX - sx, clientY - sy);
      if (dist < bestDist) {
        bestDist = dist;
        bestPt = [point.x, point.y, point.z];
      }
    };

    for (const body of this.store.getState().bodies) {
      if (!body.visible) continue;
      const mesh = this.world.bodyObject(body.id);
      if (!mesh || !mesh.geometry) continue;
      const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!posAttr) continue;
      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i);
        v.applyMatrix4(mesh.matrixWorld);
        considerPoint(v);
      }
    }

    // Locked project-reference geometry is not selectable, but its vertices and edges remain
    // useful inference targets while modeling a linked package.
    const projectRef = this.world.getProjectReference();
    if (projectRef?.visible) {
      projectRef.updateMatrixWorld(true);
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const pa = new THREE.Vector3();
      const pb = new THREE.Vector3();
      projectRef.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !this.shown(object)) return;
        const geometry = object.geometry as THREE.BufferGeometry;
        const positions = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!positions) return;
        const vertexStep = Math.max(1, Math.floor(positions.count / 1200));
        for (let i = 0; i < positions.count; i += vertexStep) {
          a.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
          considerPoint(a);
        }
        const indices = geometry.index;
        const triangleCount = indices ? Math.floor(indices.count / 3) : Math.floor(positions.count / 3);
        const triangleStep = Math.max(1, Math.floor(triangleCount / 1600));
        for (let triangle = 0; triangle < triangleCount; triangle += triangleStep) {
          const ids = indices
            ? [indices.getX(triangle * 3), indices.getX(triangle * 3 + 1), indices.getX(triangle * 3 + 2)]
            : [triangle * 3, triangle * 3 + 1, triangle * 3 + 2];
          for (let edge = 0; edge < 3; edge++) {
            a.fromBufferAttribute(positions, ids[edge]!).applyMatrix4(object.matrixWorld);
            b.fromBufferAttribute(positions, ids[(edge + 1) % 3]!).applyMatrix4(object.matrixWorld);
            pa.copy(a).project(pane.camera);
            pb.copy(b).project(pane.camera);
            const ax = ((pa.x + 1) / 2) * rect.width + rect.left;
            const ay = ((-pa.y + 1) / 2) * rect.height + rect.top;
            const bx = ((pb.x + 1) / 2) * rect.width + rect.left;
            const by = ((-pb.y + 1) / 2) * rect.height + rect.top;
            const vx = bx - ax;
            const vy = by - ay;
            const length2 = vx * vx + vy * vy;
            const t = length2 > 1e-9 ? Math.max(0, Math.min(1, ((clientX - ax) * vx + (clientY - ay) * vy) / length2)) : 0;
            const dist = Math.hypot(clientX - (ax + vx * t), clientY - (ay + vy * t));
            if (dist < bestDist) {
              bestDist = dist;
              const point = a.clone().lerp(b, t);
              bestPt = [point.x, point.y, point.z];
            }
          }
        }
      });
    }
    if (bestPt) return bestPt;

    // 2. Solid mesh surface intersection
    const targets: THREE.Object3D[] = [this.world.content];
    if (projectRef && projectRef.visible) targets.push(projectRef);
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      if (!(hit.object instanceof THREE.Mesh) || !this.shown(hit.object)) continue;
      return [hit.point.x, hit.point.y, hit.point.z];
    }

    // 3. Current work plane intersection
    const workFrame = planeFrame(this.store.getState().workPlane);
    const normal = new THREE.Vector3(...workFrame.normal);
    const origin = new THREE.Vector3(...workFrame.origin);
    const plane = new THREE.Plane(normal, -normal.dot(origin));
    const target = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(plane, target)) {
      const grid = this.store.getState().toolOptions.grid;
      if (this.store.getState().toolOptions.snap && grid > 0) {
        const u = new THREE.Vector3(...workFrame.u);
        const v = new THREE.Vector3(...workFrame.v);
        const rel = target.clone().sub(origin);
        const du = Math.round(rel.dot(u) / grid) * grid;
        const dv = Math.round(rel.dot(v) / grid) * grid;
        const snapped = origin.clone().addScaledVector(u, du).addScaledVector(v, dv);
        return [snapped.x, snapped.y, snapped.z];
      }
      return [target.x, target.y, target.z];
    }

    // 4. Ground plane (y = 0) fallback
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (this.raycaster.ray.intersectPlane(groundPlane, target)) {
      return [target.x, target.y, target.z];
    }

    return null;
  }

  /** The body face under the pointer in a 3D pane (nearest body triangle → its face id). */
  /**
   * Extrude with a profile: a click inside one of its regions, away from its curves, picks or
   * drops that region. Returns true when the click was used that way.
   */
  private extrudeRegionClick(pane: Pane, clientX: number, clientY: number): boolean {
    const state = this.store.getState();
    if (state.tool !== 'extrude' || !state.toolOptions.extrude.profiles.length) return false;
    const radius = 8 * this.unitsPerPixel(pane);
    for (const group of state.toolOptions.extrude.profiles) {
      const sketch = state.sketches.find((item) => item.id === group.sketchId);
      const point = sketch ? this.pointOnPlane(pane, clientX, clientY, sketch.plane) : null;
      if (!sketch || !point) continue;
      // Near a curve: the click (de)selects curves as usual.
      const nearCurve = sketch.shapes.some((shape) => (nearestSegment(shape, point)?.distance ?? Infinity) <= radius);
      if (nearCurve) return false;
      if (this.tools.solid.toggleRegion(sketch.id, point)) return true;
    }
    return false;
  }

  /**
   * Pick lines: copies a body / imported / project edge, or a curve of another sketch, into the
   * sketch being edited (or the work plane's sketch), projected onto its plane.
   */
  private pickLineAt(pane: Pane, clientX: number, clientY: number): void {
    const state = this.store.getState();
    const target = this.tools.sketch.sketchFor(state.workPlane);
    const sketch = this.store.getState().sketches.find((item) => item.id === target);
    if (!sketch) return;
    const offset = state.toolOptions.drawOffset;
    const add = (shape: Shape2D) => {
      const placed = offset && shape.kind === 'polyline' ? { ...shape, points: offsetPoints(shape.points, offset, shape.closed !== false) } : shape;
      this.store.getState().addShape(sketch.id, placed);
    };
    // A curve of another sketch: copy it (exactly when on the same plane, else projected).
    const front = this.pick(pane, clientX, clientY);
    const fromSketch = front?.userData['sketchId'] as string | undefined;
    const fromShape = front?.userData['shapeId'] as string | undefined;
    if (fromSketch && fromShape && fromSketch !== sketch.id) {
      const source = state.sketches.find((item) => item.id === fromSketch);
      const shape = source?.shapes.find((item) => item.id === fromShape);
      if (source && shape) {
        if (samePlane(source.plane, sketch.plane)) add({ ...shape, id: newShapeId() });
        else {
          const points = shapeContour(shape).map((point) => toPlane(sketch.plane, toWorld(source.plane, point)));
          add({ kind: 'polyline', id: newShapeId(), points, ...(shape.kind === 'polyline' && shape.closed === false ? { closed: false } : {}) });
        }
        return;
      }
    }
    const rect = pane.element.getBoundingClientRect();
    const hit = pickTopology(this.topologyTargets(true), { camera: pane.camera, rect, clientX, clientY }, { vertexPx: 0, edgePx: 8, faces: false });
    if (hit?.kind !== 'edge') return;
    const a = toPlane(sketch.plane, hit.a);
    const b = toPlane(sketch.plane, hit.b);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return;
    add({ kind: 'polyline', id: newShapeId(), points: [a, b], closed: false });
  }

  /** Where the pointer ray meets a sketch plane, in that plane's (u, v); null when edge-on. */
  private pointOnPlane(pane: Pane, clientX: number, clientY: number, plane: SketchPlane): [number, number] | null {
    const rect = pane.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    pane.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, pane.camera);
    const frame = planeFrame(plane);
    const normal = new THREE.Vector3(...frame.normal);
    if (Math.abs(normal.dot(this.raycaster.ray.direction)) < 0.02) return null;
    const target = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(normal, -dot(frame.normal, frame.origin)), target)) return null;
    return toPlane(plane, [target.x, target.y, target.z]);
  }

  private pickFace(pane: Pane, clientX: number, clientY: number): { bodyId: string; faceId: number } | null {
    const rect = pane.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    pane.camera.updateMatrixWorld();
    this.world.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, pane.camera);
    for (const hit of this.raycaster.intersectObject(this.world.content, true)) {
      if (!(hit.object instanceof THREE.Mesh) || !this.shown(hit.object) || hit.faceIndex === undefined) continue;
      const bodyId = hit.object.userData['bodyId'] as string | undefined;
      const faceIds = hit.object.userData['faceIds'] as Uint32Array | undefined;
      if (!bodyId || !faceIds) continue;
      const faceId = faceIds[hit.faceIndex ?? -1];
      return faceId === undefined ? null : { bodyId, faceId };
    }
    return null;
  }

  /** A plane tangent to any imported/model surface under the pointer (GLB meshes have no face ids). */
  private pickSurfacePlane(pane: Pane, clientX: number, clientY: number): SketchPlane | null {
    const rect = pane.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    pane.camera.updateMatrixWorld();
    this.world.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, pane.camera);
    const targets: THREE.Object3D[] = [this.world.content];
    const projectRef = this.world.getProjectReference();
    if (projectRef && projectRef.visible) targets.push(projectRef);
    for (const hit of this.raycaster.intersectObjects(targets, true)) {
      if (!(hit.object instanceof THREE.Mesh) || !this.shown(hit.object) || !hit.face) continue;
      const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      const seed = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const xAxis = seed.addScaledVector(normal, -seed.dot(normal)).normalize();
      return { kind: 'custom', origin: [hit.point.x, hit.point.y, hit.point.z], normal: [normal.x, normal.y, normal.z], xAxis: [xAxis.x, xAxis.y, xAxis.z] };
    }
    return null;
  }

  /** Right-click on a camera: select it and offer to pilot it in this pane. Always prevents default browser context menu. */
  private readonly onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    const pane = this.paneAt(event.currentTarget);
    // Touch opens its menu from the long-press timer; the browser's own long-press event is ignored.
    if (!pane || (event instanceof PointerEvent && isTouchEvent(event)) || touchMode()) return;
    this.openContextMenuAt(pane, event.clientX, event.clientY);
  };

  /** Right-click (or long-press) on a camera: select it and offer to pilot it in this pane. */
  private openContextMenuAt(pane: Pane, clientX: number, clientY: number): void {
    const hit = this.pick(pane, clientX, clientY);
    const cameraId = hit?.userData['cameraId'] as string | undefined;
    if (!cameraId) return;
    const state = this.store.getState();
    state.select({ kind: 'camera', id: cameraId, part: (hit!.userData['cameraPart'] as 'eye' | 'aim') ?? 'eye' });
    state.openCameraMenu({ x: clientX, y: clientY, cameraId, paneIndex: pane.index });
  }

  private lastRightDown: { time: number; x: number; y: number } | null = null;
  private lastRightClickTime = 0;
  private lastRightClickPos = { x: 0, y: 0 };

  private readonly onRightPointerDown = (event: PointerEvent) => {
    if (event.button !== 2) return;
    this.lastRightDown = { time: Date.now(), x: event.clientX, y: event.clientY };
  };

  private readonly onRightPointerUp = (event: PointerEvent) => {
    if (event.button !== 2 || !this.lastRightDown) return;
    const down = this.lastRightDown;
    this.lastRightDown = null;
    const moveDist = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moveDist > 6) return; // Orbit/pan drag, not a static click

    const now = Date.now();
    const clickDist = Math.hypot(event.clientX - this.lastRightClickPos.x, event.clientY - this.lastRightClickPos.y);
    if (now - this.lastRightClickTime <= 400 && clickDist < 25) {
      // Double right-click: re-use last tool or action
      this.lastRightClickTime = 0;
      this.store.getState().reuseLastToolOrAction();
    } else {
      this.lastRightClickTime = now;
      this.lastRightClickPos = { x: event.clientX, y: event.clientY };
    }
  };

  /**
   * Nearest solid thing under the pointer: camera parts and model meshes win over the
   * translucent view planes, which only count when nothing else is hit. Hidden objects and the
   * planes' edge lines are ignored.
   */
  private pick(pane: Pane, clientX: number, clientY: number): THREE.Object3D | null {
    const rect = pane.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    pane.camera.updateMatrixWorld();
    this.world.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, pane.camera);
    this.raycaster.params.Line = { threshold: 10 * this.unitsPerPixel(pane) };
    // Curves and their fills are first-class pick targets for selection and parametric workflows.
    const tool = this.store.getState().tool;
    const hits = this.raycaster.intersectObjects(this.world.pickables(tool === 'select' || tool === 'extrude' || tool === 'revolve' || tool === 'sweep'), true);
    let planeHit: THREE.Object3D | null = null;
    for (const hit of hits) {
      if (!(hit.object instanceof THREE.Mesh || hit.object instanceof THREE.Line) || !this.shown(hit.object)) continue;
      if (hit.object.userData['projectReference'] || hit.object.userData['locked']) continue;
      let object: THREE.Object3D | null = hit.object;
      while (object && !object.userData['plane'] && !object.userData['workPlane'] && !object.userData['cameraPart'] && !object.userData['nodeId'] && !object.userData['bodyId'] && !object.userData['shapeId']) object = object.parent;
      if (!object) continue;
      if (object.userData['projectReference'] || object.userData['locked']) continue;
      if (object.userData['plane'] || object.userData['workPlane']) {
        planeHit ??= object;
        continue;
      }
      return object;
    }
    return planeHit;
  }

  /**
   * Meshes whose vertices, edges and faces can be snapped to or picked: visible bodies (all, or
   * the given ones), imported layers, and the locked project reference.
   */
  private topologyTargets(bodies: boolean | ReadonlySet<string>, options: { layers?: boolean; project?: boolean } = {}): PickTarget[] {
    const targets: PickTarget[] = [];
    this.world.content.updateMatrixWorld(true);
    this.world.content.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.userData['overlay'] || !this.shown(object)) return;
      const bodyId = object.userData['bodyId'] as string | undefined;
      if (bodyId) {
        if (bodies === true || (bodies !== false && bodies.has(bodyId))) targets.push({ mesh: object, source: { kind: 'body', bodyId } });
      } else if ((options.layers ?? true) && !object.parent?.userData['bodyId']) {
        targets.push({ mesh: object, source: { kind: 'layer' } });
      }
    });
    const projectRef = this.world.getProjectReference();
    if ((options.project ?? true) && projectRef?.visible) {
      projectRef.updateMatrixWorld(true);
      projectRef.traverse((object) => {
        if (object instanceof THREE.Mesh && this.shown(object)) targets.push({ mesh: object, source: { kind: 'project' } });
      });
    }
    return targets;
  }

  private shown(object: THREE.Object3D): boolean {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  /** Attaches every 3D pane's gizmo to the selected plane / camera part (constrained to its axis) or body. */
  private syncGizmos(): void {
    const state = this.store.getState();
    const { selection, selectionSet, gizmoMode, toolOptions, tool } = state;
    const selectedItems = selectionSet.length ? selectionSet : (selection ? [selection] : []);
    let curveTargets: { sketchId: string; shapeIds: string[] } | null = null;
    if (selectedItems.length > 0 && selectedItems.every((item) => item.kind === 'shape' || item.kind === 'loop' || item.kind === 'sketch')) {
      const sketchIds = new Set(selectedItems.map((item) => item.kind === 'sketch' ? item.id : item.sketchId));
      if (sketchIds.size === 1) {
        const sketchId = [...sketchIds][0]!;
        const sketch = state.sketches.find((item) => item.id === sketchId);
        const ids = new Set<string>();
        for (const item of selectedItems) {
          if (item.kind === 'sketch') sketch?.shapes.forEach((shape) => ids.add(shape.id));
          else if (item.kind === 'shape') ids.add(item.shapeId);
          else item.shapeIds.forEach((id) => ids.add(id));
        }
        if (ids.size > 0) curveTargets = { sketchId, shapeIds: [...ids] };
      }
    }
    this.curveTargets = curveTargets;
    const profile = tool === 'revolve' ? null : this.tools.solid.profile();
    if (profile) {
      // The arrow sits on the profile's centre, pushed out to the current distance, with its
      // local Z along the plane normal so the gizmo can constrain the drag to it.
      const centre = SolidTool.centre(profile);
      const along = toolOptions.extrude.symmetric && tool === 'extrude' ? toolOptions.extrude.distance / 2 : toolOptions.extrude.distance;
      this.extrudeHandle.position.set(...toWorld(profile.plane, centre, along));
      this.extrudeHandle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...planeFrame(profile.plane).normal));
    }
    for (const pane of this.panes) {
      if (!pane.gizmo || !pane.gizmoHelper) continue;
      if (pane.gizmo.dragging) continue;
      let object: THREE.Object3D | null = null;
      let mode: 'translate' | 'rotate' | 'scale' = 'translate';
      if (profile) {
        object = this.extrudeHandle;
      } else if (curveTargets) {
        const sketch = state.sketches.find((item) => item.id === curveTargets.sketchId);
        const shapes = sketch?.shapes.filter((shape) => curveTargets.shapeIds.includes(shape.id)) ?? [];
        const bounds = shapesBounds(shapes);
        if (sketch && bounds) {
          const centre: [number, number] = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
          this.loopHandle.position.set(...toWorld(sketch.plane, centre));
          const frame = planeFrame(sketch.plane);
          this.loopHandle.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.u), new THREE.Vector3(...frame.v), new THREE.Vector3(...frame.normal)));
          this.loopHandle.scale.set(1, 1, 1);
          this.lastLoopPos = this.loopHandle.position.clone();
          this.lastCurveQuaternion = this.loopHandle.quaternion.clone();
          this.lastCurveScale = this.loopHandle.scale.clone();
          object = this.loopHandle;
          mode = gizmoMode;
        }
      } else if (selection?.kind === 'body') {
        const body = this.store.getState().bodies.find((item) => item.id === selection.id);
        const parametric = body?.features.some((feature) => feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep');
        if (!parametric) {
          object = this.world.bodyObject(selection.id);
          mode = gizmoMode;
        }
      } else if (selection?.kind === 'edge') {
        const mesh = this.world.bodyObject(selection.bodyId);
        const data = this.world.bodyMeshData(selection.bodyId);
        if (mesh && data) {
          const p1 = selection.p1 ?? [data.positions[selection.edgeIndex * 6] ?? 0, data.positions[selection.edgeIndex * 6 + 1] ?? 0, data.positions[selection.edgeIndex * 6 + 2] ?? 0];
          const p2 = selection.p2 ?? [data.positions[selection.edgeIndex * 6 + 3] ?? 0, data.positions[selection.edgeIndex * 6 + 4] ?? 0, data.positions[selection.edgeIndex * 6 + 5] ?? 0];
          const midLocal = new THREE.Vector3((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2);
          mesh.updateMatrixWorld(true);
          midLocal.applyMatrix4(mesh.matrixWorld);
          this.edgeHandle.position.copy(midLocal);
          this.lastEdgePos = this.edgeHandle.position.clone();
          object = this.edgeHandle;
          mode = 'translate';
        }
      } else if (selection?.kind === 'curve-point') {
        const sketch = this.store.getState().sketches.find((item) => item.id === selection.sketchId);
        const shape = sketch?.shapes.find((item) => item.id === selection.shapeId);
        const point = shape?.kind === 'polyline' ? shape.points[selection.pointIndex] : null;
        if (sketch && point) {
          this.vertexHandle.position.set(...toWorld(sketch.plane, point));
          const frame = planeFrame(sketch.plane);
          this.vertexHandle.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.u), new THREE.Vector3(...frame.v), new THREE.Vector3(...frame.normal)));
          this.lastVertexPos = this.vertexHandle.position.clone();
          object = this.vertexHandle;
          mode = 'translate';
        }
      } else if (selection?.kind === 'vertex') {
        const mesh = this.world.bodyObject(selection.bodyId);
        const data = this.world.bodyMeshData(selection.bodyId);
        if (mesh && data) {
          const i = selection.vertexIndex;
          const localV = new THREE.Vector3(data.positions[i * 3] ?? 0, data.positions[i * 3 + 1] ?? 0, data.positions[i * 3 + 2] ?? 0);
          mesh.updateMatrixWorld(true);
          localV.applyMatrix4(mesh.matrixWorld);
          this.vertexHandle.position.copy(localV);
          this.lastVertexPos = this.vertexHandle.position.clone();
          object = this.vertexHandle;
          mode = 'translate';
        }
      // Construction and sketch planes are reference geometry. Transform tools never attach to
      // them; their offsets remain editable through the plane-specific controls.
      } else if (selection?.kind === 'camera') {
        const camera = this.world.cameras.get(selection.id);
        object = camera ? (selection.part === 'eye' ? camera.body : camera.aim) : null;
      }
      pane.grabbed = object;
      if (object) {
        pane.gizmo.attach(object);
        const curveSelection = Boolean(curveTargets) || selection?.kind === 'curve-point';
        pane.gizmo.setMode(mode);
        pane.gizmo.setSpace(profile || curveSelection ? 'local' : 'world');
        // Bodies snap to a 10 mm grid and 15 degree steps; typed values in the Inspector stay exact.
        pane.gizmo.setTranslationSnap(selection?.kind === 'body' || selection?.kind === 'workplane' || profile ? 10 : null);
        pane.gizmo.setRotationSnap(selection?.kind === 'body' || curveTargets ? THREE.MathUtils.degToRad(15) : null);
        pane.gizmo.setScaleSnap(selection?.kind === 'body' || curveTargets ? 0.1 : null);
        const curveRotate = Boolean(curveTargets) && mode === 'rotate';
        pane.gizmo.showX = !profile && !curveRotate;
        pane.gizmo.showY = !profile && !curveRotate;
        pane.gizmo.showZ = Boolean(profile) || curveRotate || !curveSelection;
        pane.gizmo.enabled = true;
        pane.gizmoHelper.visible = true;
      } else {
        pane.gizmo.detach();
        pane.gizmo.enabled = false;
        pane.gizmoHelper.visible = false;
      }
    }
    this.requestRender();
  }

  private onGizmoChange(pane: Pane): void {
    const state = this.store.getState();
    const object = pane.grabbed;
    if (!object) return;
    if (object === this.extrudeHandle) {
      const profile = this.tools.solid.profile();
      if (!profile) return;
      const frame = planeFrame(profile.plane);
      const centre = toWorld(profile.plane, SolidTool.centre(profile));
      const along = (object.position.x - centre[0]) * frame.normal[0] + (object.position.y - centre[1]) * frame.normal[1] + (object.position.z - centre[2]) * frame.normal[2];
      this.tools.solid.setDistance(state.toolOptions.extrude.symmetric && state.tool === 'extrude' ? along * 2 : along);
      return;
    }
    if (object === this.loopHandle && this.curveTargets && this.lastLoopPos) {
      const targets = this.curveTargets;
      const sketch = state.sketches.find((item) => item.id === targets.sketchId);
      if (!sketch) return;
      if (state.gizmoMode === 'translate') {
        const current = toPlane(sketch.plane, [object.position.x, object.position.y, object.position.z]);
        const previous = toPlane(sketch.plane, [this.lastLoopPos.x, this.lastLoopPos.y, this.lastLoopPos.z]);
        const delta: [number, number] = [current[0] - previous[0], current[1] - previous[1]];
        if (Math.hypot(...delta) > 1e-5) state.transformSketchShapes(targets.sketchId, targets.shapeIds, { translate: delta }, true);
        this.lastLoopPos = object.position.clone();
      } else if (state.gizmoMode === 'rotate' && this.lastCurveQuaternion) {
        const delta = this.lastCurveQuaternion.clone().invert().multiply(object.quaternion);
        const degrees = THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(delta, 'XYZ').z);
        if (Math.abs(degrees) > 1e-4) state.transformSketchShapes(targets.sketchId, targets.shapeIds, { rotate: degrees }, true);
        this.lastCurveQuaternion = object.quaternion.clone();
      } else if (state.gizmoMode === 'scale' && this.lastCurveScale) {
        const sx = object.scale.x / Math.max(1e-6, this.lastCurveScale.x);
        const sy = object.scale.y / Math.max(1e-6, this.lastCurveScale.y);
        if (Math.abs(sx - 1) > 1e-5 || Math.abs(sy - 1) > 1e-5) state.transformSketchShapes(targets.sketchId, targets.shapeIds, { scale: [sx, sy] }, true);
        this.lastCurveScale = object.scale.clone();
      }
      return;
    }
    if (object === this.edgeHandle && state.selection?.kind === 'edge' && this.lastEdgePos) {
      const worldDelta = new THREE.Vector3(
        object.position.x - this.lastEdgePos.x,
        object.position.y - this.lastEdgePos.y,
        object.position.z - this.lastEdgePos.z,
      );
      if (worldDelta.length() > 0.01) {
        const mesh = this.world.bodyObject(state.selection.bodyId);
        const localDelta = mesh ? worldDelta.clone().applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()).invert()) : worldDelta;
        const delta: [number, number, number] = [localDelta.x, localDelta.y, localDelta.z];
        this.world.moveBodyEdge(state.selection.bodyId, state.selection.edgeIndex, [worldDelta.x, worldDelta.y, worldDelta.z], state.selection.p1, state.selection.p2);
        state.moveEdge(state.selection.bodyId, state.selection.edgeIndex, delta, true);
        this.lastEdgePos = object.position.clone();
      }
      return;
    }
    if (object === this.vertexHandle && state.selection?.kind === 'curve-point' && this.lastVertexPos) {
      const selected = state.selection;
      const sketch = state.sketches.find((item) => item.id === selected.sketchId);
      if (!sketch) return;
      const point = toPlane(sketch.plane, [object.position.x, object.position.y, object.position.z]);
      state.moveCurvePoint(selected.sketchId, selected.shapeId, selected.pointIndex, point, true);
      this.lastVertexPos = object.position.clone();
      return;
    }
    if (object === this.vertexHandle && state.selection?.kind === 'vertex' && this.lastVertexPos) {
      const worldDelta = new THREE.Vector3(
        object.position.x - this.lastVertexPos.x,
        object.position.y - this.lastVertexPos.y,
        object.position.z - this.lastVertexPos.z,
      );
      if (worldDelta.length() > 0.01) {
        const mesh = this.world.bodyObject(state.selection.bodyId);
        const localDelta = mesh ? worldDelta.clone().applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()).invert()) : worldDelta;
        const delta: [number, number, number] = [localDelta.x, localDelta.y, localDelta.z];
        this.world.moveBodyVertex(state.selection.bodyId, state.selection.vertexIndex, [worldDelta.x, worldDelta.y, worldDelta.z]);
        state.moveVertex(state.selection.bodyId, state.selection.vertexIndex, delta, true);
        this.lastVertexPos = object.position.clone();
      }
      return;
    }
    if (!state.selection) return;
    if (state.selection.kind === 'body') {
      const p = object.position;
      const euler = new THREE.Euler().setFromQuaternion(object.quaternion, 'ZYX');
      const degrees = (radians: number) => Math.round(THREE.MathUtils.radToDeg(radians) * 100) / 100;
      const scale: [number, number, number] = [Math.max(0.01, object.scale.x), Math.max(0.01, object.scale.y), Math.max(0.01, object.scale.z)];
      state.setBodyPlacement(state.selection.id, { position: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], rotation: [degrees(euler.x), degrees(euler.y), degrees(euler.z)], scale }, true);
    } else if (state.selection.kind === 'camera') {
      const p = object.position;
      const next: [number, number, number] = [Math.round(p.x), Math.round(p.y), Math.round(p.z)];
      state.updateCamera(state.selection.id, state.selection.part === 'eye' ? { eye: next } : { aim: next });
    }
  }

  /** A camera pane orbits its camera: eye = orbit position, aim = orbit target. */
  private writeCameraBack(pane: Pane): void {
    const cameraId = cameraOfPane(pane.view);
    if (!cameraId) return;
    const p = pane.camera.position;
    const t = pane.controls.target;
    this.store.getState().updateCamera(cameraId, { eye: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], aim: [Math.round(t.x), Math.round(t.y), Math.round(t.z)] });
  }

  /** Points every camera pane at its camera (after a gizmo drag or an inspector edit). */
  private syncCameraPanes(): void {
    const { cameras } = this.store.getState();
    for (const pane of this.panes) {
      const cameraId = cameraOfPane(pane.view);
      const user = cameraId ? cameras.find((camera) => camera.id === cameraId) : undefined;
      if (!user) continue;
      const eye = new THREE.Vector3(...user.eye);
      const aim = new THREE.Vector3(...user.aim);
      if (pane.camera.position.distanceTo(eye) > 0.5 || pane.controls.target.distanceTo(aim) > 0.5) {
        pane.camera.position.copy(eye);
        pane.controls.target.copy(aim);
        pane.controls.update();
      }
      if (pane.camera instanceof THREE.PerspectiveCamera && Math.abs(pane.camera.fov - user.fov) > 0.01) {
        pane.camera.fov = user.fov;
        pane.camera.updateProjectionMatrix();
      }
    }
  }

  /** Called by the React side whenever the store changes. */
  sync(): void {
    const state = this.store.getState();
    this.world.sync(state);
    const drawing = PLANE_TOOLS.includes(state.tool);
    const touch = touchMode();
    for (const pane of this.panes) {
      const flat = planeForView(pane.view, state) !== null;
      pane.controls.enableRotate = !flat && !drawing;
      // One finger belongs to the tool while drawing; otherwise it orbits a 3D pane and pans a
      // plan/elevation pane. Two fingers always pan and pinch-zoom.
      pane.controls.touches.ONE = (drawing ? null : flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE) as unknown as THREE.TOUCH;
      pane.gizmo?.setSize(touch ? 1.05 : 0.7);
    }
    this.syncGizmos();
    this.syncCameraPanes();
    this.requestRender();
  }

  /** Frames the model in every pane (camera panes keep their camera). */
  frameAll(): void {
    const bounds = this.world.bounds();
    const centre = bounds?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3(0, 500, 0);
    const radius = bounds ? bounds.getSize(new THREE.Vector3()).length() / 2 : 1500;
    for (const pane of this.panes) {
      if (cameraOfPane(pane.view)) continue;
      pane.controls.target.copy(centre);
      if (pane.view === '3d') {
        pane.camera.position.set(centre.x + radius * 1.6, centre.y + radius * 1.2, centre.z + radius * 1.6);
      } else {
        const sketchPlane = planeForView(pane.view, this.store.getState());
        if (!sketchPlane) continue;
        const frame = orthoFrame(sketchPlane);
        pane.camera.position.copy(centre).sub(frame.dir.clone().multiplyScalar(50_000));
        pane.halfHeight = Math.max(500, radius * 1.15);
        if (pane.camera instanceof THREE.OrthographicCamera) pane.camera.zoom = 1;
      }
      pane.controls.update();
    }
    this.fit();
  }

  private fit(): void {
    const { width, height } = this.container.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height, false);
    for (const pane of this.panes) {
      const rect = pane.element.getBoundingClientRect();
      const aspect = rect.width / Math.max(1, rect.height);
      if (pane.camera instanceof THREE.PerspectiveCamera) {
        pane.camera.aspect = aspect;
      } else {
        pane.camera.left = -pane.halfHeight * aspect;
        pane.camera.right = pane.halfHeight * aspect;
        pane.camera.top = pane.halfHeight;
        pane.camera.bottom = -pane.halfHeight;
      }
      pane.camera.updateProjectionMatrix();
    }
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const container = this.container.getBoundingClientRect();
    const state = this.store.getState();
    const { planeVisible, workPlaneVisible, styles, lods, cameras, layers, bodies } = state;
    this.renderer.setScissorTest(true);
    for (const pane of this.panes) {
      const rect = pane.element.getBoundingClientRect();
      const x = rect.left - container.left;
      const y = container.bottom - rect.bottom;
      if (rect.width <= 0 || rect.height <= 0) continue;
      this.renderer.setViewport(x, y, rect.width, rect.height);
      this.renderer.setScissor(x, y, rect.width, rect.height);
      // What each pane shows besides the model: 3D shows every guide; a 2D view hides its own
      // plane (it is the picture plane) and clips the model at it; a camera view hides all guides.
      const sketchPlane = planeForView(pane.view, state);
      const planeKind = isOrthoView(pane.view) ? ORTHO_VIEWS[pane.view].plane : null;
      const throughCamera = cameraOfPane(pane.view);
      this.world.grid.visible = planeKind === null || planeKind === 'top';
      for (const [id, camera] of this.world.cameras) camera.group.visible = !throughCamera && (cameras.find((item) => item.id === id)?.visible ?? false);
      for (const [id, mesh] of this.world.planes) mesh.visible = id !== planeKind && !throughCamera && planeVisible[id];
      this.world.workPlane.visible = pane.view !== 'workplane' && !throughCamera && workPlaneVisible;
      for (const other of this.panes) if (other.gizmoHelper) other.gizmoHelper.visible = other === pane && other.grabbed !== null;
      this.world.setSketchXray(sketchPlane !== null);
      if (sketchPlane) {
        const frame = orthoFrame(sketchPlane);
        this.renderer.clippingPlanes = [new THREE.Plane(frame.clip, -frame.clip.dot(frame.origin))];
      } else {
        this.renderer.clippingPlanes = [];
      }
      this.world.highlights.setResolution(rect.width, rect.height);
      this.world.applyStyle(styles[pane.index] ?? 'realistic');
      this.world.applyLod(lods[pane.index] === 'low', layers, bodies);
      this.renderer.render(this.world.scene, pane.camera);
    }
    this.world.applyStyle('realistic');
    this.world.applyLod(false, layers, bodies);
    this.renderer.setScissorTest(false);
    this.renderer.clippingPlanes = [];
    for (const [id, mesh] of this.world.planes) mesh.visible = planeVisible[id];
    this.world.workPlane.visible = workPlaneVisible;
    for (const [id, camera] of this.world.cameras) camera.group.visible = cameras.find((item) => item.id === id)?.visible ?? false;
    this.world.grid.visible = true;
  }

  dispose(): void {
    this.disposed = true;
    this.tools.solid.dispose();
    this.tools.sketch.cancel();
    this.extrudeHandle.removeFromParent();
    cancelAnimationFrame(this.frame);
    this.unsubscribe();
    this.toolUnsubscribe();
    this.resize.disconnect();
    for (const pane of this.panes) pane.dispose();
    this.panes = [];
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
