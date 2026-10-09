/**
 * One hidden WebGL renderer for still images of 3D objects: orthographic views of a model for
 * the board's high level of detail, and the packaged top/front/side views of a modeled asset.
 * Callers pass the objects to draw and the viewing frame; the image comes back as a canvas.
 */
import * as THREE from 'three';

export type OrthoView = 'top' | 'front' | 'side';
/** Display styles a still can be rendered in (superset of the board's styles). */
export type StillStyle = 'realistic' | 'color' | 'shaded' | 'wireframe' | 'hidden-line';

export interface StillOptions {
  objects: THREE.Object3D[];
  view: OrthoView;
  style?: StillStyle;
  /** Longest side of the image in pixels. */
  size?: number;
  /** Clip everything nearer to the camera than this coordinate on the view's axis (a section). */
  clipAt?: number;
  /** Bounds to frame; default: the objects' bounds. */
  bounds?: THREE.Box3;
  background?: number | null;
}

let renderer: THREE.WebGLRenderer | null = null;

function getRenderer(): THREE.WebGLRenderer {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
  }
  return renderer;
}

/** Camera direction (towards the model), screen-up and the clipping normal of each view. */
export function orthoFrame(view: OrthoView): { dir: THREE.Vector3; up: THREE.Vector3; clip: THREE.Vector3 } {
  if (view === 'top') return { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1), clip: new THREE.Vector3(0, -1, 0) };
  if (view === 'front') return { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0), clip: new THREE.Vector3(0, 0, -1) };
  return { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0), clip: new THREE.Vector3(-1, 0, 0) };
}

const STYLE_MATERIALS = {
  shaded: new THREE.MeshLambertMaterial({ color: 0xb9bdc6 }),
  wireframe: new THREE.MeshBasicMaterial({ color: 0x3a3a3f, wireframe: true }),
  hiddenLine: new THREE.MeshBasicMaterial({ color: 0xfbfbfc, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
  edges: new THREE.LineBasicMaterial({ color: 0x2b2d33 }),
};

/** Applies a display style to a (cloned) object tree; returns a function that undoes it. */
export function styleObject(root: THREE.Object3D, style: StillStyle): () => void {
  if (style === 'realistic') return () => {};
  const undo: (() => void)[] = [];
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const original = child.material as THREE.Material | THREE.Material[];
    undo.push(() => {
      child.material = original;
    });
    switch (style) {
      case 'color': {
        const toFlat = (material: THREE.Material) => {
          const source = material as Partial<THREE.MeshStandardMaterial>;
          return new THREE.MeshBasicMaterial({ color: source.color ?? new THREE.Color(0x9a9aa3), map: source.map ?? null, side: material.side, transparent: material.transparent, opacity: material.opacity });
        };
        child.material = Array.isArray(original) ? original.map(toFlat) : toFlat(original);
        break;
      }
      case 'shaded':
        child.material = STYLE_MATERIALS.shaded;
        break;
      case 'wireframe':
        child.material = STYLE_MATERIALS.wireframe;
        break;
      case 'hidden-line': {
        child.material = STYLE_MATERIALS.hiddenLine;
        // Feature edges at 20°: enough to outline curved parts without hatching flat ones.
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(child.geometry as THREE.BufferGeometry, 20), STYLE_MATERIALS.edges);
        child.add(edges);
        undo.push(() => {
          child.remove(edges);
          edges.geometry.dispose();
        });
        break;
      }
    }
  });
  return () => {
    for (const step of undo.reverse()) step();
  };
}

/** Renders an orthographic still of the objects; the caller owns the returned canvas. */
export function renderStill(options: StillOptions): HTMLCanvasElement {
  const gl = getRenderer();
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0aa, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(6000, 10000, 4000);
  scene.add(sun);
  const holder = new THREE.Group();
  for (const object of options.objects) holder.add(object);
  scene.add(holder);
  holder.updateMatrixWorld(true);

  const bounds = options.bounds ?? new THREE.Box3().setFromObject(holder);
  const centre = bounds.getCenter(new THREE.Vector3());
  const extent = bounds.getSize(new THREE.Vector3());
  const { dir, up, clip } = orthoFrame(options.view);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  // Half-extents of the bounds along the screen axes.
  const halfWidth = Math.max(1, (Math.abs(extent.x * right.x) + Math.abs(extent.y * right.y) + Math.abs(extent.z * right.z)) / 2);
  const halfHeight = Math.max(1, (Math.abs(extent.x * up.x) + Math.abs(extent.y * up.y) + Math.abs(extent.z * up.z)) / 2);
  const depth = extent.length() + 10;
  const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 1, depth * 2 + 10);
  camera.up.copy(up);
  camera.position.copy(centre).sub(dir.clone().multiplyScalar(depth));
  camera.lookAt(centre);
  camera.updateProjectionMatrix();

  const size = options.size ?? 1024;
  const width = halfWidth >= halfHeight ? size : Math.max(1, Math.round((size * halfWidth) / halfHeight));
  const height = halfWidth >= halfHeight ? Math.max(1, Math.round((size * halfHeight) / halfWidth)) : size;
  gl.setSize(width, height, false);
  gl.setClearColor(options.background ?? 0x000000, options.background === null || options.background === undefined ? 0 : 1);
  gl.clippingPlanes = options.clipAt === undefined ? [] : [new THREE.Plane(clip, options.clipAt)];
  const restore = styleObject(holder, options.style ?? 'realistic');
  gl.render(scene, camera);
  restore();
  gl.clippingPlanes = [];
  for (const object of options.objects) holder.remove(object);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(gl.domElement, 0, 0);
  return canvas;
}

export interface PerspectiveStillOptions {
  objects: THREE.Object3D[];
  eye: [number, number, number];
  aim: [number, number, number];
  fov: number;
  style?: StillStyle;
  width?: number;
  height?: number;
  background?: number | null;
}

/** Renders a perspective still through a camera (eye → aim, vertical FOV in degrees). */
export function renderPerspectiveStill(options: PerspectiveStillOptions): HTMLCanvasElement {
  const gl = getRenderer();
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0aa, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(6000, 10000, 4000);
  scene.add(sun);
  const holder = new THREE.Group();
  for (const object of options.objects) holder.add(object);
  scene.add(holder);
  holder.updateMatrixWorld(true);
  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const eye = new THREE.Vector3(...options.eye);
  const aim = new THREE.Vector3(...options.aim);
  const camera = new THREE.PerspectiveCamera(options.fov, width / height, 10, Math.max(50_000, eye.distanceTo(aim) * 20));
  camera.position.copy(eye);
  camera.lookAt(aim);
  camera.updateProjectionMatrix();
  gl.setSize(width, height, false);
  gl.setClearColor(options.background ?? 0xffffff, options.background === null ? 0 : 1);
  gl.clippingPlanes = [];
  const restore = styleObject(holder, options.style ?? 'realistic');
  gl.render(scene, camera);
  restore();
  for (const object of options.objects) holder.remove(object);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(gl.domElement, 0, 0);
  return canvas;
}

export function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode the image'));
        return;
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)));
    }, 'image/png');
  });
}
