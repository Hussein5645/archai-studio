/**
 * Conceptual massing on the site: simple vertical extrusions ("forms") of a plan profile between
 * a start and an end elevation. Solids add volume, voids cut it. A form's profile is the site
 * boundary or a drawn outline, shrunk by an inset (a setback; negative grows it).
 *
 * Forms are ordinary closed lines inside a "Site concept" group hosted by the map, so they save,
 * undo, show in Layers and draw on the board like anything else. `meta.massing` keeps what the
 * profile was made from, so the concept editor can re-derive it when the inset changes.
 *
 * Solid − void booleans use Manifold (WASM). Its bindings compile code at runtime, which the
 * app's Content-Security-Policy forbids on the main thread, so they run in ./massing.worker.ts
 * and come back as vertex arrays (cached, so the synchronous 3D scene builder can use them).
 */
import type { CrossSection, ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import type { ArchaiDocument, Element, ElementTable } from '@/document';
import { applyToPoint, linePoints, worldMatrix } from '@/geometry';

export type Plan = [number, number][];

export interface MassingMeta {
  mapId: string;
  kind: 'solid' | 'void';
  /** 'boundary' = the map's site boundary; 'drawn' = `base` below. */
  source: 'boundary' | 'drawn';
  /** Drawn outline (in the concept group's frame) before the inset. */
  base?: Plan;
  /** Setback in millimetres: positive shrinks the profile, negative grows it. */
  inset: number;
  /** Elevations in millimetres. */
  start: number;
  end: number;
}

export interface Form {
  id: string;
  name: string;
  meta: MassingMeta;
  /** Resulting profile in world millimetres. */
  profile: Plan;
  visible: boolean;
}

/** What the booleans need from a form (plain data, so it crosses into the worker). */
export type FormSolid = Pick<Form, 'profile' | 'visible'> & { meta: Pick<MassingMeta, 'kind' | 'start' | 'end'> };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function massingOf(element: Element | undefined | null): MassingMeta | null {
  const value = record(element?.meta?.['massing']);
  if (!value || typeof value['mapId'] !== 'string' || (value['kind'] !== 'solid' && value['kind'] !== 'void')) return null;
  return {
    mapId: value['mapId'],
    kind: value['kind'],
    source: value['source'] === 'boundary' ? 'boundary' : 'drawn',
    ...(Array.isArray(value['base']) ? { base: value['base'] as Plan } : {}),
    inset: typeof value['inset'] === 'number' ? value['inset'] : 0,
    start: typeof value['start'] === 'number' ? value['start'] : 0,
    end: typeof value['end'] === 'number' ? value['end'] : 3000,
  };
}

export function isConceptGroup(element: Element | undefined | null): boolean {
  return Boolean(record(element?.meta?.['siteConcept']));
}

export function conceptRoot(doc: Pick<ArchaiDocument, 'elements'>, mapId: string): Element | null {
  return Object.values(doc.elements).find((e) => record(e.meta?.['siteConcept'])?.['mapId'] === mapId) ?? null;
}

/** Forms of a concept group, profiles in world millimetres. */
export function formsOf(elements: ElementTable, rootId: string): Form[] {
  const forms: Form[] = [];
  const visit = (parentId: string) => {
    for (const element of Object.values(elements)) {
      if (element.parentId !== parentId) continue;
      if (element.kind === 'group') { visit(element.id); continue; }
      const meta = massingOf(element);
      if (!meta || element.kind !== 'line') continue;
      const matrix = worldMatrix(elements, element);
      forms.push({ id: element.id, name: element.name ?? '', meta, visible: element.visible, profile: linePoints(element).map(([x, y]) => { const p = applyToPoint(matrix, { x, y }); return [p.x, p.y] as [number, number]; }) });
    }
  };
  visit(rootId);
  return forms;
}

// ---- geometry (pure; runs in the massing worker and in tests) ---------------------------------

function polygonArea(points: Plan): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** A profile shrunk by `inset` (grown when negative); the largest piece if it splits. */
export function insetProfile(toplevel: ManifoldToplevel, base: Plan, inset: number): Plan {
  if (base.length < 3) return [];
  if (Math.abs(inset) < 1e-6) return base.map((p) => [p[0], p[1]]);
  const section = new toplevel.CrossSection([base], 'NonZero');
  const shrunk = section.offset(-inset, 'Miter', 2);
  const pieces = shrunk.toPolygons().map((polygon) => polygon.map((p) => [p[0], p[1]] as [number, number]));
  section.delete();
  shrunk.delete();
  let best: Plan = [];
  for (const piece of pieces) if (Math.abs(polygonArea(piece)) > Math.abs(polygonArea(best))) best = piece;
  return best;
}

/**
 * The massing as non-indexed triangle positions in scene axes (x, height, plan y): the union of
 * solids minus the union of voids. Null when there is nothing solid left.
 */
export function massingPositions(toplevel: ManifoldToplevel, forms: FormSolid[]): Float32Array | null {
  const garbage: { delete(): void }[] = [];
  const prism = (form: FormSolid) => {
    const height = form.meta.end - form.meta.start;
    if (form.profile.length < 3 || height <= 0) return null;
    const section: CrossSection = new toplevel.CrossSection([form.profile], 'NonZero');
    garbage.push(section);
    if (section.isEmpty()) return null;
    const solid = section.extrude(height).translate([0, 0, form.meta.start]);
    garbage.push(solid);
    return solid;
  };
  try {
    const solids = forms.filter((f) => f.visible && f.meta.kind === 'solid').map(prism).filter((m) => m !== null);
    if (!solids.length) return null;
    const voids = forms.filter((f) => f.visible && f.meta.kind === 'void').map(prism).filter((m) => m !== null);
    let result = toplevel.Manifold.union(solids);
    garbage.push(result);
    if (voids.length) {
      const cut = toplevel.Manifold.union(voids);
      garbage.push(cut);
      result = result.subtract(cut);
      garbage.push(result);
    }
    if (result.isEmpty()) return null;
    const mesh = result.getMesh();
    const stride = mesh.numProp;
    const positions = new Float32Array(mesh.triVerts.length * 3);
    let o = 0;
    // Manifold (x, y plan, z up) to scene (x, z up as y, y plan as z). Swapping two axes mirrors
    // the mesh, so each triangle is re-wound to keep its normal pointing out.
    const vertex = (index: number) => {
      positions[o++] = mesh.vertProperties[index * stride]!;
      positions[o++] = mesh.vertProperties[index * stride + 2]!;
      positions[o++] = mesh.vertProperties[index * stride + 1]!;
    };
    for (let t = 0; t < mesh.triVerts.length; t += 3) {
      vertex(mesh.triVerts[t]!);
      vertex(mesh.triVerts[t + 2]!);
      vertex(mesh.triVerts[t + 1]!);
    }
    return positions;
  } finally {
    for (const item of garbage) item.delete();
  }
}

export function geometryFromPositions(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A form as a plain prism (voids in previews, and solids until the booleans are ready). */
export function prismGeometry(form: FormSolid): THREE.BufferGeometry | null {
  const height = form.meta.end - form.meta.start;
  if (form.profile.length < 3 || height <= 0) return null;
  const shape = new THREE.Shape(form.profile.map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  // Extrudes along +Z; plan XY to scene XZ with the depth pointing up from `start`.
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, form.meta.end, 0);
  return geometry;
}

// ---- worker client and cache ------------------------------------------------------------------

type WorkerReply = { id: number; positions?: Float32Array | null; profile?: Plan; error?: string };
let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void }>();

function call(message: Record<string, unknown>): Promise<WorkerReply> {
  if (!worker) {
    worker = new Worker(new URL('./massing.worker.ts', import.meta.url), { type: 'module', name: 'massing' });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const waiter = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      if (!waiter) return;
      if (event.data.error) waiter.reject(new Error(event.data.error));
      else waiter.resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      for (const waiter of waiting.values()) waiter.reject(new Error(event.message || 'The geometry engine stopped'));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker!.postMessage({ ...message, id });
  });
}

const plain = (forms: FormSolid[]): FormSolid[] => forms.map((f) => ({ profile: f.profile, visible: f.visible, meta: { kind: f.meta.kind, start: f.meta.start, end: f.meta.end } }));

/** Stable key of what the booleans depend on. */
export function massingKey(forms: FormSolid[]): string {
  return JSON.stringify(plain(forms).filter((f) => f.visible));
}

const cache = new Map<string, Float32Array | null>();
const CACHE_LIMIT = 40;

function remember(key: string, positions: Float32Array | null): void {
  cache.set(key, positions);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** The solid − void mesh for these forms (from the cache, else computed in the worker). */
export async function computeMassing(forms: FormSolid[]): Promise<Float32Array | null> {
  const key = massingKey(forms);
  if (cache.has(key)) return cache.get(key)!;
  const reply = await call({ type: 'mesh', forms: plain(forms) });
  const positions = reply.positions ?? null;
  remember(key, positions);
  return positions;
}

/** Cached result only (sync, for the 3D scene builder); undefined when not computed yet. */
export function cachedMassing(forms: FormSolid[]): Float32Array | null | undefined {
  return cache.get(massingKey(forms));
}

/** Puts a computed result in the cache (tests, or results computed elsewhere). */
export function primeMassing(forms: FormSolid[], positions: Float32Array | null): void {
  remember(massingKey(forms), positions);
}

export async function insetProfileAsync(base: Plan, inset: number): Promise<Plan> {
  if (Math.abs(inset) < 1e-6) return base.map((p) => [p[0], p[1]]);
  return (await call({ type: 'inset', base, inset })).profile ?? [];
}

/** Computes the massing of every site concept in the document; true when something new is ready. */
export async function prepareMassing(doc: ArchaiDocument): Promise<boolean> {
  if (typeof Worker === 'undefined') return false;
  let changed = false;
  for (const element of Object.values(doc.elements)) {
    if (!isConceptGroup(element)) continue;
    const forms = formsOf(doc.elements, element.id);
    if (cachedMassing(forms) !== undefined) continue;
    try {
      await computeMassing(forms);
      changed = true;
    } catch {
      // The plain prisms stay; the next document change retries.
    }
  }
  return changed;
}
