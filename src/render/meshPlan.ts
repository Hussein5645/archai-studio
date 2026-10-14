/**
 * Mesh elements on the 2D board drawn like a CAD plan, not as their box: a plan section cut at
 * 1.2 m (bold, like Revit's view range) and the visible edges below it (thin); low objects
 * (furniture, slabs, roofs) show all their edges seen from above. Edges are the mesh's feature
 * edges: outlines and creases, not the triangulation of flat faces.
 *
 * Mesh blobs are binary glTF with vertices in millimetres as (x, up, plan y) from the element's
 * box corner (src/view3d/meshes.ts). Plans are computed in the background (a few at a time) and
 * cached per blob; static rendering (sheets, export) computes them on the spot.
 */
import { base64ToBytes } from '@/persistence/base64';

export interface MeshPlan {
  /** Section lines at the cut height: x1, y1, x2, y2, ... (element-local mm). */
  cut: number[];
  /** Visible edges below the cut, projected: x1, y1, x2, y2, ... */
  edges: number[];
}

/** Section height above the element's base, as in a CAD floor plan. */
export const CUT_HEIGHT = 1200;
/** Objects not much taller than the cut are shown whole, from above. */
const WHOLE_BELOW = 1500;
/** Faces meeting at more than this are an edge (smaller angles are one smooth or flat surface). */
const CREASE_DEGREES = 25;
const MAX_SEGMENTS = 30000;

// ---- glTF reading (positions and indices of every triangle primitive, in scene space) ----

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
    out[col * 4 + row] = sum;
  }
  return out;
}

interface GltfNode { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; mesh?: number; children?: number[];
}

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx! + qx!, y2 = qy! + qy!, z2 = qz! + qz!;
  const xx = qx! * x2, xy = qx! * y2, xz = qx! * z2, yy = qy! * y2, yz = qy! * z2, zz = qz! * z2;
  const wx = qw! * x2, wy = qw! * y2, wz = qw! * z2;
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

/** All triangles of a binary glTF: flat [x, up, z] per vertex, 3 vertices per triangle. */
export function glbTriangles(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return new Float32Array();
  let json: {
    nodes?: GltfNode[];
    scenes?: { nodes?: number[] }[];
    scene?: number;
    meshes?: { primitives?: { mode?: number; attributes?: { POSITION?: number }; indices?: number }[];
    }[];
    accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string;
    }[];
    bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  } | null = null;
  let bin: Uint8Array | null = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) bin = chunk;
    offset += 8 + length;
  }
  if (!json || !bin) return new Float32Array();
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const read = (index: number): Float64Array => {
    const accessor = json!.accessors?.[index];
    if (!accessor || accessor.bufferView === undefined) return new Float64Array();
    const bufferView = json!.bufferViews![accessor.bufferView]!;
    const components = accessor.type === 'VEC3' ? 3 : accessor.type === 'VEC2' ? 2 : accessor.type === 'VEC4' ? 4 : 1;
    const size = accessor.componentType === 5126 || accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 || accessor.componentType === 5122 ? 2 : 1;
    const stride = bufferView.byteStride ?? size * components;
    const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const out = new Float64Array(accessor.count * components);
    for (let i = 0; i < accessor.count; i++) {
      for (let c = 0; c < components; c++) {
        const at = start + i * stride + c * size;
        out[i * components + c] =
          accessor.componentType === 5126 ? data.getFloat32(at, true)
          : accessor.componentType === 5125 ? data.getUint32(at, true)
          : accessor.componentType === 5123 ? data.getUint16(at, true)
          : accessor.componentType === 5122 ? data.getInt16(at, true)
          : accessor.componentType === 5121 ? data.getUint8(at)
          : data.getInt8(at);
      }
    }
    return out;
  };
  let counting = true;
  let length = 0;
  let offset = 0;
  let triangles = new Float32Array();
  const visit = (index: number, parent: Mat4) => {
    const node = json!.nodes?.[index];
    if (!node) return;
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of json!.meshes?.[node.mesh]?.primitives ?? []) {
        if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) continue;
        if (counting) {
          length += (json!.accessors?.[primitive.indices ?? primitive.attributes.POSITION]?.count ?? 0) * 3;
          continue;
        }
        const p = read(primitive.attributes.POSITION);
        const idx = primitive.indices !== undefined ? read(primitive.indices) : Array.from({ length: p.length / 3 }, (_, i) => i);
        for (const i of idx) {
          const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
          triangles[offset++] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
          triangles[offset++] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
          triangles[offset++] = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? (json.nodes ?? []).map((_, i) => i);
  for (const root of roots) visit(root, IDENTITY);
  counting = false;
  triangles = new Float32Array(length);
  for (const root of roots) visit(root, IDENTITY);
  return triangles;
}

// ---- the plan ----

/** The CAD plan of a mesh's triangles ([x, up, plan y] per vertex). */
export function planOfTriangles(t: Float32Array): MeshPlan {
  const plan: MeshPlan = { cut: [], edges: [] };
  const count = Math.floor(t.length / 9);
  if (count === 0) return plan;
  let minUp = Infinity;
  let maxUp = -Infinity;
  for (let i = 1; i < t.length; i += 3) {
    minUp = Math.min(minUp, t[i]!);
    maxUp = Math.max(maxUp, t[i]!);
  }
  const whole = maxUp - minUp <= WHOLE_BELOW;
  const cut = minUp + CUT_HEIGHT;

  // Section lines where the cut plane crosses each triangle.
  if (!whole) {
    for (let f = 0; f < count && plan.cut.length < MAX_SEGMENTS * 4; f++) {
      const points: number[] = [];
      for (let e = 0; e < 3; e++) {
        const a = f * 9 + e * 3;
        const b = f * 9 + ((e + 1) % 3) * 3;
        const ua = t[a + 1]! - cut;
        const ub = t[b + 1]! - cut;
        if ((ua < 0 && ub >= 0) || (ua >= 0 && ub < 0)) {
          const k = ua / (ua - ub);
          points.push(t[a]! + (t[b]! - t[a]!) * k, t[a + 2]! + (t[b + 2]! - t[a + 2]!) * k);
        }
      }
      if (points.length === 4) plan.cut.push(points[0]!, points[1]!, points[2]!, points[3]!);
    }
  }

  // Feature edges: welded by position (parts of a mesh do not share vertices), kept where faces
  // meet at a crease or an edge is open; flat-face diagonals drop out.
  const key = (i: number) => `${Math.round(t[i]! * 2)},${Math.round(t[i + 1]! * 2)},${Math.round(t[i + 2]! * 2)}`;
  const crease = Math.cos((CREASE_DEGREES * Math.PI) / 180);
  const edges = new Map<string, { a: number; b: number; normal: number[]; count: number; smooth: boolean }>();
  for (let f = 0; f < count; f++) {
    const o = f * 9;
    const ux = t[o + 3]! - t[o]!, uy = t[o + 4]! - t[o + 1]!, uz = t[o + 5]! - t[o + 2]!;
    const vx = t[o + 6]! - t[o]!, vy = t[o + 7]! - t[o + 1]!, vz = t[o + 8]! - t[o + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-9) continue;
    nx /= length; ny /= length; nz /= length;
    for (let e = 0; e < 3; e++) {
      const a = o + e * 3;
      const b = o + ((e + 1) % 3) * 3;
      // These edges never appear in the plan; avoid storing them for large projects.
      if (!whole && (t[a + 1]! > cut + 1 || t[b + 1]! > cut + 1)) continue;
      if (Math.hypot(t[b]! - t[a]!, t[b + 2]! - t[a + 2]!) < 1) continue;
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const entry = edges.get(k);
      if (entry) {
        entry.count++;
        entry.smooth = entry.normal[0]! * nx + entry.normal[1]! * ny + entry.normal[2]! * nz > crease;
      } else edges.set(k, { a, b, normal: [nx, ny, nz], count: 1, smooth: false });
    }
  }
  const seen = new Set<string>();
  for (const { a, b, count, smooth } of edges.values()) {
    if (plan.edges.length >= MAX_SEGMENTS * 4) break;
    if (count === 2 && smooth) continue;
    // Above the cut: not seen in a plan.
    if (!whole && (t[a + 1]! > cut + 1 || t[b + 1]! > cut + 1)) continue;
    const x1 = t[a]!, y1 = t[a + 2]!, x2 = t[b]!, y2 = t[b + 2]!;
    // Vertical edges are points in plan.
    if (Math.hypot(x2 - x1, y2 - y1) < 1) continue;
    const k = [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
    const id = k[0]! < k[2]! || (k[0] === k[2] && k[1]! <= k[3]!) ? k.join(',') : [k[2], k[3], k[0], k[1]].join(',');
    if (seen.has(id)) continue;
    seen.add(id);
    plan.edges.push(x1, y1, x2, y2);
  }
  return plan;
}

export function planOfBlob(data: string): MeshPlan {
  try {
    return planOfTriangles(glbTriangles(base64ToBytes(data)));
  } catch {
    return { cut: [], edges: [] };
  }
}

/** SVG path data of segments. */
export function segmentsPath(segments: readonly number[]): string {
  let d = '';
  for (let i = 0; i + 3 < segments.length; i += 4) d += `M${segments[i]!.toFixed(1)} ${segments[i + 1]!.toFixed(1)}L${segments[i + 2]!.toFixed(1)} ${segments[i + 3]!.toFixed(1)}`;
  return d;
}

/** Plans by blob id, computed in the background a few at a time; the board re-renders as they arrive. */
export class MeshPlanStore {
  private readonly plans = new Map<string, MeshPlan>();
  private readonly queue = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private scheduled = false;
  private worker: Worker | null = null;
  private processing: string | null = null;

  private publish(blobId: string, plan: MeshPlan): void {
    this.plans.set(blobId, plan);
    this.processing = null;
    this.scheduled = false;
    this.version += 1;
    for (const listener of this.listeners) listener();
    if (this.queue.size) this.schedule();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** The plan now if computed (or `sync`: computed on the spot), else queued and null. */
  get(blobId: string, data: string, sync = false): MeshPlan | null {
    const plan = this.plans.get(blobId);
    if (plan) return plan;
    if (sync) {
      const computed = planOfBlob(data);
      this.plans.set(blobId, computed);
      return computed;
    }
    if (this.processing !== blobId) this.queue.set(blobId, data);
    this.schedule();
    return null;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // One job at a time bounds copied payloads. Dense geometry never runs on the UI thread.
    if (typeof Worker !== 'undefined') {
      this.worker ??= new Worker(new URL('./meshPlan.worker.ts', import.meta.url), {
        type: 'module',
        name: 'mesh-plans',
      });
      const [blobId, data] = this.queue.entries().next().value!;
      this.processing = blobId;
      this.queue.delete(blobId);
      this.worker.onmessage = (event: MessageEvent<MeshPlan>) => this.publish(blobId, event.data);
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = null;
        this.publish(blobId, { cut: [], edges: [] });
      };
      this.worker.postMessage(data);
      return;
    }
    setTimeout(() => {
      this.scheduled = false;
      const started = performance.now();
      for (const [blobId, data] of this.queue) {
        this.queue.delete(blobId);
        this.plans.set(blobId, planOfBlob(data));
        if (performance.now() - started > 24) break;
      }
      this.version += 1;
      for (const listener of this.listeners) listener();
      if (this.queue.size) this.schedule();
    }, 0);
  }
}

export const meshPlanStore = new MeshPlanStore();
