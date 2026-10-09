/**
 * A three.js viewport over the document. It rebuilds its scene from the document (see
 * ./geometry.ts), shares the board's selection, and turns gizmo drags into the same commands
 * the 2D board dispatches, so both views edit one model and one undo history.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ArchaiDocument } from '@/document';
import { materialById } from '@/materials/slots';
import { onMaterialTextures } from '@/materials/three';
import { drawHatchTile, graphicsResolver, hatchKey, type GraphicsOverrides, type GraphicsResolver, type HatchSpec } from '@/graphics';
import { boundsOfIds } from '@/geometry';
import { tileGrid } from '@/export/quality';
import { buildScene, instanceElevationOf, sceneCentre, sceneHeight, type Built } from './geometry';
import { prepareMassing } from '@/analysis/massing';
import { prepareParametric } from './parametricModels';
import { modelStore, textureStore } from './assets';
import { edgesOf } from './edges';
import { meshStore } from './meshes';
import { AnalysisLayer, type AnalysisSample } from '@/analysis/layer3d';
import { isAnalysisElement, type AnalysisSpec } from '@/analysis/model';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  /** Orthographic zoom (section views and orthographic 3D). */
  zoom?: number;
  /** Perspective FOV (camera views). */
  fov?: number;
  /** Section/plan views: the cut's centre when this camera was saved. */
  cut?: [number, number];
}

export type ViewStyle = 'realistic' | 'wireframe' | 'shaded' | 'consistent' | 'section' | 'hidden-line';

/** A vertical cut through the model: a plan point on the cut line and the line's direction. */
export interface SectionCut {
  x: number;
  y: number;
  /** Degrees, clockwise from +x (document convention). The view looks along the right-hand normal. */
  angle: number;
  /** Length of the cut line: the section shows only what lies between its ends. */
  length?: number;
  /** How far behind the cut is shown (millimetres); 0 / undefined = everything. */
  depth?: number;
  /**
   * A level's plan instead of a vertical cut: a horizontal cut `cutHeight` above the level's
   * `elevation`, cropped to a `width` × `height` region centred on (x, y) and turned by `angle`;
   * `depth` is then how far below the cut is shown.
   */
  plan?: PlanCut;
}

export interface PlanCut {
  elevation: number;
  cutHeight: number;
  width: number;
  height: number;
}

/** Clipping planes of a level plan: above the cut, outside the region and (optionally) below its depth. */
function planPlanes(section: SectionCut, plan: PlanCut): THREE.Plane[] {
  const top = plan.elevation + plan.cutHeight;
  // Keep what lies below the cut (the direction we look).
  const planes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), top)];
  const r = (section.angle * Math.PI) / 180;
  const origin = new THREE.Vector3(section.x, 0, section.y);
  const axes: Array<[THREE.Vector3, number]> = [
    [new THREE.Vector3(Math.cos(r), 0, Math.sin(r)), plan.width / 2],
    [new THREE.Vector3(-Math.sin(r), 0, Math.cos(r)), plan.height / 2],
  ];
  for (const [axis, half] of axes) {
    const a = origin.clone().sub(axis.clone().multiplyScalar(half));
    const b = origin.clone().add(axis.clone().multiplyScalar(half));
    planes.push(new THREE.Plane(axis.clone(), -axis.dot(a)), new THREE.Plane(axis.clone().negate(), axis.dot(b)));
  }
  if (section.depth && section.depth > 0) planes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(top - section.depth)));
  return planes;
}

/** Clipping planes of a cut: in front of it, beyond its two ends and (optionally) past its depth. */
function sectionPlanes(section: SectionCut): THREE.Plane[] {
  if (section.plan) return planPlanes(section, section.plan);
  const r = (section.angle * Math.PI) / 180;
  const along = new THREE.Vector3(Math.cos(r), 0, Math.sin(r));
  // Right-hand normal of the cut line in plan (y down) → scene (x, z).
  const normal = new THREE.Vector3(-Math.sin(r), 0, Math.cos(r));
  const origin = new THREE.Vector3(section.x, 0, section.y);
  // Keep what lies on the far side of the plane (the direction we look).
  const planes = [new THREE.Plane(normal.clone(), -normal.dot(origin))];
  if (section.length && section.length > 0) {
    const half = section.length / 2;
    const a = origin.clone().sub(along.clone().multiplyScalar(half));
    const b = origin.clone().add(along.clone().multiplyScalar(half));
    planes.push(new THREE.Plane(along.clone(), -along.dot(a)), new THREE.Plane(along.clone().negate(), along.dot(b)));
  }
  if (section.depth && section.depth > 0) {
    const far = origin.clone().add(normal.clone().multiplyScalar(section.depth));
    planes.push(new THREE.Plane(normal.clone().negate(), normal.dot(far)));
  }
  return planes;
}

const HIGHLIGHT = new THREE.Color(0x2f6fed);

/** Size of the plane that carries a cut surface: large enough to cover any framed section. */
const CAP_SIZE = 1_000_000;

/**
 * Which type's cut-surface graphics a mesh's `cutKey` maps to: the type id and, for walls and
 * windows, the part-specific fill parameter.
 */
function cutSpec(key: string, g: GraphicsResolver, style: ViewStyle): HatchSpec | null {
  const [type, part] = key.split(':');
  const typeId = type ?? 'section';
  const fillId = typeId === 'wall' ? (part === 'core' ? 'cut.coreFill' : 'cut.finishFill') : typeId === 'window' && part === 'glass' ? 'cut.glass' : 'cut.fill';
  const hatchId = typeId === 'wall' ? (part === 'core' ? 'cut.coreHatch' : null) : typeId === 'window' ? null : 'cut.hatch';
  const fill = g.color(typeId, 'section', style, fillId) ?? g.color('section', 'section', style, 'cut.fill');
  if (!fill) return null;
  // Types without their own hatch settings borrow the section's.
  const hatchType = hatchId && g.get(typeId, 'section', style, 'cut.hatchColor') !== null ? typeId : 'section';
  return {
    pattern: hatchId ? g.hatch(typeId, 'section', style, hatchId) : 'none',
    fill,
    color: g.color(hatchType, 'section', style, 'cut.hatchColor') ?? '#3a3a3f',
    spacing: g.number(hatchType, 'section', style, 'cut.hatchSpacing') || 120,
    angle: g.number(hatchType, 'section', style, 'cut.hatchAngle'),
  };
}

const STENCIL_BASE = { depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc } as const;

/** Segments where `mesh`'s triangles cross `plane`, in world space (flat xyz pairs). */
function collectCutSegments(mesh: THREE.Mesh, plane: THREE.Plane, out: number[]): void {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return;
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const corners = [a, b, c];
  const distances = [0, 0, 0];
  const hit: THREE.Vector3[] = [];
  const at = (i: number, target: THREE.Vector3) => target.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
  for (let i = 0; i + 2 < count; i += 3) {
    at(i, a);
    at(i + 1, b);
    at(i + 2, c);
    for (let k = 0; k < 3; k++) distances[k] = plane.distanceToPoint(corners[k]!);
    hit.length = 0;
    for (let k = 0; k < 3; k++) {
      const p = corners[k]!;
      const q = corners[(k + 1) % 3]!;
      const dp = distances[k]!;
      const dq = distances[(k + 1) % 3]!;
      if ((dp < 0 && dq >= 0) || (dp >= 0 && dq < 0)) {
        const t = dp / (dp - dq);
        hit.push(new THREE.Vector3().lerpVectors(p, q, t));
      }
    }
    if (hit.length === 2) out.push(hit[0]!.x, hit[0]!.y, hit[0]!.z, hit[1]!.x, hit[1]!.y, hit[1]!.z);
  }
}

/**
 * A blue-tinted copy of a material for the selection: lit materials glow, unlit ones (hidden
 * line, colours, wireframe) are tinted directly so the selection reads in every view style.
 */
function highlightMaterial(base: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
  if (Array.isArray(base)) return base.map((material) => highlightMaterial(material) as THREE.Material);
  const copy = base.clone();
  if ('emissive' in copy && (copy as THREE.MeshStandardMaterial).emissive) {
    const lit = copy as THREE.MeshStandardMaterial;
    lit.emissive = HIGHLIGHT.clone();
    lit.emissiveIntensity = 0.35;
  } else if ('color' in copy && (copy as THREE.MeshBasicMaterial).color) {
    const unlit = copy as THREE.MeshBasicMaterial;
    unlit.color = unlit.wireframe ? HIGHLIGHT.clone() : new THREE.Color(0xcfdcff);
  }
  return copy;
}

function disposeMaterials(material: THREE.Material | THREE.Material[]): void {
  for (const item of Array.isArray(material) ? material : [material]) item.dispose();
}

/**
 * What a paint click changes: one face (surface), the clicked part (slot), the whole object
 * (every slot), or the clicked material everywhere it shows.
 */
export type { PaintScope } from '@/materials/uiStore';
import type { PaintScope } from '@/materials/uiStore';

/** What a click in 3D hit, for painting: the element, its slot, the surface and the material shown. */
export interface SurfaceTarget {
  elementId: string;
  slot: string | null;
  surface: string | null;
  materialId: string | null;
}

/** How one element looks in one render (sheet view frames style elements per view). */
export interface ElementLook {
  color?: string;
  opacity?: number;
  ghost?: boolean;
  hidden?: boolean;
  /** Raised by this many millimetres. */
  lift?: number;
  /** Edge colour drawn over the element. */
  outline?: string;
  /** Emissive accent. */
  glow?: boolean;
  accent?: string;
}

export interface RenderImageOptions {
  /** Render style for this image only. */
  style?: ViewStyle | null;
  background?: string | null;
  overrides?: Readonly<Record<string, ElementLook>>;
  /** Ids drawn with the selection tint (picking inside a sheet view). */
  highlight?: readonly string[];
  /** false leaves the ground grid out (presentation renders). */
  grid?: boolean;
}

/** Mounted views by portal id, so commands (snapshots, PDF export) can reach the live renderer. */
export const mountedViews = new Map<string, SceneView>();

export interface SceneViewEvents {
  /** The user clicked an element (or empty space → null). */
  onSelect: (id: string | null, additive: boolean) => void;
  /** A gizmo drag is in progress / finished. `delta` is a plan-space move; `degrees` a rotation about up. */
  onTransform: (change: { ids: string[]; dx: number; dy: number; dz: number; degrees: number; pivot: { x: number; y: number } }, commit: boolean) => void;
  onCameraChange: (camera: CameraState) => void;
  onOpen?: () => void;
  /** VR stop placement (see setPlacingStop): a click landed on a floor, or on nothing usable. */
  onPlaceStop?: (stop: { x: number; y: number; elevation: number; heading: number }) => void;
  onPlaceMiss?: () => void;
  /** Paint mode (see setPainting): a surface was clicked (`slot` mode with Shift), or Alt-clicked to pick its material. */
  onPaint?: (target: SurfaceTarget, scope: PaintScope) => void;
  onEyedrop?: (target: SurfaceTarget) => void;
}

/** A clicked surface counts as a floor when its normal is within ~45 degrees of straight up. */
const FLOOR_NORMAL_Y = 0.7;

export class SceneView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private section: SectionCut | null;
  private lod: 'high' | 'low' | null = null;
  /** Accent outlines around the selected objects (visible through walls and in sections). */
  private readonly selectionOutlines = new THREE.Group();
  private analysis: AnalysisLayer | null = null;
  private hasInitialCamera = false;
  private orthoHalfHeight = 3000;
  private readonly controls: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: THREE.Object3D;
  private readonly anchor = new THREE.Object3D();
  private readonly raycaster = new THREE.Raycaster();
  private readonly content = new THREE.Group();
  /** Cut surfaces of a section: one capping plane per cut material, plus the cut outline. */
  private readonly caps = new THREE.Group();
  private readonly capTextures = new Map<string, THREE.CanvasTexture>();
  private cutOutlineMaterial: LineMaterial | null = null;
  private grid: THREE.GridHelper;
  private gridColour = '#c8cbd2';
  private built: Built[] = [];
  private doc: ArchaiDocument | null = null;
  private selection: string[] = [];
  private frame = 0;
  private readonly resize: ResizeObserver;
  private dragStart: { x: number; y: number; z: number; rotation: number } | null = null;
  private pointerDown: { x: number; y: number; time: number } | null = null;
  private disposed = false;
  private cameraTimer = 0;
  private viewStyle: ViewStyle;
  private placingStop = false;
  private painting = false;
  /** Overlay showing what a paint click would change. */
  private paintHover: THREE.Mesh[] = [];
  private paintScope: PaintScope = 'face';
  private readonly hoverMaterial = new THREE.MeshBasicMaterial({ color: 0x2f6fed, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
  private readonly hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private readonly unsubscribeTextures: () => void;

  constructor(
    private readonly container: HTMLElement,
    private readonly events: SceneViewEvents,
    initialCamera?: CameraState,
    section: SectionCut | null = null,
    cameraMode = false,
  ) {
    this.section = section;
    this.hasInitialCamera = Boolean(initialCamera);
    this.viewStyle = section ? 'hidden-line' : 'realistic';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(section ? 0xfafafa : 0xf3f4f6);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.append(this.renderer.domElement);

    if (cameraMode) {
      this.camera = new THREE.PerspectiveCamera(initialCamera?.fov ?? 60, 1, 10, 500_000);
    } else {
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500_000, 500_000);
      // A plan looks straight down with the board's orientation: +x right, board y (scene +z) down.
      if (section?.plan) this.camera.up.set(0, 0, -1);
    }
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    if (section) {
      // A section is a fixed elevation: pan and zoom only; what is in front of the cut, beyond
      // the ends of the cut line or past its depth is clipped away.
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      this.renderer.clippingPlanes = sectionPlanes(section);
      this.renderer.localClippingEnabled = false;
    } else {
      this.controls.enableRotate = true;
      this.controls.screenSpacePanning = true;
    }
    this.controls.addEventListener('change', () => {
      this.requestRender();
      this.scheduleCameraSave();
    });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0aa, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(12_000, 20_000, 8_000);
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(40_000, 40, 0xc8cbd2, 0xe1e3e8);
    this.grid.position.y = -1;
    this.grid.visible = !section;
    this.scene.add(this.grid);
    this.scene.add(this.content);
    this.scene.add(this.caps);
    this.scene.add(this.anchor);
    this.scene.add(this.selectionOutlines);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    if (section) this.gizmo.showY = false;
    this.gizmo.showY = false;
    this.gizmo.setSize(0.8);
    this.gizmo.attach(this.anchor);
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmoHelper.visible = false;
    this.gizmo.enabled = false;
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (event) => {
      this.controls.enabled = !(event as unknown as { value: boolean }).value;
      if ((event as unknown as { value: boolean }).value) {
        this.dragStart = { x: this.anchor.position.x, y: this.anchor.position.y, z: this.anchor.position.z, rotation: this.anchor.rotation.y };
      } else if (this.dragStart) {
        this.emitTransform(true);
        this.dragStart = null;
      }
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.dragStart) this.emitTransform(false);
      this.requestRender();
    });

    if (section?.plan) {
      // The saved camera keeps pan and zoom; the frame size comes from the region.
      const { width, height } = container.getBoundingClientRect();
      const aspect = width > 0 && height > 0 ? width / height : 1.6;
      this.orthoHalfHeight = Math.max(1000, (section.plan.height / 2) * 1.08, (section.plan.width / 2 / aspect) * 1.08);
    }
    if (initialCamera) this.setCamera(initialCamera);
    else if (!section) {
      if (cameraMode) this.camera.position.set(8000, 6000, 8000);
      else this.camera.position.set(10000, 8000, 10000);
    }

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener('dblclick', this.onDoubleClick);
    this.renderer.domElement.addEventListener('keydown', this.onKeyDown);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.clearPaintHover);
    this.renderer.domElement.tabIndex = 0;
    // Image textures decode after the scene is built: redraw when they arrive.
    this.unsubscribeTextures = onMaterialTextures(() => this.requestRender());

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  private fit(): void {
    const { width, height } = this.container.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height, false);
    this.cutOutlineMaterial?.resolution.set(width, height);
    const aspect = width / height;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = aspect;
    } else {
      this.camera.left = -this.orthoHalfHeight * aspect;
      this.camera.right = this.orthoHalfHeight * aspect;
      this.camera.top = this.orthoHalfHeight;
      this.camera.bottom = -this.orthoHalfHeight;
    }
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  setCamera(camera: CameraState): void {
    this.camera.position.set(...camera.position);
    this.controls.target.set(...camera.target);
    const section = this.section;
    if (section && camera.cut) {
      // Saved before the cut last moved: follow it by the same amount.
      const dx = section.x - camera.cut[0];
      const dz = section.y - camera.cut[1];
      this.camera.position.x += dx;
      this.camera.position.z += dz;
      this.controls.target.x += dx;
      this.controls.target.z += dz;
    }
    if (section?.plan) {
      // Always straight down onto the level, whatever its elevation now is.
      this.controls.target.y = section.plan.elevation;
      this.camera.position.set(this.controls.target.x, section.plan.elevation + section.plan.cutHeight + 50_000, this.controls.target.z);
    }
    if (this.camera instanceof THREE.OrthographicCamera && camera.zoom) {
      this.camera.zoom = camera.zoom;
      this.camera.updateProjectionMatrix();
    }
    if (this.camera instanceof THREE.PerspectiveCamera && camera.fov) {
      this.camera.fov = camera.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.requestRender();
  }

  getCamera(): CameraState {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      ...(this.camera instanceof THREE.OrthographicCamera ? { zoom: this.camera.zoom } : { fov: this.camera.fov }),
      ...(this.section ? { cut: [this.section.x, this.section.y] as [number, number] } : {}),
    };
  }

  setViewStyle(style: ViewStyle): void {
    if (!this.section && style === 'section') return;
    if (this.viewStyle === style) return;
    this.viewStyle = style;
    this.content.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.userData['selectedMaterial']) return;
      disposeMaterials(child.material as THREE.Material | THREE.Material[]);
      child.material = child.userData['originalMaterial'] as THREE.Material | THREE.Material[];
      child.userData['selectedMaterial'] = false;
    });
    this.applySceneGraphics();
    this.applyViewStyle();
    this.updateGizmo();
    this.requestRender();
  }

  /** Background and grid from the document's graphics (3D scene / section view types). */
  private applySceneGraphics(): void {
    const g = graphicsResolver(this.doc?.workspace.graphics as GraphicsOverrides | undefined);
    const section = this.viewStyle === 'section' || Boolean(this.section);
    const background = section ? g.color('section', 'section', this.viewStyle, 'background') : g.color('scene', '3d', this.viewStyle, 'background');
    this.renderer.setClearColor(new THREE.Color(background ?? (section ? '#fafafa' : '#f3f4f6')));
    const gridColour = g.color('scene', '3d', this.viewStyle, 'grid.color') ?? '#c8cbd2';
    if (gridColour !== this.gridColour) {
      this.scene.remove(this.grid);
      this.grid.dispose();
      const minor = new THREE.Color(gridColour).lerp(new THREE.Color('#ffffff'), 0.55);
      this.grid = new THREE.GridHelper(40_000, 40, new THREE.Color(gridColour), minor);
      this.grid.position.y = -1;
      this.scene.add(this.grid);
      this.gridColour = gridColour;
    }
    this.grid.visible = !this.section && this.viewStyle !== 'section' && g.bool('scene', '3d', this.viewStyle, 'grid.visible');
  }

  private applyViewStyle(root: THREE.Object3D = this.content): void {
    this.scene.environment = this.viewStyle === 'realistic' && !this.section ? this.environmentMap() : null;
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || child.userData['capHelper']) return;
      const current = child.material as THREE.Material | THREE.Material[];
      const stored = child.userData['baseViewMaterial'] as THREE.Material | THREE.Material[] | undefined;
      if (!stored) child.userData['baseViewMaterial'] = current;
      const baseMaterials = (child.userData['baseViewMaterial'] as THREE.Material | THREE.Material[] | undefined) ?? current;
      const temporary = child.userData['viewStyleMaterial'] as THREE.Material | THREE.Material[] | undefined;
      if (temporary) for (const material of Array.isArray(temporary) ? temporary : [temporary]) material.dispose();
      delete child.userData['viewStyleMaterial'];
      const oldEdges = child.userData['hiddenLineEdges'] as THREE.LineSegments | undefined;
      if (oldEdges) {
        child.remove(oldEdges);
        (oldEdges.material as THREE.Material).dispose();
        delete child.userData['hiddenLineEdges'];
      }
      if (this.viewStyle === 'realistic') {
        child.material = baseMaterials;
        return;
      }
      if (this.viewStyle === 'hidden-line') {
        // White faces that hide what is behind them, feature edges drawn on top.
        const white = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
        const edges = new THREE.LineSegments(edgesOf(child.geometry, 25), new THREE.LineBasicMaterial({ color: 0x1f1f24 }));
        child.add(edges);
        child.userData['hiddenLineEdges'] = edges;
        child.userData['viewStyleMaterial'] = white;
        child.material = white;
        return;
      }
      const styled = (base: THREE.Material): THREE.Material => {
        const standard = base as THREE.MeshStandardMaterial;
        // Consistent colours: a textured material shows its average (base) colour, not white.
        const baseColor = standard.map && base.userData['materialColor'] ? new THREE.Color(base.userData['materialColor'] as string) : 'color' in base && standard.color ? standard.color.clone() : new THREE.Color(0xbfc3ca);
        return this.viewStyle === 'wireframe'
          ? new THREE.MeshBasicMaterial({ color: 0x343840, wireframe: true, transparent: false })
          : this.viewStyle === 'consistent'
            ? new THREE.MeshBasicMaterial({ color: baseColor, side: THREE.DoubleSide, transparent: base.transparent, opacity: base.opacity })
            : this.viewStyle === 'section'
              ? new THREE.MeshBasicMaterial({ color: 0xf2f2f0, side: THREE.DoubleSide })
              : new THREE.MeshStandardMaterial({ color: 0xb8bdc6, roughness: 0.82, metalness: 0.02, side: THREE.DoubleSide });
      };
      const material = Array.isArray(baseMaterials) ? baseMaterials.map(styled) : styled(baseMaterials);
      child.userData['viewStyleMaterial'] = material;
      child.material = material;
    });
  }

  private environment: THREE.Texture | null = null;

  /** Soft studio reflections for the realistic style, so metal and glass read. */
  private environmentMap(): THREE.Texture | null {
    if (this.environment) return this.environment;
    try {
      const generator = new THREE.PMREMGenerator(this.renderer);
      this.environment = generator.fromScene(new RoomEnvironment(), 0.04).texture;
      generator.dispose();
      this.scene.environmentIntensity = 0.55;
    } catch {
      this.environment = null;
    }
    return this.environment;
  }

  private addSectionEdges(root: THREE.Object3D = this.content): void {
    if (!this.section) return;
    const g = graphicsResolver(this.doc?.workspace.graphics as GraphicsOverrides | undefined);
    if (!g.bool('section', 'section', this.viewStyle, 'beyond.visible')) return;
    const colour = new THREE.Color(g.color('section', 'section', this.viewStyle, 'beyond.stroke') ?? '#34363a');
    const opacity = g.number('section', 'section', this.viewStyle, 'beyond.opacity');
    const meshes: THREE.Mesh[] = [];
    root.traverse((child) => {
      if (child instanceof THREE.Mesh && !child.userData['capHelper']) meshes.push(child);
    });
    for (const mesh of meshes) {
      const edges = new THREE.LineSegments(edgesOf(mesh.geometry, 28), new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity }));
      edges.userData['sectionEdges'] = true;
      mesh.add(edges);
    }
  }

  private clearSectionCaps(): void {
    for (const child of [...this.caps.children]) {
      this.caps.remove(child);
      if (child instanceof THREE.Mesh || child instanceof LineSegments2) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    this.cutOutlineMaterial = null;
    const helpers: THREE.Object3D[] = [];
    this.content.traverse((child) => {
      if (child.userData['capHelper']) helpers.push(child);
    });
    for (const helper of helpers) {
      helper.parent?.remove(helper);
      if (helper instanceof THREE.Mesh) (helper.material as THREE.Material).dispose();
    }
  }

  /**
   * Cut surfaces: for every cut material, the meshes' back faces increment and front faces
   * decrement the stencil (a pixel inside a solid ends up non-zero), then a plane on the cut
   * draws that material where the stencil is set and clears it for the next group. The cut
   * outline is computed from the triangles that cross the plane.
   */
  private buildSectionCaps(): void {
    this.clearSectionCaps();
    if (!this.section || !this.doc) return;
    const g = graphicsResolver(this.doc.workspace.graphics as GraphicsOverrides | undefined);
    const capsVisible = g.bool('section', 'section', this.viewStyle, 'caps.visible');
    const plane = this.renderer.clippingPlanes[0];
    if (!plane) return;
    const normal = plane.normal.clone();
    const origin = normal.clone().multiplyScalar(-plane.constant);
    this.content.updateWorldMatrix(true, true);
    const groups = new Map<string, THREE.Mesh[]>();
    this.content.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || child.userData['capHelper']) return;
      // A material with its own cut hatch caps with that; otherwise the element type's cut graphics.
      const materialId = child.userData['cutMaterial'];
      const material = typeof materialId === 'string' && this.doc ? materialById(this.doc, materialId) : null;
      const key = material?.cutHatch ? `material:${material.id}` : typeof child.userData['cutKey'] === 'string' ? (child.userData['cutKey'] as string) : 'section';
      const list = groups.get(key) ?? [];
      list.push(child);
      groups.set(key, list);
    });
    const outline: number[] = [];
    let order = 100;
    const box = new THREE.Box3();
    for (const [key, meshes] of groups) {
      const cutMaterial = key.startsWith('material:') ? materialById(this.doc, key.slice('material:'.length)) : null;
      const spec: HatchSpec | null = cutMaterial?.cutHatch
        ? { pattern: cutMaterial.cutHatch, fill: cutMaterial.cutColor, color: cutMaterial.cutHatchColor, spacing: cutMaterial.cutHatchSpacing, angle: cutMaterial.cutHatchAngle }
        : cutSpec(key, g, this.viewStyle);
      let any = false;
      for (const mesh of meshes) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
        if (!plane.intersectsBox(box)) continue;
        any = true;
        collectCutSegments(mesh, plane, outline);
        if (!capsVisible || !spec) continue;
        const back = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ ...STENCIL_BASE, side: THREE.BackSide, stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp }));
        const front = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ ...STENCIL_BASE, side: THREE.FrontSide, stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp }));
        for (const helper of [back, front]) {
          helper.userData['capHelper'] = true;
          helper.userData['shared'] = true;
          helper.renderOrder = order;
          mesh.add(helper);
        }
      }
      if (!any || !capsVisible || !spec) continue;
      const cap = new THREE.Mesh(new THREE.PlaneGeometry(CAP_SIZE, CAP_SIZE), this.capMaterial(spec));
      cap.position.copy(origin).addScaledVector(normal, 1);
      cap.lookAt(cap.position.clone().sub(normal));
      cap.renderOrder = order + 1;
      cap.userData['capHelper'] = true;
      this.caps.add(cap);
      order += 2;
    }
    if (outline.length > 0 && g.bool('section', 'section', this.viewStyle, 'cut.outline.visible')) {
      // Nudged into the kept half-space so the clipping plane does not swallow it.
      for (let i = 0; i < outline.length; i += 3) {
        outline[i] = outline[i]! + normal.x * 2;
        outline[i + 1] = outline[i + 1]! + normal.y * 2;
        outline[i + 2] = outline[i + 2]! + normal.z * 2;
      }
      const geometry = new LineSegmentsGeometry().setPositions(outline);
      const { width, height } = this.container.getBoundingClientRect();
      this.cutOutlineMaterial = new LineMaterial({
        color: new THREE.Color(g.color('section', 'section', this.viewStyle, 'cut.outline.stroke') ?? '#1f1f24').getHex(),
        linewidth: Math.max(0.5, g.number('section', 'section', this.viewStyle, 'cut.outline.width') || 2),
        depthTest: false,
        transparent: true,
      });
      this.cutOutlineMaterial.resolution.set(Math.max(1, width), Math.max(1, height));
      const lines = new LineSegments2(geometry, this.cutOutlineMaterial);
      lines.renderOrder = 400;
      lines.userData['capHelper'] = true;
      this.caps.add(lines);
    }
  }

  private capMaterial(spec: HatchSpec): THREE.MeshBasicMaterial {
    const key = hatchKey(spec);
    let texture = this.capTextures.get(key);
    if (!texture) {
      const canvas = document.createElement('canvas');
      drawHatchTile(canvas, spec);
      texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const repeat = CAP_SIZE / Math.max(4, spec.spacing);
      texture.repeat.set(repeat, repeat);
      texture.center.set(0.5, 0.5);
      texture.rotation = (spec.angle * Math.PI) / 180;
      this.capTextures.set(key, texture);
    }
    return new THREE.MeshBasicMaterial({
      map: spec.pattern === 'none' ? null : texture,
      color: spec.pattern === 'none' ? new THREE.Color(spec.fill) : 0xffffff,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
  }

  setSection(section: SectionCut | null): void {
    if (!section || !(this.camera instanceof THREE.OrthographicCamera)) return;
    const previous = this.section;
    const samePlan = (p?: PlanCut, q?: PlanCut) => p === q || (!!p && !!q && p.elevation === q.elevation && p.cutHeight === q.cutHeight && p.width === q.width && p.height === q.height);
    const unchanged = previous && previous.x === section.x && previous.y === section.y && previous.angle === section.angle && previous.length === section.length && previous.depth === section.depth && samePlan(previous.plan, section.plan);
    if (unchanged) return;
    const moved = !previous || previous.x !== section.x || previous.y !== section.y || previous.angle !== section.angle || previous.plan?.elevation !== section.plan?.elevation;
    if (previous) {
      this.controls.target.x += section.x - previous.x;
      this.controls.target.z += section.y - previous.y;
    }
    this.section = section;
    this.renderer.clippingPlanes = sectionPlanes(section);
    this.buildSectionCaps();
    if (moved && section.plan) {
      // Straight down onto the level, from above whatever the view can show.
      this.controls.target.y = section.plan.elevation;
      this.camera.position.set(this.controls.target.x, section.plan.elevation + section.plan.cutHeight + 50_000, this.controls.target.z);
      this.controls.update();
    } else if (moved) {
      const r = (section.angle * Math.PI) / 180;
      const normal = new THREE.Vector3(-Math.sin(r), 0, Math.cos(r));
      const distance = Math.max(1000, this.camera.position.distanceTo(this.controls.target));
      this.camera.position.copy(this.controls.target.clone().sub(normal.multiplyScalar(distance)));
      this.controls.update();
    }
    // The cut moved (its line, region or origin): remember where the view now looks.
    if (previous) this.scheduleCameraSave();
    this.requestRender();
  }

  /** Level of detail override for this view (null → the document's setting). */
  setLod(lod: 'high' | 'low' | null): void {
    if (this.lod === lod) return;
    this.lod = lod;
    this.rebuild();
  }

  /** Frames the whole document (a section frames it from in front of the cut). */
  frameAll(): void {
    if (!this.doc) return;
    const { centre, radius } = sceneCentre(this.doc);
    const plan = this.section?.plan;
    if (this.section && plan) {
      // The level's region, seen from straight above.
      this.controls.target.set(this.section.x, plan.elevation, this.section.y);
      this.camera.position.set(this.section.x, plan.elevation + plan.cutHeight + 50_000, this.section.y);
      const { width, height } = this.container.getBoundingClientRect();
      const aspect = width > 0 && height > 0 ? width / height : 1.6;
      this.orthoHalfHeight = Math.max(1000, (plan.height / 2) * 1.08, (plan.width / 2 / aspect) * 1.08);
      if (this.camera instanceof THREE.OrthographicCamera) this.camera.zoom = 1;
      this.fit();
    } else if (this.section) {
      const r = (this.section.angle * Math.PI) / 180;
      const normal = new THREE.Vector3(-Math.sin(r), 0, Math.cos(r));
      const origin = new THREE.Vector3(this.section.x, 0, this.section.y);
      // Look at the middle of the cut line from the near side, level with the model's middle height.
      const height = this.doc ? sceneHeight(this.doc) : 3000;
      const target = origin.clone().setY(height / 2);
      this.controls.target.copy(target);
      this.camera.position.copy(target.clone().sub(normal.clone().multiplyScalar(radius * 2)));
      // Frame the cut line's length (and the model's height) with a small margin.
      const { width, height: viewHeight } = this.container.getBoundingClientRect();
      const aspect = width > 0 && viewHeight > 0 ? width / viewHeight : 1.6;
      const length = this.section.length && this.section.length > 0 ? this.section.length : radius * 2;
      this.orthoHalfHeight = Math.max(1000, (length / 2 / aspect) * 1.12, (height / 2) * 1.15);
      if (this.camera instanceof THREE.OrthographicCamera) this.camera.zoom = 1;
      this.fit();
    } else if (this.camera instanceof THREE.OrthographicCamera) {
      this.controls.target.copy(centre);
      const dist = Math.max(radius * 2, 4000);
      this.camera.position.set(centre.x + dist, centre.y + dist * 0.8, centre.z + dist);
      this.orthoHalfHeight = Math.max(2000, radius * 1.2);
      this.camera.zoom = 1;
      this.fit();
    } else {
      this.controls.target.copy(centre);
      this.camera.position.set(centre.x + radius * 1.5, radius * 1.3, centre.z + radius * 1.5);
    }
    this.controls.update();
    this.requestRender();
  }

  /**
   * Renders the view now at an exact pixel size (for print and snapshots) and returns a canvas.
   * The frame keeps what the screen shows at the requested aspect ratio; large sizes render in
   * tiles through a camera view offset, so they are not capped by the GPU's drawing-buffer size
   * and every tile keeps MSAA. Pixel-width lines scale with the output, the selection tint and
   * gizmo are left out, and the live canvas is restored before returning.
   */
  renderImage(width: number, height: number, options: RenderImageOptions = {}): HTMLCanvasElement {
    const outW = Math.max(1, Math.round(width));
    const outH = Math.max(1, Math.round(height));
    const selection = this.selection;
    const shown = options.highlight ?? [];
    if (selection.length > 0 || shown.length > 0) {
      this.selection = [...shown];
      this.updateGizmo();
    }
    const previousStyle = this.viewStyle;
    if (options.style && options.style !== previousStyle) this.setViewStyle(options.style);
    const clear = this.renderer.getClearColor(new THREE.Color());
    const clearAlpha = this.renderer.getClearAlpha();
    if (options.background) this.renderer.setClearColor(new THREE.Color(options.background), 1);
    const undoLooks = options.overrides ? this.applyLooks(options.overrides) : () => {};
    const gridVisible = this.grid.visible;
    if (options.grid === false) this.grid.visible = false;
    const gizmoWasVisible = this.gizmoHelper.visible;
    this.gizmoHelper.visible = false;
    const pixelRatio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.setAspect(outW / outH);
    const gl = this.renderer.getContext();
    const maxTile = Math.min(4096, this.renderer.capabilities.maxTextureSize, (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 4096);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const context = canvas.getContext('2d');
    try {
      if (!context) throw new Error('Canvas is not available');
      for (const tile of tileGrid(outW, outH, maxTile)) {
        this.camera.setViewOffset(outW, outH, tile.x, tile.y, tile.width, tile.height);
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(tile.width, tile.height, false);
        this.draw();
        // Read back in the same task as the draw: the drawing buffer is not preserved.
        context.drawImage(this.renderer.domElement, 0, 0, tile.width, tile.height, tile.x, tile.y, tile.width, tile.height);
      }
    } finally {
      this.camera.clearViewOffset();
      this.renderer.setPixelRatio(pixelRatio);
      this.gizmoHelper.visible = gizmoWasVisible;
      undoLooks();
      this.grid.visible = gridVisible;
      this.renderer.setClearColor(clear, clearAlpha);
      if (options.style && options.style !== previousStyle) this.setViewStyle(previousStyle);
      if (selection.length > 0 || shown.length > 0) {
        this.selection = selection;
        this.updateGizmo();
      }
      this.fit();
    }
    return canvas;
  }

  /** Frames the camera for an aspect ratio (without resizing the canvas). */
  private setAspect(aspect: number): void {
    if (this.camera instanceof THREE.PerspectiveCamera) this.camera.aspect = aspect;
    else {
      this.camera.left = -this.orthoHalfHeight * aspect;
      this.camera.right = this.orthoHalfHeight * aspect;
      this.camera.top = this.orthoHalfHeight;
      this.camera.bottom = -this.orthoHalfHeight;
    }
    this.camera.updateProjectionMatrix();
  }

  /**
   * The element under a point of an image rendered at `aspect` (u, v in 0..1 from the top-left),
   * as renderImage frames it; `skip` ids (hidden in that image) are looked through.
   */
  pickAt(u: number, v: number, aspect: number, skip: ReadonlySet<string> = new Set()): string | null {
    this.setAspect(aspect);
    try {
      this.raycaster.setFromCamera(new THREE.Vector2(u * 2 - 1, -(v * 2 - 1)), this.camera);
      for (const hit of this.raycaster.intersectObjects(this.content.children, true)) {
        const id = hit.object.userData['elementId'];
        if (typeof id === 'string' && !skip.has(id) && hit.object.visible) return id;
      }
      return null;
    } finally {
      this.fit();
    }
  }

  /** Temporarily restyles elements for one render; returns the undo. */
  private applyLooks(looks: Readonly<Record<string, ElementLook>>): () => void {
    const undo: (() => void)[] = [];
    const ghost = new THREE.MeshBasicMaterial({ color: 0xe3e6eb, transparent: true, opacity: 0.35, depthWrite: false });
    const ghostLine = new THREE.LineBasicMaterial({ color: 0xc3c8d0, transparent: true, opacity: 0.5 });
    const created: { dispose(): void }[] = [ghost, ghostLine];
    for (const item of this.built) {
      const look = looks[item.id];
      if (!look) continue;
      const object = item.object;
      if (look.hidden) {
        const visible = object.visible;
        object.visible = false;
        undo.push(() => {
          object.visible = visible;
        });
        continue;
      }
      const lift = look.lift ?? 0;
      if (lift) {
        object.position.y += lift;
        object.updateMatrixWorld(true);
        undo.push(() => {
          object.position.y -= lift;
          object.updateMatrixWorld(true);
        });
      }
      object.traverse((child) => {
        if (child instanceof THREE.LineSegments && look.ghost) {
          const material = child.material;
          child.material = ghostLine;
          undo.push(() => {
            child.material = material;
          });
          return;
        }
        if (!(child instanceof THREE.Mesh) || child.userData['capHelper']) return;
        const material = child.material as THREE.Material | THREE.Material[];
        let next: THREE.Material | THREE.Material[] = material;
        if (look.ghost) next = ghost;
        else if (look.color || look.opacity !== undefined || look.glow) {
          const restyle = (base: THREE.Material) => {
            const copy = base.clone();
            created.push(copy);
            const colored = copy as THREE.MeshStandardMaterial;
            if (look.color && colored.color) {
              colored.color = new THREE.Color(look.color);
              // A little self-light in the same hue, so diagram colours read under the scene lighting.
              if (colored.emissive) {
                colored.emissive = new THREE.Color(look.color);
                colored.emissiveIntensity = 0.35;
              }
            }
            if (look.glow && colored.emissive) {
              colored.emissive = new THREE.Color(look.accent ?? '#e11d48');
              colored.emissiveIntensity = 0.55;
            } else if (look.glow && colored.color) colored.color.lerp(new THREE.Color(look.accent ?? '#e11d48'), 0.45);
            if (look.opacity !== undefined && look.opacity < 1) {
              copy.transparent = true;
              copy.opacity = look.opacity;
              copy.depthWrite = false;
            }
            return copy;
          };
          next = Array.isArray(material) ? material.map(restyle) : restyle(material);
        }
        if (next !== material) {
          child.material = next;
          undo.push(() => {
            child.material = material;
          });
        }
        if (look.outline && !look.ghost) {
          const edges = new THREE.LineSegments(edgesOf(child.geometry, 25), new THREE.LineBasicMaterial({ color: look.outline, depthTest: false, transparent: true }));
          edges.renderOrder = 40;
          child.add(edges);
          undo.push(() => {
            child.remove(edges);
            (edges.material as THREE.Material).dispose();
          });
        }
      });
    }
    return () => {
      for (const step of undo.reverse()) step();
      for (const item of created) item.dispose();
    };
  }

  /**
   * A PNG data URL of the current view; `scale` renders at a multiple of the on-screen size.
   * Prefer renderImage with an explicit size for print.
   */
  snapshot(scale = 1): string {
    const { width, height } = this.container.getBoundingClientRect();
    const ratio = scale === 1 ? Math.min(window.devicePixelRatio, 2) : scale;
    return this.renderImage(Math.max(1, width) * ratio, Math.max(1, height) * ratio).toDataURL('image/png');
  }

  setDocument(doc: ArchaiDocument): void {
    const hadDoc = this.doc !== null;
    this.doc = doc;
    this.rebuild();
    if (!hadDoc && !this.hasInitialCamera) this.frameAll();
    // Models and textures arrive later; rebuild once they do.
    void Promise.all([modelStore.prepare(doc), textureStore.prepare(doc), prepareMassing(doc), prepareParametric(doc), meshStore.prepare(doc)]).then(([modelsChanged, texturesChanged, massingReady, parametricReady, meshesReady]) => {
      // The document may have moved on meanwhile (camera saves change it too); rebuild the current one.
      // They load into the same maps in place, so cached objects cannot tell: rebuild everything.
      if (!this.disposed && (modelsChanged || texturesChanged || massingReady || parametricReady || meshesReady)) this.rebuild(true);
    });
  }

  setSelection(selection: string[]): void {
    this.selection = selection;
    this.updateGizmo();
    this.requestRender();
  }

  /**
   * Brings the scene up to date with the document. Elements whose inputs did not change keep
   * their objects (see buildScene), so an edit only styles, adds and disposes what it replaced;
   * `full` discards every cached object.
   */
  private rebuild(full = false): void {
    if (!this.doc) return;
    this.clearSectionCaps();
    const previous = full ? undefined : new Map(this.built.map((item) => [item.id, item]));
    // Low LOD: only packages that ship a low-poly model get one; the rest fall back to boxes.
    // Elements may override the view's level of detail individually (`meta.lod`).
    const next = buildScene(this.doc, { textures: textureStore.textures, models: modelStore.models, lowModels: modelStore.lowModels, lod: this.lod ?? this.doc.workspace.lod, drawing: Boolean(this.section) }, previous);
    const kept = new Set(next.map((item) => item.object));
    const existing = new Set<THREE.Object3D>();
    for (const item of this.built) {
      if (kept.has(item.object)) {
        existing.add(item.object);
        continue;
      }
      this.content.remove(item.object);
      item.object.traverse((child) => {
        if (child instanceof THREE.Mesh && !child.userData['shared']) child.geometry.dispose();
      });
    }
    this.built = next;
    const added = next.filter((item) => !existing.has(item.object)).map((item) => item.object);
    for (const object of added) this.content.add(object);
    this.applySceneGraphics();
    for (const object of added) {
      this.applyViewStyle(object);
      this.addSectionEdges(object);
    }
    this.buildSectionCaps();
    this.extent = sceneCentre(this.doc);
    this.updateGizmo();
    this.analysis?.invalidate();
    this.requestRender();
  }

  /**
   * Values of the analysis running in this view on a grid (board mm spacing); `clipTop` samples
   * what lies below a height (a level's floor). Empty when no analysis runs here.
   */
  analysisSamples(spacing: number, clipTop: number | null = null): AnalysisSample[] {
    return this.analysis?.active ? this.analysis.sampleValues(spacing, clipTop) : [];
  }

  /** Shows (or clears) the running environmental analysis in this view. */
  setAnalysis(spec: AnalysisSpec | null): void {
    if (!spec && !this.analysis) return;
    this.analysis ??= new AnalysisLayer({
      renderer: this.renderer,
      scene: this.scene,
      content: this.content,
      container: this.container,
      helpers: () => [this.grid, this.caps, this.anchor, this.selectionOutlines, this.gizmoHelper],
      // The project, not generated context or far-away items (see sceneCentre).
      focus: () => this.extent,
    });
    this.analysis.set(spec);
    this.updateGizmo();
    this.requestRender();
  }

  /** Scene size for the clipping range; refreshed on every rebuild. */
  private extent = { centre: new THREE.Vector3(), radius: 5000 };

  /**
   * Near/far planes that always contain the model: a fixed range (it used to be ±500 m) clips
   * everything once a site-scale scene (1:1 maps, context) puts the camera farther away.
   */
  private updateClipping(): void {
    const reach = this.camera.position.distanceTo(this.extent.centre) + this.extent.radius * 2 + 20_000;
    if (this.camera instanceof THREE.OrthographicCamera) {
      if (this.camera.near === -reach && this.camera.far === reach) return;
      this.camera.near = -reach;
      this.camera.far = reach;
    } else {
      const near = Math.min(1000, Math.max(10, this.camera.position.distanceTo(this.controls.target) / 2000));
      if (this.camera.near === near && this.camera.far === reach) return;
      this.camera.near = near;
      this.camera.far = reach;
    }
    this.camera.updateProjectionMatrix();
  }

  private draw(): void {
    this.updateClipping();
    if (this.analysis?.active) this.analysis.render(this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  private updateGizmo(): void {
    if (!this.doc || this.dragStart) return;
    const ids = this.selection.filter((id) => this.doc!.elements[id] && !this.doc!.elements[id]!.locked && !this.doc!.elements[id]!.meta?.['view3d'] && (!isAnalysisElement(this.doc!.elements[id]) || !!this.verticalHandle(id)));
    const bounds = ids.length > 0 ? boundsOfIds(this.doc.elements, ids) : null;
    // Highlight selected objects: tinted materials plus an outline box drawn on top of everything.
    this.selectionOutlines.clear();
    for (const item of this.built) {
      const selected = this.selection.includes(item.id);
      if (selected) {
        const outline = new THREE.BoxHelper(item.object, 0x2f6fed);
        (outline.material as THREE.LineBasicMaterial).depthTest = false;
        (outline.material as THREE.LineBasicMaterial).transparent = true;
        (outline.material as THREE.LineBasicMaterial).opacity = 0.9;
        outline.renderOrder = 30;
        this.selectionOutlines.add(outline);
      }
      item.object.traverse((child) => {
        if (child instanceof THREE.Mesh && !child.userData['capHelper']) {
          const material = child.material as THREE.Material | THREE.Material[];
          if (selected && !child.userData['selectedMaterial']) {
            child.userData['originalMaterial'] = material;
            child.material = highlightMaterial(material);
            child.userData['selectedMaterial'] = true;
          } else if (!selected && child.userData['selectedMaterial']) {
            disposeMaterials(child.material as THREE.Material | THREE.Material[]);
            child.material = child.userData['originalMaterial'] as THREE.Material | THREE.Material[];
            child.userData['selectedMaterial'] = false;
          }
        }
      });
    }
    if (!bounds) {
      this.gizmoHelper.visible = false;
      this.gizmo.enabled = false;
      return;
    }
    // Noise emitters and reference points also move in height: the gizmo sits on them with its Y arrow.
    const vertical = ids.length === 1 ? this.verticalHandle(ids[0]!) : null;
    // The gizmo sits at the selection's elevation; its up arrow changes elevation (hidden when a level controls it).
    const base = ids.length ? Math.min(...ids.map((id) => instanceElevationOf(this.doc!.elements[id]!, this.doc!.elements))) : 0;
    this.anchor.position.set(bounds.x + bounds.width / 2, vertical?.y ?? base, bounds.y + bounds.height / 2);
    this.gizmo.showY = this.canLift(ids) || this.gizmo.getMode() === 'rotate';
    this.anchor.rotation.set(0, 0, 0);
    this.gizmoHelper.visible = true;
    this.gizmo.enabled = true;
  }

  /**
   * While on, clicks paint instead of selecting: a click reports the surface under the cursor,
   * Shift reports its whole slot, Alt picks the material shown there; hovering outlines the target.
   */
  setPainting(on: boolean): void {
    this.painting = on;
    this.renderer.domElement.style.cursor = on ? 'cell' : this.placingStop ? 'crosshair' : '';
    if (!on) this.clearPaintHover();
  }

  /** The material under a mesh's group, as built (not the selection tint or a view style). */
  private builtMaterial(mesh: THREE.Mesh, index: number): THREE.Material {
    const source = (mesh.userData['originalMaterial'] ?? mesh.userData['baseViewMaterial'] ?? mesh.material) as THREE.Material | THREE.Material[];
    return Array.isArray(source) ? (source[index] ?? source[0]!) : source;
  }

  private surfaceHit(clientX: number, clientY: number): { target: SurfaceTarget; mesh: THREE.Mesh; group: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    // World matrices are refreshed by rendering; a hit test can come before the first frame.
    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    for (const hit of this.raycaster.intersectObjects(this.content.children, true)) {
      const mesh = hit.object;
      if (!(mesh instanceof THREE.Mesh) || !hit.face || mesh.userData['capHelper'] || !mesh.visible || this.paintHover.includes(mesh)) continue;
      const elementId = (mesh.userData['ownerId'] ?? mesh.userData['elementId']) as string | undefined;
      if (typeof elementId !== 'string') continue;
      const group = hit.face.materialIndex ?? 0;
      const slots = mesh.userData['slots'] as string[] | undefined;
      const surfaces = mesh.userData['surfaces'] as (string | null)[] | null | undefined;
      let surface = surfaces?.[group] ?? null;
      if (!surface && mesh.userData['surfaceByNormal']) {
        const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
        surface = normal.y > 0.7 ? 'top' : normal.y < -0.7 ? 'bottom' : 'sides';
      }
      const shown = this.builtMaterial(mesh, group);
      const materialId = typeof shown.userData['materialId'] === 'string' ? (shown.userData['materialId'] as string) : null;
      return { target: { elementId, slot: slots?.[group] ?? (mesh.userData['slot'] as string | undefined) ?? null, surface, materialId }, mesh, group };
    }
    return null;
  }

  /** What painting at a screen point would change (also used by drag and drop). */
  targetAt(clientX: number, clientY: number): SurfaceTarget | null {
    return this.surfaceHit(clientX, clientY)?.target ?? null;
  }

  private readonly clearPaintHover = () => {
    if (this.paintHover.length === 0) return;
    for (const overlay of this.paintHover) overlay.parent?.remove(overlay);
    this.paintHover = [];
    this.requestRender();
  };

  /** The paint tool's scope for clicks without modifiers. */
  setPaintScope(scope: PaintScope): void {
    this.paintScope = scope;
  }

  /** The scope of a click: Shift = the part, Ctrl = the whole object, else the tool's scope. */
  scopeFor(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): PaintScope {
    return event.shiftKey ? 'part' : event.ctrlKey || event.metaKey ? 'object' : this.paintScope;
  }

  /** Model material slots (`asset:<name>`) shown by an element's meshes. */
  assetSlotsOf(elementId: string): string[] {
    const slots = new Set<string>();
    this.content.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || child.userData['capHelper'] || (child.userData['ownerId'] ?? child.userData['elementId']) !== elementId) return;
      for (const slot of (child.userData['slots'] as string[] | undefined) ?? []) if (slot.startsWith('asset:')) slots.add(slot);
    });
    return [...slots];
  }

  /** The material id a mesh group shows, as built. */
  private shownMaterialId(mesh: THREE.Mesh, group: number): string | null {
    const id = this.builtMaterial(mesh, group).userData['materialId'];
    return typeof id === 'string' ? id : null;
  }

  /** Outlines what a paint click at a point would change in `scope`. */
  showPaintHover(clientX: number, clientY: number, scope: PaintScope): void {
    const hit = this.surfaceHit(clientX, clientY);
    this.clearPaintHover();
    if (!hit) return;
    const overlay = (mesh: THREE.Mesh, groups: ((index: number) => boolean) | null) => {
      const list = mesh.geometry.groups;
      const material = groups === null || list.length === 0 ? this.hoverMaterial : list.map((_, index) => (groups(index) ? this.hoverMaterial : this.hiddenMaterial));
      const shown = new THREE.Mesh(mesh.geometry, material);
      shown.userData['capHelper'] = true;
      shown.userData['shared'] = true;
      shown.renderOrder = 45;
      mesh.add(shown);
      this.paintHover.push(shown);
    };
    const { mesh, group, target } = hit;
    // Faces without their own surface are painted as their part.
    if (scope === 'face' && target.surface) overlay(mesh, (index) => index === group);
    else if (scope === 'face' || scope === 'part') {
      const slot = target.slot;
      const slots = mesh.userData['slots'] as string[] | undefined;
      overlay(mesh, slots && slot ? (index) => slots[index] === slot : null);
    } else {
      const meshes: THREE.Mesh[] = [];
      this.content.traverse((child) => {
        if (child instanceof THREE.Mesh && !child.userData['capHelper'] && child.visible && !this.paintHover.includes(child)) meshes.push(child);
      });
      const owner = (child: THREE.Mesh) => (child.userData['ownerId'] ?? child.userData['elementId']) as string | undefined;
      for (const child of meshes) {
        if (scope === 'object') {
          if (owner(child) === target.elementId) overlay(child, null);
          continue;
        }
        const count = Math.max(1, child.geometry.groups.length);
        const matches = Array.from({ length: count }, (_, index) =>
          target.materialId ? this.shownMaterialId(child, index) === target.materialId : (child.userData['slots'] as string[] | undefined)?.[index] === target.slot && this.sameDefinition(owner(child), target.elementId),
        );
        if (matches.some(Boolean)) overlay(child, (index) => matches[index] ?? false);
      }
    }
    this.requestRender();
  }

  /** Whether two elements are copies of the same asset (for model materials, which have no id). */
  private sameDefinition(a: string | undefined, b: string): boolean {
    if (!a || !this.doc) return false;
    const x = this.doc.elements[a];
    const y = this.doc.elements[b];
    return a === b || (x?.kind === 'instance' && y?.kind === 'instance' && x.definitionId === y.definitionId);
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!(this.painting || this.picking) || event.buttons !== 0) return;
    this.showPaintHover(event.clientX, event.clientY, this.picking ? 'part' : this.scopeFor(event));
  };

  private picking = false;

  /** While on, a click picks the material under the cursor (as Alt+click does while painting). */
  setPicking(on: boolean): void {
    this.picking = on;
    this.renderer.domElement.style.cursor = on ? 'copy' : this.painting ? 'cell' : this.placingStop ? 'crosshair' : '';
    if (!on && !this.painting) this.clearPaintHover();
  }

  /** While on, a click places a VR stop on the floor under the cursor instead of selecting. */
  setPlacingStop(on: boolean): void {
    this.placingStop = on;
    this.renderer.domElement.style.cursor = on ? 'crosshair' : this.painting ? 'cell' : '';
  }

  /**
   * The floor under a screen point: the first surface the ray meets, if it faces up (a wall in
   * the way is a miss, not a look-through), else the ground plane. The heading is the camera's
   * horizontal view direction, so a stop faces the way the user was looking when placing it.
   */
  private floorAt(clientX: number, clientY: number): { x: number; y: number; elevation: number; heading: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray;
    let point: THREE.Vector3 | null = null;
    for (const hit of this.raycaster.intersectObjects(this.content.children, true)) {
      const object = hit.object;
      if (!(object instanceof THREE.Mesh) || !hit.face || object.userData['capHelper'] || !object.visible) continue;
      const normal = hit.face.normal.clone().transformDirection(object.matrixWorld);
      if (Math.abs(normal.y) < FLOOR_NORMAL_Y || ray.direction.y >= 0) return null;
      point = hit.point;
      break;
    }
    if (!point) {
      point = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (!point) return null;
    }
    const look = this.controls.target.clone().sub(this.camera.position);
    const heading = Math.hypot(look.x, look.z) > 1e-6 ? (Math.atan2(look.z, look.x) * 180) / Math.PI : 0;
    return { x: point.x, y: point.z, elevation: Math.round(point.y), heading: Math.round(heading) };
  }

  setMode(mode: 'translate' | 'rotate'): void {
    this.gizmo.setMode(mode);
    if (mode === 'rotate') {
      this.gizmo.showX = false;
      this.gizmo.showZ = false;
      this.gizmo.showY = true;
    } else {
      this.gizmo.showX = true;
      this.gizmo.showZ = true;
      this.gizmo.showY = this.canLift(this.selection);
    }
    this.requestRender();
  }

  private emitTransform(commit: boolean): void {
    if (!this.dragStart || !this.doc) return;
    const ids = this.selection.filter((id) => this.doc!.elements[id] && !this.doc!.elements[id]!.locked);
    if (ids.length === 0) return;
    const dx = this.anchor.position.x - this.dragStart.x;
    const dy = this.anchor.position.z - this.dragStart.z;
    // Scene rotation about +Y is counter-clockwise seen from above; document rotation is clockwise.
    const degrees = (-(this.anchor.rotation.y - this.dragStart.rotation) * 180) / Math.PI;
    this.events.onTransform({ ids, dx, dy, dz: this.anchor.position.y - this.dragStart.y, degrees, pivot: { x: this.dragStart.x, y: this.dragStart.z } }, commit);
  }

  /** Whether the selection can move up and down: not locked, and no level controls its elevation. */
  private canLift(ids: readonly string[]): boolean {
    if (!this.doc || ids.length === 0) return false;
    return ids.every((id) => {
      const element = this.doc!.elements[id];
      if (!element || element.locked || element.meta?.['view3d'] || element.meta?.['levelConstraint'] || element.meta?.['level']) return false;
      return !isAnalysisElement(element) || Boolean(this.analysis?.emitterPosition(id));
    });
  }

  /** Where the height handle of a noise emitter or reference point is, or null for other elements. */
  private verticalHandle(id: string): THREE.Vector3 | null {
    const emitter = this.analysis?.emitterPosition(id);
    if (emitter) return emitter;
    const item = this.built.find((entry) => entry.id === id);
    let marker: THREE.Object3D | null = null;
    item?.object.traverse((child) => {
      if (child.userData['pointMarker']) marker = child;
    });
    return marker ? (marker as THREE.Object3D).getWorldPosition(new THREE.Vector3()) : null;
  }

  private pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const emitterId = this.analysis?.pickEmitter(this.raycaster);
    if (emitterId) return emitterId;
    // Reference points have no real size: they are hit within a few pixels of their marker.
    let nearest: { id: string; distance: number } | null = null;
    const projected = new THREE.Vector3();
    this.content.traverse((child) => {
      if (!child.userData['pointMarker'] || typeof child.userData['elementId'] !== 'string') return;
      projected.copy(child.getWorldPosition(new THREE.Vector3())).project(this.camera);
      if (projected.z > 1) return;
      const distance = Math.hypot(rect.left + ((projected.x + 1) / 2) * rect.width - clientX, rect.top + ((1 - projected.y) / 2) * rect.height - clientY);
      if (distance <= 12 && (!nearest || distance < nearest.distance)) nearest = { id: child.userData['elementId'] as string, distance };
    });
    if (nearest) return (nearest as { id: string }).id;
    const hits = this.raycaster.intersectObjects(this.content.children, true);
    for (const hit of hits) {
      const id = hit.object.userData['elementId'];
      if (typeof id === 'string') return id;
    }
    return null;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
    this.renderer.domElement.focus({ preventScroll: true });
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || event.button !== 0 || this.dragStart) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return; // an orbit, not a click
    if (this.gizmo.dragging) return;
    if (this.painting || this.picking) {
      const target = this.targetAt(event.clientX, event.clientY);
      if (target && (event.altKey || this.picking)) this.events.onEyedrop?.(target);
      else if (target) this.events.onPaint?.(target, this.scopeFor(event));
      return;
    }
    if (this.placingStop) {
      const stop = this.floorAt(event.clientX, event.clientY);
      if (stop) this.events.onPlaceStop?.(stop);
      else this.events.onPlaceMiss?.();
      return;
    }
    const id = this.pick(event.clientX, event.clientY);
    this.events.onSelect(id, event.shiftKey);
  };

  private readonly onDoubleClick = (event: MouseEvent) => {
    if (this.placingStop || this.painting || this.picking) return;
    const id = this.pick(event.clientX, event.clientY);
    if (!id) this.events.onOpen?.();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if ((event.key === 'r' || event.key === 'R') && !this.section) this.setMode('rotate');
    if (event.key === 'g' || event.key === 'G' || event.key === 'm' || event.key === 'M') this.setMode('translate');
    if (event.key === 'f' || event.key === 'F') this.frameAll();
  };

  private scheduleCameraSave(): void {
    window.clearTimeout(this.cameraTimer);
    this.cameraTimer = window.setTimeout(() => this.events.onCameraChange(this.getCamera()), 400);
  }

  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
      // A live simulation keeps drawing while it runs.
      if (this.analysis?.animating) this.requestRender();
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.cameraTimer);
    this.resize.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('dblclick', this.onDoubleClick);
    this.renderer.domElement.removeEventListener('keydown', this.onKeyDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.clearPaintHover);
    this.unsubscribeTextures();
    this.clearPaintHover();
    this.hoverMaterial.dispose();
    this.hiddenMaterial.dispose();
    this.environment?.dispose();
    this.clearSectionCaps();
    for (const texture of this.capTextures.values()) texture.dispose();
    this.analysis?.dispose();
    this.gizmo.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
