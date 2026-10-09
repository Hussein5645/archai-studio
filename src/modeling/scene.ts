/**
 * The one three.js scene behind every modeling pane: imported layers (each GLB node registered
 * so Layers can toggle it), modeled bodies (meshes handed over by the kernel, placed by their
 * body placement), the three fixed view planes (top / front / side), and the cameras
 * drawn as objects so they can be grabbed in 3D. Panes (see ./viewport.ts) only decide how the
 * scene is looked at, and ask for a display style while they render.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { planeMatrix, shapeContour } from './kernel/sketch';
import type { RegionFace, SketchArrangement } from './kernel/regions';
import { shapeGrips } from './sketchEdit';
import type { Body, MeshData, PbrMaterial, Shape2D, Sketch, SketchPlane } from './kernel/types';
import { PLANE_AXIS, type Layer, type LayerNode, type LoopCheckPreview, type ModelingCamera, type ModelingState, type PlaneId, type SelectedItem, type Selection, type SketchPreview, type ViewStyle } from './store';
import type { TopologyHit } from './topology';
import { markerStyle, screenMarker, TopologyHighlights } from './topologyHighlight';

export const PLANE_COLORS: Record<PlaneId, number> = { top: 0x2f6fed, front: 0x2f9e6a, side: 0xd64545 };
export const WORK_PLANE_COLOR = 0xf59e0b;
const CAMERA_COLOR = 0x8b5cf6;
const PLANE_IDS: PlaneId[] = ['top', 'front', 'side'];

/** Half-size of a view plane; grows with the model so the plane always frames it. */
function planeHalfSize(bounds: THREE.Box3 | null): number {
  if (!bounds || bounds.isEmpty()) return 1500;
  const size = bounds.getSize(new THREE.Vector3());
  return Math.max(1500, Math.max(size.x, size.y, size.z) * 0.75 + 300);
}

/** A camera as scene objects: body at the eye, sphere at the aim point, sight line and frustum. */
class CameraObject {
  readonly group = new THREE.Group();
  readonly body: THREE.Mesh;
  readonly aim: THREE.Mesh;
  private readonly line: THREE.Line;
  private readonly frustumCamera = new THREE.PerspectiveCamera(60, 1.5, 150, 1800);
  private readonly helper: THREE.CameraHelper;

  constructor(readonly id: string) {
    this.body = new THREE.Mesh(new THREE.BoxGeometry(260, 180, 320), new THREE.MeshStandardMaterial({ color: CAMERA_COLOR, roughness: 0.6 }));
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(70, 90, 140, 24), new THREE.MeshStandardMaterial({ color: 0x2b2340, roughness: 0.4 }));
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -220;
    this.body.add(lens);
    this.aim = new THREE.Mesh(new THREE.SphereGeometry(80, 20, 14), new THREE.MeshStandardMaterial({ color: CAMERA_COLOR, emissive: CAMERA_COLOR, emissiveIntensity: 0.3 }));
    this.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: CAMERA_COLOR, dashSize: 120, gapSize: 80 }));
    this.helper = new THREE.CameraHelper(this.frustumCamera);
    for (const part of [this.body, lens, this.aim]) part.userData['cameraId'] = id;
    this.body.userData['cameraPart'] = 'eye';
    lens.userData['cameraPart'] = 'eye';
    this.aim.userData['cameraPart'] = 'aim';
    this.group.add(this.body, this.aim, this.line, this.helper);
  }

  sync(camera: ModelingCamera, selected: 'eye' | 'aim' | null): void {
    const eye = new THREE.Vector3(...camera.eye);
    const aim = new THREE.Vector3(...camera.aim);
    this.body.position.copy(eye);
    this.body.lookAt(aim);
    // The body's lens points down -Z locally; lookAt aims +Z at the target, so turn it round.
    this.body.rotateY(Math.PI);
    this.aim.position.copy(aim);
    this.line.geometry.setFromPoints([eye, aim]);
    this.line.computeLineDistances();
    this.frustumCamera.position.copy(eye);
    this.frustumCamera.lookAt(aim);
    this.frustumCamera.fov = camera.fov;
    this.frustumCamera.far = Math.max(600, Math.min(eye.distanceTo(aim), 3000));
    this.frustumCamera.updateProjectionMatrix();
    this.frustumCamera.updateMatrixWorld();
    this.helper.update();
    const body = this.body.material as THREE.MeshStandardMaterial;
    body.emissive.set(selected === 'eye' ? CAMERA_COLOR : 0x000000);
    body.emissiveIntensity = 0.5;
    (this.aim.material as THREE.MeshStandardMaterial).emissiveIntensity = selected === 'aim' ? 0.9 : 0.3;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.helper.dispose();
  }
}

/** Materials substituted for the display styles; created once and shared. */
const STYLE_MATERIALS = {
  shaded: new THREE.MeshLambertMaterial({ color: 0xb9bdc6 }),
  wireframe: new THREE.MeshBasicMaterial({ color: 0x3a3a3f, wireframe: true }),
  hiddenLine: new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
};
const EDGE_MATERIAL = new THREE.LineBasicMaterial({
  color: 0x1e293b,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

const ACCENT = 0x2f6fed;
/** Sketch overlay materials, shared; `depthTest` is switched off while a 2D pane renders. */
const SKETCH_MATERIALS = {
  line: new THREE.LineBasicMaterial({ color: 0x3a3f47 }),
  lineSelected: new THREE.LineBasicMaterial({ color: ACCENT }),
  lineHover: new THREE.LineBasicMaterial({ color: 0x00a6d6 }),
  lineLoopClosed: new THREE.LineBasicMaterial({ color: 0x16a36a }),
  lineLoopOpen: new THREE.LineBasicMaterial({ color: 0xd64545 }),
  lineSketch: new THREE.LineBasicMaterial({ color: 0x5b8def }),
  lineFaded: new THREE.LineBasicMaterial({ color: 0x9aa3ae, transparent: true, opacity: 0.45 }),
  linePreview: new THREE.LineBasicMaterial({ color: ACCENT }),
  fill: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
  fillSelected: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }),
  guide: new THREE.LineDashedMaterial({ color: ACCENT, transparent: true, opacity: 0.72, dashSize: 7, gapSize: 5 }),
  pointSelected: new THREE.PointsMaterial({ color: ACCENT, size: 7, sizeAttenuation: false, depthTest: false }),
  pointActive: new THREE.PointsMaterial({ color: 0xf59e0b, size: 12, sizeAttenuation: false, depthTest: false }),
  pointHover: new THREE.PointsMaterial({ color: 0x00a6d6, size: 7, sizeAttenuation: false, depthTest: false }),
  /** Grips in the middle of segments / sides and on arcs (drag the segment, side or bow). */
  gripMid: new THREE.PointsMaterial({ color: 0x0891b2, size: 6, sizeAttenuation: false, depthTest: false }),
  /** Bézier control points of a pen curve, and the lines tying them to their point. */
  gripHandle: new THREE.PointsMaterial({ color: 0xf59e0b, size: 7, sizeAttenuation: false, depthTest: false }),
  handleTie: new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.7, depthTest: false }),
  pointOpen: new THREE.PointsMaterial({ color: 0xd64545, size: 11, sizeAttenuation: false, depthTest: false }),
  preview: new THREE.MeshStandardMaterial({ color: ACCENT, transparent: true, opacity: 0.45, depthWrite: false }),
  faceHover: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.25, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }),
  faceSelected: new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }),
  previewCut: new THREE.MeshStandardMaterial({ color: 0xd64545, transparent: true, opacity: 0.45, depthWrite: false }),
};
const SNAP_MATERIALS = [SKETCH_MATERIALS.guide];
/** Extrude profile diagnostics: picked faces, faces left out, loose ends and crossings. */
const REGION_MATERIALS = {
  picked: new THREE.MeshBasicMaterial({ color: 0x16a36a, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
  skipped: new THREE.LineDashedMaterial({ color: 0x6b7280, dashSize: 8, gapSize: 6, depthTest: false }),
  outline: new THREE.LineBasicMaterial({ color: 0x16a36a, depthTest: false }),
  dangling: new THREE.LineDashedMaterial({ color: 0xd64545, dashSize: 5, gapSize: 4, depthTest: false }),
  openEnd: new THREE.PointsMaterial({ color: 0xd64545, size: 11, sizeAttenuation: false, depthTest: false }),
  crossing: new THREE.PointsMaterial({ color: 0xf59e0b, size: 8, sizeAttenuation: false, depthTest: false }),
};

/** One profile group's regions as the extrude tool shows them. */
export interface ProfileRegionOverlay {
  plane: SketchPlane;
  arrangement: SketchArrangement;
  picked: readonly RegionFace[];
}

function ringLine(points: readonly [number, number][], material: THREE.LineBasicMaterial | THREE.LineDashedMaterial, lift: number): THREE.LineLoop {
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points.map(([u, v]) => new THREE.Vector3(u, v, lift))), material);
  if (material instanceof THREE.LineDashedMaterial) line.computeLineDistances();
  return line;
}
/** How far the overlay floats above its plane so it wins the depth test against a face there (mm). */
const SKETCH_LIFT = 1;

function shapeLine(shape: Shape2D, material: THREE.LineBasicMaterial): THREE.Line {
  const points = shapeContour(shape).map(([u, v]) => new THREE.Vector3(u, v, SKETCH_LIFT));
  return shape.kind === 'polyline' && shape.closed === false ? new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material) : new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material);
}

function shapeFill(shape: Shape2D, material: THREE.MeshBasicMaterial): THREE.Mesh | null {
  if (shape.kind === 'polyline' && shape.closed === false) return null;
  const contour = shapeContour(shape);
  if (contour.length < 3) return null;
  const outline = new THREE.Shape(contour.map(([u, v]) => new THREE.Vector2(u, v)));
  const geometry = new THREE.ShapeGeometry(outline);
  geometry.translate(0, 0, SKETCH_LIFT);
  return new THREE.Mesh(geometry, material);
}

function shapePoints(shape: Shape2D, material: THREE.PointsMaterial): THREE.Points | null {
  const points = shape.kind === 'polyline' ? shape.points : shapeContour(shape);
  if (!points.length) return null;
  const object = new THREE.Points(new THREE.BufferGeometry().setFromPoints(points.map(([u, v]) => new THREE.Vector3(u, v, SKETCH_LIFT + 0.5))), material);
  object.renderOrder = 21;
  return object;
}

/** The snap marker: a fixed-size glyph whose shape and colour say what was snapped to. */
function snapMarker(point: [number, number], type: string): THREE.Points {
  const style = markerStyle(type);
  return screenMarker(new THREE.Vector3(point[0], point[1], SKETCH_LIFT + 0.25), style.shape, style.colour, type === 'grid' ? 12 : 16);
}

function disposeGroup(group: THREE.Object3D): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) (child.geometry as THREE.BufferGeometry).dispose();
  });
  group.removeFromParent();
}

export class ModelingScene {
  readonly scene = new THREE.Scene();
  readonly content = new THREE.Group();
  readonly planes = new Map<PlaneId, THREE.Mesh>();
  readonly workPlane: THREE.Mesh;
  readonly workPlaneSetupGroup = new THREE.Group();
  readonly grid: THREE.GridHelper;
  readonly cameras = new Map<string, CameraObject>();
  private readonly layers = new Map<string, THREE.Object3D>();
  private readonly nodes = new Map<string, THREE.Object3D>();
  private readonly bodies = new Map<string, THREE.Mesh>();
  /** Sketch overlays (lines + pickable fills) per sketch id; kept outside `content` so styles skip them. */
  readonly sketchGroups = new Map<string, THREE.Group>();
  private readonly sketchLayer = new THREE.Group();
  private sketchKeys = new Map<string, string>();
  private previewGroup: THREE.Group | null = null;
  private previewMesh: THREE.Mesh | null = null;
  private regionGroup: THREE.Group | null = null;
  /** Face highlights (hovered / selected), children of their body mesh so they follow it. */
  private readonly faceHighlights: Record<'hover' | 'selected', { mesh: THREE.Mesh; bodyId: string; faceId: number } | null> = { hover: null, selected: null };
  /** One three.js material per asset material id, shared by every body that uses it. */
  private readonly pbrMaterials = new Map<string, THREE.MeshStandardMaterial>();
  /** Flat-colour stand-ins for the "color" style, one per original material. */
  private readonly colorMaterials = new WeakMap<THREE.Material, THREE.Material>();
  private planeSize = 1500;
  private styled: ViewStyle = 'realistic';
  /** Outline of the selected layer/node. */
  private readonly selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x2f6fed);
  /** Hovered / selected / snapped vertices, edges and faces of bodies and the project reference. */
  readonly highlights = new TopologyHighlights();
  private listeners = new Set<() => void>();

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0aa, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(6000, 10000, 4000);
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(10_000, 20, 0xc8cbd2, 0xe1e3e8);
    this.grid.position.y = -1;
    this.scene.add(this.grid, new THREE.AxesHelper(600), this.content);
    this.selectionBox.visible = false;
    (this.selectionBox.material as THREE.LineBasicMaterial).depthTest = false;
    this.selectionBox.renderOrder = 20;
    this.scene.add(this.selectionBox);
    this.sketchLayer.renderOrder = 15;
    this.scene.add(this.sketchLayer);
    this.scene.add(this.highlights.group);

    for (const id of PLANE_IDS) {
      const material = new THREE.MeshBasicMaterial({ color: PLANE_COLORS[id], transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      mesh.userData['plane'] = id;
      mesh.renderOrder = 10;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: PLANE_COLORS[id] }));
      edges.userData['plane'] = id;
      mesh.add(edges);
      // A PlaneGeometry faces +Z; turn it to face its axis.
      if (id === 'top') mesh.rotation.x = -Math.PI / 2;
      if (id === 'side') mesh.rotation.y = Math.PI / 2;
      this.planes.set(id, mesh);
      this.scene.add(mesh);
    }
    const workMaterial = new THREE.MeshBasicMaterial({ color: WORK_PLANE_COLOR, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    this.workPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), workMaterial);
    this.workPlane.userData['workPlane'] = true;
    this.workPlane.renderOrder = 11;
    const workEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineDashedMaterial({ color: WORK_PLANE_COLOR, dashSize: 90, gapSize: 55 }));
    workEdges.computeLineDistances();
    workEdges.userData['workPlane'] = true;
    this.workPlane.add(workEdges);
    this.scene.add(this.workPlane);
    this.applyPlaneSize();
  }

  private projectReference: THREE.Group | null = null;

  setProjectReference(group: THREE.Group | null): void {
    if (this.projectReference) {
      this.scene.remove(this.projectReference);
      this.projectReference = null;
    }
    if (group) {
      this.projectReference = group;
      this.scene.add(group);
    }
    this.emit();
  }

  /** The selected vertex / edge (of a body or the project reference) in world coordinates. */
  private selectedTopology(selection: Selection): TopologyHit | null {
    if (selection?.kind === 'reference') return selection.target;
    if (selection?.kind !== 'vertex' && selection?.kind !== 'edge') return null;
    const mesh = this.bodies.get(selection.bodyId);
    if (!mesh) return null;
    mesh.updateMatrixWorld(true);
    const world = (point: readonly number[]): [number, number, number] => {
      const v = new THREE.Vector3(point[0], point[1], point[2]).applyMatrix4(mesh.matrixWorld);
      return [v.x, v.y, v.z];
    };
    const source = { kind: 'body' as const, bodyId: selection.bodyId };
    if (selection.kind === 'vertex') return selection.point ? { kind: 'vertex', source, point: world(selection.point) } : null;
    if (!selection.p1 || !selection.p2) return null;
    const a = world(selection.p1), b = world(selection.p2);
    return { kind: 'edge', source, a, b, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] };
  }

  getProjectReference(): THREE.Group | null {
    return this.projectReference;
  }

  /** Notifies panes that something visual changed (a layer arrived, a helper moved). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Bounds of the visible model content, or null when nothing is loaded. */
  bounds(): THREE.Box3 | null {
    if (this.layers.size === 0 && this.bodies.size === 0) return null;
    const box = new THREE.Box3();
    this.content.updateMatrixWorld(true);
    this.content.traverse((child) => {
      if (child instanceof THREE.Mesh && !child.userData['overlay'] && this.isShown(child)) box.expandByObject(child);
    });
    return box.isEmpty() ? null : box;
  }

  private isShown(object: THREE.Object3D): boolean {
    for (let node: THREE.Object3D | null = object; node && node !== this.content; node = node.parent) if (!node.visible) return false;
    return true;
  }

  private applyPlaneSize(): void {
    // The edges are children of the mesh, so scaling the mesh scales them too.
    for (const mesh of this.planes.values()) mesh.scale.set(this.planeSize * 2, this.planeSize * 2, 1);
    this.workPlane.scale.set(this.planeSize * 2, this.planeSize * 2, 1);
  }

  /** Applies plane positions, layer/node visibility, body placement/materials and the cameras from the store. */
  sync(state: Pick<ModelingState, 'planes' | 'planeVisible' | 'workPlane' | 'workPlaneVisible' | 'layers' | 'bodies' | 'materials' | 'cameras' | 'selection' | 'selectionSet' | 'sketches' | 'sketchPreview' | 'hoveredShape' | 'loopCheck'> & Partial<Pick<ModelingState, 'settingWorkPlane' | 'workPlaneMode' | 'workPlanePoints' | 'sketchEdit'>>): void {
    this.syncBodies(state.bodies, state.materials);
    this.syncSketches(state.sketches, state.selection, state.selectionSet, state.sketchPreview, state.hoveredShape, state.loopCheck, state.sketchEdit?.sketchId ?? null);
    this.setFaceHighlight('selected', state.selection?.kind === 'face' ? state.selection : null);
    this.highlights.set('selected', this.selectedTopology(state.selection));
    if (!state.settingWorkPlane || state.workPlaneMode !== '3points') {
      this.setWorkPlaneMarkers([]);
    } else if (state.workPlanePoints) {
      this.setWorkPlaneMarkers(state.workPlanePoints);
    }
    for (const layer of state.layers) {
      const object = this.layers.get(layer.id);
      if (object) object.visible = layer.visible;
      const visit = (nodes: LayerNode[]) => {
        for (const node of nodes) {
          const target = this.nodes.get(node.id);
          if (target) target.visible = node.visible;
          visit(node.children);
        }
      };
      visit(layer.nodes);
    }
    const centre = this.bounds()?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
    for (const id of PLANE_IDS) {
      const mesh = this.planes.get(id)!;
      // Each plane sits on the model's centre in the two axes it does not slide along.
      mesh.position.copy(centre);
      mesh.position[PLANE_AXIS[id]] = state.planes[id];
      mesh.visible = state.planeVisible[id];
      (mesh.material as THREE.MeshBasicMaterial).opacity = state.selection?.kind === 'plane' && state.selection.id === id ? 0.28 : 0.12;
    }
    const workMatrix = new THREE.Matrix4().fromArray(planeMatrix(state.workPlane));
    const unitScale = new THREE.Vector3();
    workMatrix.decompose(this.workPlane.position, this.workPlane.quaternion, unitScale);
    this.workPlane.scale.set(this.planeSize * 2, this.planeSize * 2, 1);
    this.workPlane.matrixAutoUpdate = true;
    this.workPlane.visible = state.workPlaneVisible;
    (this.workPlane.material as THREE.MeshBasicMaterial).opacity = state.selection?.kind === 'workplane' ? 0.3 : 0.16;
    // Outline the selected layer, node or body.
    const outlined =
      state.selection?.kind === 'layer' ? this.layers.get(state.selection.id) : state.selection?.kind === 'node' ? this.nodes.get(state.selection.nodeId) : state.selection?.kind === 'body' ? this.bodies.get(state.selection.id) : undefined;
    if (outlined && this.isShown(outlined)) {
      this.selectionBox.setFromObject(outlined);
      this.selectionBox.visible = true;
    } else {
      this.selectionBox.visible = false;
    }
    for (const camera of state.cameras) {
      let object = this.cameras.get(camera.id);
      if (!object) {
        object = new CameraObject(camera.id);
        this.cameras.set(camera.id, object);
        this.scene.add(object.group);
      }
      const selected = state.selection?.kind === 'camera' && state.selection.id === camera.id ? state.selection.part : null;
      object.sync(camera, selected);
      object.group.visible = camera.visible;
    }
    for (const [id, object] of this.cameras) {
      if (state.cameras.some((camera) => camera.id === id)) continue;
      object.dispose();
      this.cameras.delete(id);
    }
    this.emit();
  }

  layerObject(id: string): THREE.Object3D | null {
    return this.layers.get(id) ?? null;
  }

  bodyObject(id: string): THREE.Mesh | null {
    return this.bodies.get(id) ?? null;
  }

  setWorkPlaneMarkers(points: readonly [number, number, number][], hoverPoint?: [number, number, number] | null): void {
    while (this.workPlaneSetupGroup.children.length > 0) {
      const child = this.workPlaneSetupGroup.children[0]!;
      this.workPlaneSetupGroup.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry?.dispose();
      }
    }

    if (points.length === 0 && !hoverPoint) {
      this.emit();
      return;
    }

    const sphereGeo = new THREE.SphereGeometry(6, 16, 16);
    const p1Mat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false });
    const p2Mat = new THREE.MeshBasicMaterial({ color: 0xff9100, depthTest: false });
    const p3Mat = new THREE.MeshBasicMaterial({ color: 0x00e676, depthTest: false });
    const hoverMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false });

    points.forEach((pt, idx) => {
      const mat = idx === 0 ? p1Mat : idx === 1 ? p2Mat : p3Mat;
      const marker = new THREE.Mesh(sphereGeo, mat);
      marker.position.set(pt[0], pt[1], pt[2]);
      marker.renderOrder = 999;
      this.workPlaneSetupGroup.add(marker);
    });

    if (points.length >= 2) {
      const p1 = points[0]!;
      const p2 = points[1]!;
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p1[0], p1[1], p1[2]),
        new THREE.Vector3(p2[0], p2[1], p2[2]),
      ]);
      const lineMat = new THREE.LineDashedMaterial({ color: 0xff9100, dashSize: 20, gapSize: 10, depthTest: false });
      const line = new THREE.Line(lineGeo, lineMat);
      line.computeLineDistances();
      line.renderOrder = 998;
      this.workPlaneSetupGroup.add(line);
    }

    if (hoverPoint) {
      const hoverMarker = new THREE.Mesh(sphereGeo, hoverMat);
      hoverMarker.position.set(hoverPoint[0], hoverPoint[1], hoverPoint[2]);
      hoverMarker.renderOrder = 999;
      this.workPlaneSetupGroup.add(hoverMarker);

      if (points.length >= 1) {
        const last = points[points.length - 1]!;
        const guideGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(last[0], last[1], last[2]),
          new THREE.Vector3(hoverPoint[0], hoverPoint[1], hoverPoint[2]),
        ]);
        const guideMat = new THREE.LineDashedMaterial({ color: 0x00e5ff, dashSize: 15, gapSize: 8, depthTest: false });
        const guideLine = new THREE.Line(guideGeo, guideMat);
        guideLine.computeLineDistances();
        guideLine.renderOrder = 998;
        this.workPlaneSetupGroup.add(guideLine);
      }
    }

    this.emit();
  }

  /** Places every body (position, Euler rotation in degrees) and gives it its material. */
  private syncBodies(bodies: Body[], materials: Record<string, PbrMaterial>): void {
    let moved = false;
    for (const body of bodies) {
      const mesh = this.bodies.get(body.id);
      if (!mesh) continue;
      const [x, y, z] = body.placement.position;
      const [rx, ry, rz] = body.placement.rotation.map(THREE.MathUtils.degToRad) as [number, number, number];
      const [sx, sy, sz] = body.placement.scale ?? [1, 1, 1];
      if (mesh.position.x !== x || mesh.position.y !== y || mesh.position.z !== z || mesh.rotation.x !== rx || mesh.rotation.y !== ry || mesh.rotation.z !== rz || mesh.scale.x !== sx || mesh.scale.y !== sy || mesh.scale.z !== sz) {
        mesh.position.set(x, y, z);
        // World X, then Y, then Z: the same convention the kernel uses for placements.
        mesh.rotation.set(rx, ry, rz, 'ZYX');
        mesh.scale.set(sx, sy, sz);
        moved = true;
      }
      mesh.visible = body.visible;
      const material = this.pbrMaterial(body.material, materials[body.material]);
      if (mesh.userData['originalMaterial'] !== material) {
        // The style swap restores `originalMaterial`, so the new material has to go there too.
        mesh.userData['originalMaterial'] = material;
        if (this.styled === 'realistic') mesh.material = material;
      }
    }
    if (moved) {
      this.planeSize = planeHalfSize(this.bounds());
      this.applyPlaneSize();
    }
  }

  private pbrMaterial(id: string, source: PbrMaterial | undefined): THREE.MeshStandardMaterial {
    let material = this.pbrMaterials.get(id);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ name: id });
      this.pbrMaterials.set(id, material);
    }
    const color = source?.color ?? '#9a9aa3';
    const opacity = source?.opacity ?? 1;
    if (material.color.getHexString() !== color.replace('#', '').toLowerCase() || material.roughness !== (source?.roughness ?? 0.8) || material.metalness !== (source?.metalness ?? 0) || material.opacity !== opacity) {
      material.color.set(color);
      material.roughness = source?.roughness ?? 0.8;
      material.metalness = source?.metalness ?? 0;
      material.opacity = opacity;
      material.transparent = opacity < 1;
      material.name = source?.name ?? id;
      material.needsUpdate = true;
    }
    return material;
  }

  /** Replaces (or creates) the mesh of a body from the kernel's arrays; placement comes from sync. */
  setBodyMesh(id: string, data: MeshData): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    let mesh = this.bodies.get(id);
    if (mesh) {
      (mesh.geometry as THREE.BufferGeometry).dispose();
      mesh.geometry = geometry;
      const oldEdges = mesh.userData['edges'] as THREE.LineSegments | undefined;
      if (oldEdges) {
        mesh.remove(oldEdges);
        oldEdges.geometry.dispose();
        delete mesh.userData['edges'];
      }
    } else {
      mesh = new THREE.Mesh(geometry, this.pbrMaterial('default', undefined));
      mesh.name = id;
      mesh.userData['bodyId'] = id;
      mesh.userData['faceIds'] = data.faceIds;
      this.bodies.set(id, mesh);
      this.content.add(mesh);
    }
    mesh.userData['faceIds'] = data.faceIds;
    mesh.userData['runs'] = data.runs;
    mesh.userData['meshData'] = data;

    // Attach face-dividing segment lines so topology is clearly visible
    const edges = this.buildFaceDividingEdges(mesh, data);
    mesh.add(edges);
    mesh.userData['edges'] = edges;
    edges.visible = this.styled !== 'wireframe';

    // Highlights were built for the old geometry.
    for (const kind of ['hover', 'selected'] as const) {
      const highlight = this.faceHighlights[kind];
      if (highlight?.bodyId === id) this.setFaceHighlight(kind, null);
    }
    this.planeSize = planeHalfSize(this.bounds());
    this.applyPlaneSize();
    this.emit();
  }

  /** Builds segment lines dividing faces of the body mesh (face boundaries + feature creases). */
  private buildFaceDividingEdges(mesh: THREE.Mesh, data: MeshData): THREE.LineSegments {
    const edgeMap = new Map<string, { a: [number, number, number]; b: [number, number, number]; faces: Set<number> }>();
    const pos = data.positions;
    const point = (index: number): [number, number, number] => [pos[index * 3]!, pos[index * 3 + 1]!, pos[index * 3 + 2]!];
    const pointKey = (value: [number, number, number]) => value.map((axis) => Math.round(axis * 10_000)).join(',');
    const addEdge = (a: number, b: number, faceId: number) => {
      const pa = point(a);
      const pb = point(b);
      const ka = pointKey(pa);
      const kb = pointKey(pb);
      const key = ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`;
      let item = edgeMap.get(key);
      if (!item) {
        item = ka < kb ? { a: pa, b: pb, faces: new Set() } : { a: pb, b: pa, faces: new Set() };
        edgeMap.set(key, item);
      }
      item.faces.add(faceId);
    };

    for (let t = 0; t < data.triangles; t++) {
      const faceId = data.faceIds[t] ?? 0;
      const i0 = data.indices[t * 3]!;
      const i1 = data.indices[t * 3 + 1]!;
      const i2 = data.indices[t * 3 + 2]!;
      addEdge(i0, i1, faceId);
      addEdge(i1, i2, faceId);
      addEdge(i2, i0, faceId);
    }

    const featureEdges = new THREE.EdgesGeometry(mesh.geometry as THREE.BufferGeometry, 15);
    const featurePositions = featureEdges.attributes['position'];
    const points: number[] = [];

    for (const { a, b, faces } of edgeMap.values()) {
      if (faces.size > 1) {
        points.push(...a, ...b);
      }
    }

    if (featurePositions) {
      for (let i = 0; i < featurePositions.count; i += 2) {
        points.push(
          featurePositions.getX(i), featurePositions.getY(i), featurePositions.getZ(i),
          featurePositions.getX(i + 1), featurePositions.getY(i + 1), featurePositions.getZ(i + 1),
        );
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const lines = new THREE.LineSegments(geometry, EDGE_MATERIAL);
    lines.raycast = () => {};
    lines.renderOrder = 2;
    return lines;
  }

  removeBody(id: string): void {
    const mesh = this.bodies.get(id);
    if (!mesh) return;
    this.content.remove(mesh);
    this.bodies.delete(id);
    (mesh.geometry as THREE.BufferGeometry).dispose();
    const edges = mesh.userData['edges'] as THREE.LineSegments | undefined;
    edges?.geometry.dispose();
    this.planeSize = planeHalfSize(this.bounds());
    this.applyPlaneSize();
    this.emit();
  }

  /** Low LOD shows only the layers and nodes flagged for it; `applyLod(false, …)` restores visibility. */
  applyLod(low: boolean, layers: Layer[], bodies: Body[] = []): void {
    for (const body of bodies) {
      const mesh = this.bodies.get(body.id);
      if (mesh) mesh.visible = body.visible && (!low || body.lowLod);
    }
    for (const layer of layers) {
      const object = this.layers.get(layer.id);
      if (object) object.visible = layer.visible && (!low || layer.lowLod);
      const visit = (nodes: LayerNode[]) => {
        for (const node of nodes) {
          const target = this.nodes.get(node.id);
          if (target) target.visible = node.visible && (!low || node.lowLod);
          visit(node.children);
        }
      };
      visit(layer.nodes);
    }
  }

  /** Objects a 3D pane can pick: visible planes, visible camera parts, the model and (optionally) the sketch fills. */
  pickables(withSketches = false): THREE.Object3D[] {
    const list: THREE.Object3D[] = [...this.planes.values()].filter((mesh) => mesh.visible);
    if (this.workPlane.visible) list.push(this.workPlane);
    for (const camera of this.cameras.values()) if (camera.group.visible) list.push(camera.body, camera.aim);
    list.push(this.content);
    if (withSketches) list.push(this.sketchLayer);
    return list;
  }

  /** The kernel arrays of a body's current mesh (positions in the body's frame), for face outlines. */
  bodyMeshData(id: string): MeshData | null {
    return (this.bodies.get(id)?.userData['meshData'] as MeshData | undefined) ?? null;
  }

  /** Highlights one face of a body (the triangles sharing its face id), or clears the highlight. */
  setFaceHighlight(kind: 'hover' | 'selected', face: { bodyId: string; faceId: number } | null): void {
    const current = this.faceHighlights[kind];
    if (current && face && current.bodyId === face.bodyId && current.faceId === face.faceId) return;
    if (current) {
      current.mesh.removeFromParent();
      current.mesh.geometry.dispose();
      this.faceHighlights[kind] = null;
    }
    const body = face ? this.bodies.get(face.bodyId) : null;
    const data = face ? this.bodyMeshData(face.bodyId) : null;
    if (!face || !body || !data) {
      this.emit();
      return;
    }
    const indices: number[] = [];
    for (let t = 0; t < data.triangles; t++) if (data.faceIds[t] === face.faceId) indices.push(data.indices[t * 3]!, data.indices[t * 3 + 1]!, data.indices[t * 3 + 2]!);
    if (indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', body.geometry.getAttribute('position'));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, kind === 'hover' ? SKETCH_MATERIALS.faceHover : SKETCH_MATERIALS.faceSelected);
    mesh.renderOrder = 11;
    mesh.raycast = () => {};
    mesh.userData['overlay'] = true;
    body.add(mesh);
    this.faceHighlights[kind] = { mesh, bodyId: face.bodyId, faceId: face.faceId };
    this.emit();
  }

  /**
   * Runs `fn` with the body materials double-sided, so a ray cast in a section view (which looks
   * at back faces below the cut) still hits bodies. Restored before anything renders.
   */
  withDoubleSidedBodies<T>(fn: () => T): T {
    const sides = new Map<THREE.Material, THREE.Side>();
    for (const material of this.pbrMaterials.values()) {
      sides.set(material, material.side);
      material.side = THREE.DoubleSide;
    }
    try {
      return fn();
    } finally {
      for (const [material, side] of sides) material.side = side;
    }
  }

  /** Rebuilds the overlay of every sketch whose shapes or highlight changed, and the in-progress preview. */
  private syncSketches(
    sketches: Sketch[],
    selection: Selection,
    selectionSet: SelectedItem[],
    preview: SketchPreview | null,
    hovered: { sketchId: string; shapeId: string } | null,
    loopCheck: LoopCheckPreview | null,
    /** Sketch edit mode: the edited sketch; the others are drawn faded and cannot be picked. */
    editing: string | null = null,
  ): void {
    const items = selectionSet.length ? selectionSet : (selection ? [selection] : []);
    const selectedSketches = new Set(items.flatMap((item) => item.kind === 'sketch' ? [item.id] : item.kind === 'shape' || item.kind === 'curve-point' || item.kind === 'loop' ? [item.sketchId] : []));
    const selectedShapes = new Set(items.flatMap((item) => item.kind === 'shape' || item.kind === 'curve-point' ? [item.shapeId] : item.kind === 'loop' ? item.shapeIds : []));
    const present = new Set<string>();
    for (const sketch of sketches) {
      present.add(sketch.id);
      const key = JSON.stringify([sketch.shapes, sketch.plane, sketch.visible, selectedSketches.has(sketch.id), [...selectedShapes], selection?.kind === 'curve-point' ? selection.pointIndex : null, hovered, loopCheck, editing]);
      if (this.sketchKeys.get(sketch.id) === key) continue;
      this.sketchKeys.set(sketch.id, key);
      const old = this.sketchGroups.get(sketch.id);
      if (old) disposeGroup(old);
      const group = this.planeGroup(sketch.plane);
      group.visible = sketch.visible;
      group.userData['sketchId'] = sketch.id;
      if (editing && editing !== sketch.id) {
        // Locked while another sketch is edited: faded reference lines, still snapped to.
        for (const shape of sketch.shapes) {
          const line = shapeLine(shape, SKETCH_MATERIALS.lineFaded);
          line.renderOrder = 14;
          group.add(line);
        }
        this.sketchGroups.set(sketch.id, group);
        this.sketchLayer.add(group);
        continue;
      }
      for (const shape of sketch.shapes) {
        const highlighted = selectedShapes.has(shape.id) || (selectedSketches.has(sketch.id) && items.some((item) => item.kind === 'sketch' && item.id === sketch.id));
        const hoveredHere = hovered?.sketchId === sketch.id && hovered.shapeId === shape.id;
        const checked = loopCheck?.sketchId === sketch.id && loopCheck.shapeIds.includes(shape.id);
        const material = checked
          ? loopCheck.closed ? SKETCH_MATERIALS.lineLoopClosed : SKETCH_MATERIALS.lineLoopOpen
          : highlighted ? SKETCH_MATERIALS.lineSelected
          : hoveredHere ? SKETCH_MATERIALS.lineHover
          : selectedSketches.has(sketch.id) ? SKETCH_MATERIALS.lineSketch : SKETCH_MATERIALS.line;
        const line = shapeLine(shape, material);
        line.userData['sketchId'] = sketch.id;
        line.userData['shapeId'] = shape.id;
        line.renderOrder = checked || highlighted || hoveredHere ? 20 : 15;
        group.add(line);
        if ((highlighted || hoveredHere) && shape.kind === 'polyline') {
          const points = shapePoints(shape, highlighted ? SKETCH_MATERIALS.pointSelected : SKETCH_MATERIALS.pointHover);
          if (points) group.add(points);
          if (selection?.kind === 'curve-point' && selection.shapeId === shape.id && selection.sketchId === sketch.id) {
            const point = shape.points[selection.pointIndex];
            if (point) {
              const active = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(point[0], point[1], SKETCH_LIFT + 2)]), SKETCH_MATERIALS.pointActive);
              active.renderOrder = 31;
              group.add(active);
            }
          }
        }
        if (highlighted) {
          // Grips: corners / quadrants as the vertex squares do, mids of segments and sides smaller.
          const grips = shapeGrips(shape);
          const ends = grips.filter((grip) => shape.kind !== 'polyline' && (grip.kind === 'corner' || grip.kind === 'radius'));
          const mids = grips.filter((grip) => grip.kind === 'segment' || grip.kind === 'side' || grip.kind === 'bulge');
          if (ends.length) {
            const object = new THREE.Points(new THREE.BufferGeometry().setFromPoints(ends.map(({ point }) => new THREE.Vector3(point[0], point[1], SKETCH_LIFT + 0.5))), SKETCH_MATERIALS.pointSelected);
            object.renderOrder = 21;
            group.add(object);
          }
          if (mids.length) {
            const object = new THREE.Points(new THREE.BufferGeometry().setFromPoints(mids.map(({ point }) => new THREE.Vector3(point[0], point[1], SKETCH_LIFT + 0.5))), SKETCH_MATERIALS.gripMid);
            object.renderOrder = 21;
            group.add(object);
          }
          const handles = grips.filter((grip): grip is Extract<typeof grip, { kind: 'handle' }> => grip.kind === 'handle');
          if (handles.length && shape.kind === 'polyline') {
            const n = shape.points.length;
            const ties: THREE.Vector3[] = [];
            for (const grip of handles) {
              const node = shape.points[grip.end === 0 ? grip.index : (grip.index + 1) % n]!;
              ties.push(new THREE.Vector3(node[0], node[1], SKETCH_LIFT + 0.4), new THREE.Vector3(grip.point[0], grip.point[1], SKETCH_LIFT + 0.4));
            }
            const tie = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ties), SKETCH_MATERIALS.handleTie);
            tie.renderOrder = 21;
            group.add(tie);
            const object = new THREE.Points(new THREE.BufferGeometry().setFromPoints(handles.map(({ point }) => new THREE.Vector3(point[0], point[1], SKETCH_LIFT + 0.5))), SKETCH_MATERIALS.gripHandle);
            object.renderOrder = 22;
            group.add(object);
          }
        }
        const fill = shapeFill(shape, highlighted ? SKETCH_MATERIALS.fillSelected : SKETCH_MATERIALS.fill);
        if (fill) {
          fill.userData['sketchId'] = sketch.id;
          fill.userData['shapeId'] = shape.id;
          group.add(fill);
        }
      }
      if (loopCheck?.sketchId === sketch.id && loopCheck.openings.length > 0) {
        for (const [u, v] of loopCheck.openings) {
          const dot = new THREE.Points(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(u, v, SKETCH_LIFT + 1)]),
            SKETCH_MATERIALS.pointOpen,
          );
          dot.renderOrder = 30;
          group.add(dot);

          const ringPoints: THREE.Vector3[] = [];
          const radius = 24;
          for (let a = 0; a <= 32; a++) {
            const angle = (a / 32) * Math.PI * 2;
            ringPoints.push(new THREE.Vector3(u + Math.cos(angle) * radius, v + Math.sin(angle) * radius, SKETCH_LIFT + 0.9));
          }
          const ring = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(ringPoints),
            new THREE.LineBasicMaterial({ color: 0xef4444, depthTest: false }),
          );
          ring.renderOrder = 29;
          group.add(ring);
        }
      }
      this.sketchGroups.set(sketch.id, group);
      this.sketchLayer.add(group);
    }
    for (const [id, group] of this.sketchGroups) {
      if (present.has(id)) continue;
      disposeGroup(group);
      this.sketchGroups.delete(id);
      this.sketchKeys.delete(id);
    }
    // The preview: the shape being drawn and the snap marker, rebuilt every time (it is tiny).
    if (this.previewGroup) {
      disposeGroup(this.previewGroup);
      this.previewGroup = null;
    }
    this.highlights.set('snap', preview?.inference?.target ?? null);
    if (preview) {
      const group = this.planeGroup(preview.plane);
      if (preview.shape) group.add(shapeLine(preview.shape, SKETCH_MATERIALS.linePreview));
      for (const ghost of preview.shapes ?? []) group.add(shapeLine(ghost, SKETCH_MATERIALS.linePreview));
      if (preview.guide) {
        const guide = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(...preview.guide.from, SKETCH_LIFT),
            new THREE.Vector3(...preview.guide.to, SKETCH_LIFT),
          ]),
          SKETCH_MATERIALS.guide,
        );
        guide.computeLineDistances();
        guide.renderOrder = 19;
        group.add(guide);
      }
      if (preview.snap) {
        group.add(snapMarker(preview.snap, preview.inference?.type ?? 'grid'));
      }
      this.previewGroup = group;
      this.sketchLayer.add(group);
    }
  }

  /** An empty group whose local frame is the sketch plane (u, v, normal). */
  private planeGroup(plane: SketchPlane): THREE.Group {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(planeMatrix(plane));
    group.matrixWorldNeedsUpdate = true;
    return group;
  }


  /** 2D panes draw sketches through the model (they are the drawing surface); 3D panes respect depth. */
  setSketchXray(xray: boolean): void {
    for (const material of [SKETCH_MATERIALS.line, SKETCH_MATERIALS.lineSelected, SKETCH_MATERIALS.lineHover, SKETCH_MATERIALS.lineLoopClosed, SKETCH_MATERIALS.lineLoopOpen, SKETCH_MATERIALS.lineSketch, SKETCH_MATERIALS.lineFaded, SKETCH_MATERIALS.linePreview, SKETCH_MATERIALS.fill, SKETCH_MATERIALS.fillSelected, SKETCH_MATERIALS.pointSelected, SKETCH_MATERIALS.pointHover, SKETCH_MATERIALS.pointOpen, ...SNAP_MATERIALS]) {
      if (material.depthTest !== !xray) material.depthTest = !xray;
    }
  }

  /**
   * The extrude tool's profile regions: picked faces tinted green (openings stay clear), faces
   * left out dashed, loose line ends and dangling tails red, crossings amber.
   */
  setProfileRegions(overlays: readonly ProfileRegionOverlay[]): void {
    if (this.regionGroup) {
      disposeGroup(this.regionGroup);
      this.regionGroup = null;
    }
    if (!overlays.length) return;
    const root = new THREE.Group();
    const lift = SKETCH_LIFT + 1.5;
    for (const overlay of overlays) {
      const group = this.planeGroup(overlay.plane);
      const picked = new Set(overlay.picked.map((face) => face.index));
      for (const face of overlay.arrangement.faces) {
        if (picked.has(face.index)) {
          const shape = new THREE.Shape(face.outer.map(([u, v]) => new THREE.Vector2(u, v)));
          for (const hole of face.holes) shape.holes.push(new THREE.Path(hole.map(([u, v]) => new THREE.Vector2(u, v))));
          const geometry = new THREE.ShapeGeometry(shape);
          geometry.translate(0, 0, lift);
          const fill = new THREE.Mesh(geometry, REGION_MATERIALS.picked);
          fill.renderOrder = 18;
          group.add(fill);
          const outline = ringLine(face.outer, REGION_MATERIALS.outline, lift);
          outline.renderOrder = 22;
          group.add(outline);
        } else {
          const outline = ringLine(face.outer, REGION_MATERIALS.skipped, lift);
          outline.renderOrder = 22;
          group.add(outline);
        }
      }
      for (const [a, b] of overlay.arrangement.dangling) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], a[1], lift), new THREE.Vector3(b[0], b[1], lift)]), REGION_MATERIALS.dangling);
        line.computeLineDistances();
        line.renderOrder = 23;
        group.add(line);
      }
      if (overlay.arrangement.faces.length && overlay.arrangement.openEnds.length) {
        const ends = new THREE.Points(new THREE.BufferGeometry().setFromPoints(overlay.arrangement.openEnds.map(([u, v]) => new THREE.Vector3(u, v, lift + 0.5))), REGION_MATERIALS.openEnd);
        ends.renderOrder = 30;
        group.add(ends);
      }
      if (overlay.arrangement.crossings.length) {
        const crossings = new THREE.Points(new THREE.BufferGeometry().setFromPoints(overlay.arrangement.crossings.map(([u, v]) => new THREE.Vector3(u, v, lift + 0.5))), REGION_MATERIALS.crossing);
        crossings.renderOrder = 30;
        group.add(crossings);
      }
      root.add(group);
    }
    this.regionGroup = root;
    this.sketchLayer.add(root);
  }

  /** The translucent extrude preview (world space), or none. */
  setPreviewMesh(data: MeshData | null, cut: boolean): void {
    if (this.previewMesh) {
      (this.previewMesh.geometry as THREE.BufferGeometry).dispose();
      this.previewMesh.removeFromParent();
      this.previewMesh = null;
    }
    if (data) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      this.previewMesh = new THREE.Mesh(geometry, cut ? SKETCH_MATERIALS.previewCut : SKETCH_MATERIALS.preview);
      this.previewMesh.renderOrder = 12;
      this.scene.add(this.previewMesh);
    }
    this.emit();
  }

  /** Parses a GLB, grounds it on the origin and adds it as a layer with its node tree. */
  async importModel(bytes: ArrayBuffer, fileName: string, id: string, scale = 1000): Promise<Layer> {
    const object = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, '')).scene;
    let meshes = 0;
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) meshes++;
    });
    if (meshes === 0) throw new Error(`${fileName} contains no geometry`);
    object.name = fileName;
    this.layers.set(id, object);
    this.content.add(object);
    object.userData['layerId'] = id;
    const nodes = object.children.map((child, index) => this.registerNode(child, id, `${id}/${index}`));
    const size = this.setLayerScale(id, scale);
    return { id, name: fileName.replace(/\.(glb|gltf)$/i, ''), visible: true, scale, size, lowLod: false, nodes };
  }

  private registerNode(object: THREE.Object3D, layerId: string, nodeId: string): LayerNode {
    this.nodes.set(nodeId, object);
    object.userData['layerId'] = layerId;
    object.userData['nodeId'] = nodeId;
    let triangles = 0;
    let vertices = 0;
    const materials: string[] = [];
    if (object instanceof THREE.Mesh) {
      const geometry = object.geometry as THREE.BufferGeometry;
      vertices = geometry.getAttribute('position')?.count ?? 0;
      triangles = Math.round((geometry.index ? geometry.index.count : vertices) / 3);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.push(material.name || material.type);
    }
    return {
      id: nodeId,
      name: object.name || (object instanceof THREE.Mesh ? 'Mesh' : 'Node'),
      visible: true,
      lowLod: false,
      triangles,
      vertices,
      materials,
      children: object.children.map((child, index) => this.registerNode(child, layerId, `${nodeId}/${index}`)),
    };
  }

  /** Rescales a layer and re-grounds it (centred in plan, resting on the ground); returns its size. */
  setLayerScale(id: string, scale: number): [number, number, number] {
    const object = this.layers.get(id);
    if (!object) return [0, 0, 0];
    object.scale.setScalar(scale);
    object.position.set(0, 0, 0);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const centre = box.getCenter(new THREE.Vector3());
    object.position.set(-centre.x, -box.min.y, -centre.z);
    const size = box.getSize(new THREE.Vector3());
    this.planeSize = planeHalfSize(this.bounds());
    this.applyPlaneSize();
    this.emit();
    return [Math.round(size.x), Math.round(size.y), Math.round(size.z)];
  }

  removeLayer(id: string): void {
    const object = this.layers.get(id);
    if (!object) return;
    this.content.remove(object);
    this.layers.delete(id);
    for (const key of [...this.nodes.keys()]) if (key.startsWith(`${id}/`)) this.nodes.delete(key);
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
      }
    });
    this.planeSize = planeHalfSize(this.bounds());
    this.applyPlaneSize();
    this.emit();
  }

  /** Swaps the model's materials for a display style; `applyStyle('realistic')` restores them. */
  applyStyle(style: ViewStyle): void {
    if (style === this.styled) return;
    this.styled = style;
    this.content.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || child.userData['overlay']) return;
      const original = (child.userData['originalMaterial'] as THREE.Material | THREE.Material[] | undefined) ?? child.material;
      child.userData['originalMaterial'] = original;
      const edges = this.edgesOf(child, true);
      if (edges) edges.visible = style !== 'wireframe';
      switch (style) {
        case 'realistic':
          child.material = original;
          break;
        case 'color':
          child.material = Array.isArray(original) ? original.map((material) => this.colorMaterial(material)) : this.colorMaterial(original);
          break;
        case 'shaded':
          child.material = STYLE_MATERIALS.shaded;
          break;
        case 'wireframe':
          child.material = STYLE_MATERIALS.wireframe;
          break;
        case 'hidden-line':
          child.material = STYLE_MATERIALS.hiddenLine;
          break;
      }
    });
  }

  private colorMaterial(original: THREE.Material): THREE.Material {
    let material = this.colorMaterials.get(original);
    if (!material) {
      const source = original as Partial<THREE.MeshStandardMaterial>;
      material = new THREE.MeshBasicMaterial({ color: source.color ?? new THREE.Color(0x9a9aa3), map: source.map ?? null, side: original.side, transparent: original.transparent, opacity: original.opacity });
      this.colorMaterials.set(original, material);
    }
    return material;
  }

  /** Feature & segment edges dividing faces, kept as a child of the mesh. */
  private edgesOf(mesh: THREE.Mesh, create: boolean): THREE.LineSegments | null {
    const existing = mesh.userData['edges'] as THREE.LineSegments | undefined;
    if (existing || !create) return existing ?? null;
    const meshData = mesh.userData['meshData'] as MeshData | undefined;
    const edges = meshData ? this.buildFaceDividingEdges(mesh, meshData) : new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry as THREE.BufferGeometry, 15), EDGE_MATERIAL);
    edges.raycast = () => {};
    mesh.add(edges);
    mesh.userData['edges'] = edges;
    return edges;
  }

  /** Moves an individual vertex of a body mesh by world delta and updates geometry. */
  moveBodyVertex(bodyId: string, vertexIndex: number, delta: [number, number, number]): void {
    const mesh = this.bodies.get(bodyId);
    if (!mesh) return;
    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr || vertexIndex >= posAttr.count) return;
    const invQ = mesh.quaternion.clone().invert();
    const localDelta = new THREE.Vector3(delta[0], delta[1], delta[2]).applyQuaternion(invQ);
    const targetX = posAttr.getX(vertexIndex);
    const targetY = posAttr.getY(vertexIndex);
    const targetZ = posAttr.getZ(vertexIndex);
    const matchingIndices: number[] = [];
    for (let i = 0; i < posAttr.count; i++) {
      const dx = posAttr.getX(i) - targetX;
      const dy = posAttr.getY(i) - targetY;
      const dz = posAttr.getZ(i) - targetZ;
      if (dx * dx + dy * dy + dz * dz < 1e-6) {
        matchingIndices.push(i);
      }
    }
    for (const idx of matchingIndices) {
      posAttr.setXYZ(idx, posAttr.getX(idx) + localDelta.x, posAttr.getY(idx) + localDelta.y, posAttr.getZ(idx) + localDelta.z);
    }
    posAttr.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
    const meshData = mesh.userData['meshData'] as MeshData | undefined;
    if (meshData) {
      for (const idx of matchingIndices) {
        const base = idx * 3;
        const x = meshData.positions[base];
        const y = meshData.positions[base + 1];
        const z = meshData.positions[base + 2];
        if (x !== undefined && y !== undefined && z !== undefined) {
          meshData.positions[base] = x + localDelta.x;
          meshData.positions[base + 1] = y + localDelta.y;
          meshData.positions[base + 2] = z + localDelta.z;
        }
      }
      const oldEdges = mesh.userData['edges'] as THREE.LineSegments | undefined;
      if (oldEdges) {
        mesh.remove(oldEdges);
        oldEdges.geometry.dispose();
      }
      const edges = this.buildFaceDividingEdges(mesh, meshData);
      mesh.add(edges);
      mesh.userData['edges'] = edges;
      edges.visible = this.styled !== 'wireframe';
    }
    this.emit();
  }

  /** Moves an individual line segment (edge) of a body mesh by world delta. */
  moveBodyEdge(bodyId: string, edgeIndex: number, delta: [number, number, number], p1?: [number, number, number], p2?: [number, number, number]): void {
    const mesh = this.bodies.get(bodyId);
    const meshData = mesh?.userData['meshData'] as MeshData | undefined;
    if (!mesh || !meshData) return;
    if (p1 && p2) {
      const pos = meshData.positions;
      let v1 = 0;
      let v2 = 0;
      let d1 = Infinity;
      let d2 = Infinity;
      for (let v = 0; v < pos.length / 3; v++) {
        const vx = pos[v * 3]!;
        const vy = pos[v * 3 + 1]!;
        const vz = pos[v * 3 + 2]!;
        const dist1 = Math.hypot(vx - p1[0], vy - p1[1], vz - p1[2]);
        const dist2 = Math.hypot(vx - p2[0], vy - p2[1], vz - p2[2]);
        if (dist1 < d1) { d1 = dist1; v1 = v; }
        if (dist2 < d2) { d2 = dist2; v2 = v; }
      }
      this.moveBodyVertex(bodyId, v1, delta);
      this.moveBodyVertex(bodyId, v2, delta);
      return;
    }
    const i0 = meshData.indices[edgeIndex * 2] ?? 0;
    const i1 = meshData.indices[edgeIndex * 2 + 1] ?? 1;
    this.moveBodyVertex(bodyId, i0, delta);
    this.moveBodyVertex(bodyId, i1, delta);
  }
}

export const modelingScene = new ModelingScene();
