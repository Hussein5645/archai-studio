/**
 * Builds three.js objects from the document. Every system type knows its own 3D logic here
 * (walls extrude their layers and cut door/window openings, doors hang an open leaf, windows
 * sit at their sill, stairs stack treads from their flights); everything else is extruded from
 * its footprint using `meta.solid = { height, elevation }`.
 *
 * Axes: document x → scene X, document y → scene Z, height → scene Y (up). Units stay in mm.
 */
import * as THREE from 'three';
import { slabOpenings } from '@/assets/slabOpenings';
import { archOf, archTypeOf, elementLod, hostOf, isArchType } from '@/assets/arch-meta';
import { stairFlightsOf, wallThicknessOf } from '@/commands/builtin/system';
import { flightLength, type StairFlight } from '@/assets/system-geometry';
import { parseSystemParameters } from '@/catalog';
import type { ArchaiDocument, Element, ElementTable, LineElement } from '@/document';
import { ancestorsOf, childrenOf } from '@/document';
import { applyToPoint, linePoints, worldMatrix, type Mat, type Vec2 } from '@/geometry';
import { wallOpeningCandidates, wallOpeningsFor } from '@/interaction/wallSnap';
import { cachedMassing, formsOf, geometryFromPositions, isConceptGroup, prismGeometry } from '@/analysis/massing';
import { graphicsResolver, type GraphicsOverrides } from '@/graphics';
import { isPoint } from '@/document/point';
import { pointMarker } from './pointMarker';
import { vrStopOf } from '@/document/vrStop';
import type { SurfacePaint } from '@/document';
import { instanceMaterialsOf, materialById, paintedMaterialId, surfacePaintOf, typeMaterialsOf, ZONED_SURFACES, type SurfaceKey } from '@/materials/slots';
import { threeMaterial } from '@/materials/three';
import { applyWorldUvs, groupByNormal } from './surfaceUv';
import { meshOf, meshStore, type MeshMeta } from './meshes';
import { footprintOfBounds, instanceOverrides, parametricInstanceOf, recipeOf } from '@/catalog/parametric';
import { composeRebuilt, rebuiltModel } from './parametricModels';

export interface SolidMeta {
  height: number;
  elevation: number;
}

/** Height/elevation of a non-system element (`meta.solid`), with kind-based defaults. */
export function solidOf(element: Element): SolidMeta {
  const value = element.meta?.['solid'];
  const solid = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const height = typeof solid['height'] === 'number' && solid['height'] >= 0 ? solid['height'] : element.kind === 'instance' ? 900 : element.kind === 'rect' ? 0 : 0;
  const elevation = typeof solid['elevation'] === 'number' ? solid['elevation'] : 0;
  return { height, elevation };
}

/** Configured elevation before a per-instance board override is applied. */
export function baseElevationOf(element: Element): number {
  const type = archTypeOf(element);
  const arch = archOf(element);
  if (type === 'wall') return parseSystemParameters('wall', arch?.['parameters']).elevation;
  if (type === 'column') return parseSystemParameters('column', arch?.['parameters']).elevation;
  if (type === 'stair') return parseSystemParameters('stair', arch?.['parameters']).elevation;
  if (type === 'railing') return parseSystemParameters('railing', arch?.['parameters']).elevation;
  if (type === 'door') return parseSystemParameters('door', arch?.['parameters']).threshold;
  if (type === 'window') return parseSystemParameters('window', arch?.['parameters']).sill;
  return solidOf(element).elevation;
}

export function instanceElevationOf(
  element: Element,
  elements?: ElementTable | Readonly<Record<string, Element>>,
  seen?: Set<string>,
): number {
  const value = element.meta?.['instanceElevation'];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (elements) {
    const hostId = hostOf(element);
    if (hostId && elements[hostId]) {
      const visited = seen ?? new Set<string>();
      if (!visited.has(element.id)) {
        visited.add(element.id);
        return instanceElevationOf(elements[hostId]!, elements, visited) + baseElevationOf(element);
      }
    }
  }
  return baseElevationOf(element);
}

export function levelElevationOf(element: Element): number | null {
  const value = element.meta?.['level'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const elevation = value['elevation'];
  return typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : null;
}

/**
 * Materials (docs/materials.md): every mesh asks its element for the material of a **slot** or
 * of a painted **surface** (see src/materials/slots.ts), as a shared three.js material. Meshes
 * carry `userData.slot`, `userData.surfaces` (the surface of each geometry group, null for hidden
 * internal faces), `userData.cutMaterial` (the slot's material id, for material cut hatches) and
 * `userData.cutKey` (`<type>` or `<type>:<part>`), so painting can tell what was clicked and a
 * section view can cap it.
 */
const MISSING_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xc9ccd3, roughness: 0.85 });

interface Look {
  /** Material id of a slot: assigned (element, then type), else the slot's default. */
  slotId(slot: string, fallback: string): string;
  /** The material of a slot (assigned, else its default). */
  slot(slot: string, fallback: string, doubleSided?: boolean): THREE.Material;
  /** Only an assigned material, else null (for slots whose default is the element's own colour). */
  assigned(slot: string, doubleSided?: boolean): THREE.Material | null;
  /** The paint on a surface piece spanning [u0, u1] × [v0, v1] (face mm), else null. */
  paint(surface: SurfaceKey, u0?: number, u1?: number, v0?: number, v1?: number): THREE.Material | null;
  /** Whether any paint on the surface has a zone (the face is then split at zone edges). */
  zoned(surface: SurfaceKey): readonly SurfacePaint[];
}

function lookOf(doc: ArchaiDocument, element: Element): Look {
  const paints = surfacePaintOf(element);
  const own = instanceMaterialsOf(element);
  const typed = typeMaterialsOf(element);
  const explicit = (slot: string) => own[slot] ?? typed[slot] ?? null;
  const three = (id: string, fallback: string, doubleSided = false) => {
    const material = materialById(doc, id) ?? materialById(doc, fallback);
    return material ? threeMaterial(material, doc, doubleSided) : MISSING_MATERIAL;
  };
  return {
    slotId: (slot, fallback) => explicit(slot) ?? fallback,
    slot: (slot, fallback, doubleSided) => three(explicit(slot) ?? fallback, fallback, doubleSided),
    assigned: (slot, doubleSided) => {
      const id = explicit(slot);
      return id && materialById(doc, id) ? three(id, id, doubleSided) : null;
    },
    paint: (surface, u0 = 0, u1 = 0, v0 = 0, v1 = 0) => {
      const list = paints[surface];
      if (!list?.length) return null;
      // Only wall sides have a face frame for zones; elsewhere a surface's last paint covers it.
      const id = ZONED_SURFACES.includes(surface) ? paintedMaterialId(list, u0, u1, v0, v1) : list.at(-1)!.material;
      return id && materialById(doc, id) ? three(id, id) : null;
    },
    zoned: (surface) => (paints[surface] ?? []).filter((paint) => paint.zone),
  };
}

/**
 * Splits a mesh into top / bottom / sides groups and gives each its surface's paint (else
 * `base`), tagging the slot and surfaces for painting.
 */
function surfaceMesh(mesh: THREE.Mesh, look: Look, slot: string, base: THREE.Material, slotId: string): THREE.Mesh {
  const surfaces: SurfaceKey[] = ['top', 'bottom', 'sides'];
  const painted = surfaces.map((surface) => look.paint(surface));
  if (painted.some(Boolean)) {
    mesh.geometry = groupByNormal(mesh.geometry);
    mesh.material = painted.map((material) => material ?? base);
    mesh.userData['surfaces'] = surfaces;
  } else {
    mesh.material = base;
    mesh.userData['surfaces'] = null;
    // Painting needs to know which surface a click hit, even before anything is painted.
    mesh.userData['surfaceByNormal'] = true;
  }
  mesh.userData['slot'] = slot;
  mesh.userData['cutMaterial'] = slotId;
  return mesh;
}

/** Tags a slot on every mesh under `object`. */
function slotted<T extends THREE.Object3D>(object: T, slot: string, slotId: string): T {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.userData['slot'] === undefined) {
      child.userData['slot'] = slot;
      child.userData['cutMaterial'] = slotId;
    }
  });
  return object;
}

/** Marks every mesh under `object` with the cut-surface key a section uses to cap it. */
function cutKey(object: THREE.Object3D, key: string): THREE.Object3D {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && !child.userData['cutKey']) child.userData['cutKey'] = key;
  });
  return object;
}

/**
 * One top-level element's 3D object, with what it was built from: the document elements it
 * read (see `sceneDependencies`) and the shared inputs. `buildScene` reuses it as long as
 * none of those changed (documents are immutable, so identity means unchanged).
 */
export type Built = { id: string; object: THREE.Object3D; dependencies?: readonly Element[]; inputs?: BuildInputs;
};

/** Document-wide inputs every builder may read (materials, definitions, images, models, LOD). */
interface BuildInputs {
  workspace: ArchaiDocument['workspace'];
  definitions: ArchaiDocument['definitions'];
  blobs: ArchaiDocument['blobs'];
  materials: ArchaiDocument['materials'];
  textures: BuildOptions['textures'];
  models: BuildOptions['models'];
  lowModels: BuildOptions['lowModels'];
  lod: BuildOptions['lod'];
  drawing: BuildOptions['drawing'];
}

function sameInputs(a: BuildInputs, b: BuildInputs): boolean {
  return (
    a.workspace === b.workspace && a.definitions === b.definitions && a.blobs === b.blobs && a.materials === b.materials && a.textures === b.textures && a.models === b.models && a.lowModels === b.lowModels && a.lod === b.lod && a.drawing === b.drawing
  );
}

function sameElements(a: readonly Element[], b: readonly Element[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Every element a top-level element's 3D object is built from: its subtree (groups, stairs and
 * their railings fold their children in), the ancestor and host chains of each (world matrices,
 * hosted elevations), and for walls the openings they cut plus those openings' chains.
 */
export function sceneDependencies(elements: ElementTable, element: Element): Element[] {
  const out: Element[] = [];
  const seen = new Set<string>();
  const chain = (item: Element | undefined) => {
    for (let current = item; current && !seen.has(current.id); current = elements[hostOf(current) ?? '']) {
      seen.add(current.id);
      out.push(current);
      for (const ancestor of ancestorsOf(elements, current.id)) chain(ancestor);
    }
  };
  const subtree = (item: Element) => {
    chain(item);
    if (isArchType(item, 'wall')) for (const opening of wallOpeningCandidates(item.id, elements)) chain(opening);
    for (const child of childrenOf(elements, item.id)) subtree(child);
  };
  subtree(element);
  return out;
}

function tagged(object: THREE.Object3D, id: string): THREE.Object3D {
  object.traverse((child) => {
    child.userData['elementId'] = id;
  });
  return object;
}

function toScene(p: Vec2, y = 0): THREE.Vector3 {
  return new THREE.Vector3(p.x, y, p.y);
}

/** A box between two plan points, `thickness` across, from `bottom` to `top`. */
function segmentBox(a: Vec2, b: Vec2, thickness: number, bottom: number, top: number, material: THREE.Material, across = 0): THREE.Mesh | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const height = top - bottom;
  if (length <= 0 || height <= 0 || thickness <= 0) return null;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, thickness), material);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // +across = the wall's right-hand side in plan (y down), which is +Z after rotation.
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  mesh.position.set(mid.x + nx * across, bottom + height / 2, mid.y + ny * across);
  mesh.rotation.y = -angle;
  return mesh;
}

/**
 * One continuous strip of `width` along a plan polyline, between two heights: mitred joins
 * (limited on hairpins) instead of a box per segment, so roads and thick lines read as one clean
 * solid with no gaps or overlapping ends. Built as raw triangles, so a self-overlapping inner
 * corner never breaks triangulation.
 */
export function ribbonMesh(points: Vec2[], width: number, bottom: number, top: number, material: THREE.Material, closed = false): THREE.Mesh | null {
  const path = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y) > 1e-6);
  if (closed && path.length > 2 && Math.hypot(path[0]!.x - path.at(-1)!.x, path[0]!.y - path.at(-1)!.y) < 1e-6) path.pop();
  const n = path.length;
  if (n < 2 || width <= 0 || top <= bottom) return null;
  const half = width / 2;
  const direction = (a: Vec2, b: Vec2) => { const l = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? path[i - 1]! : closed ? path[n - 1]! : null;
    const next = i < n - 1 ? path[i + 1]! : closed ? path[0]! : null;
    const p = path[i]!;
    const d0 = prev ? direction(prev, p) : null;
    const d1 = next ? direction(p, next) : null;
    const n0 = d0 ? { x: -d0.y, y: d0.x } : null;
    const n1 = d1 ? { x: -d1.y, y: d1.x } : null;
    let normal = n0 && n1 ? { x: n0.x + n1.x, y: n0.y + n1.y } : (n0 ?? n1)!;
    const length = Math.hypot(normal.x, normal.y);
    let scale = half;
    if (n0 && n1) {
      if (length < 1e-6) normal = n1;
      else {
        normal = { x: normal.x / length, y: normal.y / length };
        // Miter length half / cos(θ/2), limited so hairpins do not spike.
        const cos = normal.x * n1.x + normal.y * n1.y;
        scale = half / Math.max(cos, 0.4);
      }
    }
    left.push({ x: p.x + normal.x * scale, y: p.y + normal.y * scale });
    right.push({ x: p.x - normal.x * scale, y: p.y - normal.y * scale });
  }
  const positions: number[] = [];
  // Plan (x, y) → scene (x, height, y).
  const tri = (a: Vec2, ay: number, b: Vec2, by: number, c: Vec2, cy: number) => positions.push(a.x, ay, a.y, b.x, by, b.y, c.x, cy, c.y);
  const quad = (a: Vec2, ay: number, b: Vec2, by: number, c: Vec2, cy: number, d: Vec2, dy: number) => { tri(a, ay, b, by, c, cy); tri(a, ay, c, cy, d, dy); };
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % n;
    quad(left[i]!, top, left[j]!, top, right[j]!, top, right[i]!, top);
    quad(right[i]!, bottom, right[j]!, bottom, left[j]!, bottom, left[i]!, bottom);
    quad(left[i]!, bottom, left[j]!, bottom, left[j]!, top, left[i]!, top);
    quad(right[j]!, bottom, right[i]!, bottom, right[i]!, top, right[j]!, top);
  }
  if (!closed) {
    quad(right[0]!, bottom, left[0]!, bottom, left[0]!, top, right[0]!, top);
    quad(left[n - 1]!, bottom, right[n - 1]!, bottom, right[n - 1]!, top, left[n - 1]!, top);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/** A square beam between arbitrary 3D points, used by sloping stair railings. */
function beam3d(a: THREE.Vector3, b: THREE.Vector3, thickness: number, material: THREE.Material): THREE.Mesh | null {
  const direction = b.clone().sub(a);
  const length = direction.length();
  if (length <= 0.5 || thickness <= 0) return null;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, thickness, thickness), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction.normalize());
  return mesh;
}

interface Cut {
  start: number;
  end: number;
  bottom: number;
  top: number;
}

/** Door/window intervals along each wall segment with the height range they remove. */
function wallCuts(doc: ArchaiDocument, wall: LineElement): Map<number, Cut[]> {
  const cuts = new Map<number, Cut[]>();
  const curvedPoints = wall.path ? linePoints(wall, 32) : null;
  const wallParams = parseSystemParameters('wall', archOf(wall)?.['parameters']);
  const wallBase = wallParams.elevation;
  const wallHeight = wallParams.height;
  const wallWorldBottom = instanceElevationOf(wall, doc.elements);
  const wallWorldTop = wallWorldBottom + wallHeight;

  const openings = wallOpeningsFor(wall, doc.elements);
  for (const { element, opening } of openings) {
    const type = archTypeOf(element);
    const arch = archOf(element);
    let height = 0;
    if (type === 'door') {
      const p = parseSystemParameters('door', arch?.['parameters']);
      height = p.height;
    } else if (type === 'window') {
      const p = parseSystemParameters('window', arch?.['parameters']);
      height = p.height;
    } else continue;

    const openingWorldBottom = instanceElevationOf(element, doc.elements);
    const openingWorldTop = openingWorldBottom + height;

    // Check vertical overlap between opening and wall in world space
    if (openingWorldTop <= wallWorldBottom || openingWorldBottom >= wallWorldTop) {
      continue;
    }

    // Convert opening elevation to wall local coordinate system
    const bottom = openingWorldBottom - wallWorldBottom + wallBase;
    const top = openingWorldTop - wallWorldBottom + wallBase;

    if (curvedPoints && opening.curveAlong !== undefined) {
      let travelled = 0;
      for (let segment = 0; segment < curvedPoints.length - 1; segment++) {
        const a = curvedPoints[segment]!;
        const b = curvedPoints[segment + 1]!;
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const overlapStart = Math.max(opening.start, travelled);
        const overlapEnd = Math.min(opening.end, travelled + length);
        if (overlapEnd > overlapStart) {
          const list = cuts.get(segment) ?? [];
          list.push({ start: overlapStart - travelled, end: overlapEnd - travelled, bottom, top });
          cuts.set(segment, list);
        }
        travelled += length;
      }
    } else {
      const list = cuts.get(opening.segment) ?? [];
      list.push({ start: opening.start, end: opening.end, bottom, top });
      cuts.set(opening.segment, list);
    }
  }
  return cuts;
}

/**
 * A wall: one box per layer band per piece. Pieces are the spans between openings (plus the
 * spans above and below each), split again at the edges of painted zones so every face of a
 * piece is in or out of each zone. Box faces map to surfaces: the outer face of the first band
 * is side A, of the last band side B, the tops / bottoms of the wall top and bottom, the ends at
 * the wall's ends, faces at openings the reveals; faces between pieces and bands are internal.
 * Face coordinates for zones: u along the wall from its start, v up from its base (mm).
 */
function buildWall(doc: ArchaiDocument, wall: LineElement, matrix: Mat): THREE.Object3D {
  const look = lookOf(doc, wall);
  const group = new THREE.Group();
  const parameters = parseSystemParameters('wall', archOf(wall)?.['parameters']);
  const thickness = wallThicknessOf(wall) ?? wall.style.strokeWidth;
  const base = parameters.elevation;
  const top = base + parameters.height;
  const points = linePoints(wall, 32).map(([x, y]) => applyToPoint(matrix, { x, y }));
  const cuts = wallCuts(doc, wall);
  // Joined ends are squared off by half the thickness so corners close instead of leaving a notch
  // on the outside; the overlap disappears inside the neighbouring wall.
  const joints = archOf(wall)?.['joints'];
  const joined = (end: 'start' | 'end') => {
    const value = joints && typeof joints === 'object' && !Array.isArray(joints) ? joints[end] : null;
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value['enabled'] === true);
  };
  const extendStart = joined('start') ? thickness / 2 : 0;
  const extendEnd = joined('end') ? thickness / 2 : 0;
  // Layer bands, outside (left-hand side, -across) to inside.
  const bands: { across: number; thickness: number; slot: string; slotId: string; material: THREE.Material; core: boolean;
  }[] = [];
  let cursor = -thickness / 2;
  parameters.layers.forEach((layer, index) => {
    const slot = `layer:${index}`;
    const fallback = layer.role === 'core' ? 'default:wall-core' : 'default:wall-finish';
    bands.push({ across: cursor + layer.thickness / 2, thickness: layer.thickness, slot, slotId: look.slotId(slot, fallback), material: look.slot(slot, fallback), core: layer.role === 'core' });
    cursor += layer.thickness;
  });
  // Zone edges on either side split the pieces (u: along the whole wall, v: above the base).
  const zones = [...look.zoned('sideA'), ...look.zoned('sideB')];
  const uBreaks = [...new Set(zones.flatMap((paint) => paint.zone?.u ?? []))].sort((p, q) => p - q);
  const vBreaks = [...new Set(zones.flatMap((paint) => paint.zone?.v ?? []))].map((v) => base + v).sort((p, q) => p - q);
  const split = (from: number, to: number, breaks: readonly number[]) => {
    const edges = [from, ...breaks.filter((value) => value > from + 0.5 && value < to - 0.5), to];
    return edges.slice(1).map((end, index) => [edges[index]!, end] as const);
  };
  let travelled = 0;
  for (let segment = 0; segment < points.length - 1; segment++) {
    const a = points[segment]!;
    const b = points[segment + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 0) continue;
    const unit = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const at = (t: number) => ({ x: a.x + unit.x * t, y: a.y + unit.y * t });
    const intervals = (cuts.get(segment) ?? []).map((cut) => ({ ...cut, start: Math.max(0, cut.start), end: Math.min(length, cut.end) })).filter((cut) => cut.end > cut.start).sort((p, q) => p.start - q.start);
    const pieces: { from: number; to: number; bottom: number; top: number }[] = [];
    const first = segment === 0 ? -extendStart : 0;
    const last = segment === points.length - 2 ? length + extendEnd : length;
    let along = first;
    for (const cut of intervals) {
      if (cut.start > along) pieces.push({ from: along, to: cut.start, bottom: base, top });
      // Above and below the opening.
      if (cut.top < top) pieces.push({ from: cut.start, to: cut.end, bottom: Math.max(base, cut.top), top });
      if (cut.bottom > base) pieces.push({ from: cut.start, to: cut.end, bottom: base, top: Math.min(top, cut.bottom) });
      along = Math.max(along, cut.end);
    }
    if (along < last) pieces.push({ from: along, to: last, bottom: base, top });
    const cutEdges = new Set(intervals.flatMap((cut) => [cut.start, cut.end]));
    const cutHeights = new Set(intervals.flatMap((cut) => [cut.bottom, cut.top]));
    const isFirst = segment === 0;
    const isLast = segment === points.length - 2;
    for (const piece of pieces) {
      for (const [from, to] of split(piece.from, piece.to, uBreaks.map((u) => u - travelled))) {
        for (const [bottom, pieceTop] of split(piece.bottom, piece.top, vBreaks)) {
          // Surface of each box face, in BoxGeometry group order: +x, -x, +y, -y, +z, -z.
          const endFace = (at: number, wallEnd: boolean): SurfaceKey | null =>
            wallEnd ? 'ends' : cutEdges.has(at) ? 'reveals' : null;
          const faces: (SurfaceKey | null)[] = [
            endFace(to, isLast && to === last),
            endFace(from, isFirst && from === first),
            pieceTop === top ? 'top' : cutHeights.has(pieceTop) && pieceTop === piece.top ? 'reveals' : null,
            bottom === base ? 'bottom' : cutHeights.has(bottom) && bottom === piece.bottom ? 'reveals' : null,
          ];
          const u0 = travelled + from;
          const u1 = travelled + to;
          bands.forEach((band, index) => {
            const surfaces: (SurfaceKey | null)[] = [...faces, index === bands.length - 1 ? 'sideB' : null, index === 0 ? 'sideA' : null];
            const materials = surfaces.map((surface) => (surface && look.paint(surface, u0, u1, bottom - base, pieceTop - base)) || band.material);
            const uniform = materials.every((material) => material === materials[0]);
            const mesh = segmentBox(at(from), at(to), band.thickness, bottom, pieceTop, band.material, band.across);
            if (!mesh) return;
            if (!uniform) mesh.material = materials;
            mesh.userData['slot'] = band.slot;
            mesh.userData['surfaces'] = surfaces;
            mesh.userData['cutMaterial'] = band.slotId;
            group.add(cutKey(mesh, band.core ? 'wall:core' : 'wall:finish'));
          });
        }
      }
    }
    travelled += length;
  }
  return group;
}

/** Places `object` in the local frame of an element: origin at its top-left, rotation about Y. */
function placeInFrame(object: THREE.Object3D, matrix: Mat): void {
  const origin = applyToPoint(matrix, { x: 0, y: 0 });
  const xAxis = applyToPoint(matrix, { x: 1, y: 0 });
  const angle = Math.atan2(xAxis.y - origin.y, xAxis.x - origin.x);
  object.position.set(origin.x, 0, origin.y);
  object.rotation.y = -angle;
}

function buildDoor(doc: ArchaiDocument, element: Element & { kind: 'instance' }, matrix: Mat): THREE.Object3D {
  const look = lookOf(doc, element);
  const MATERIALS = { frame: look.slot('frame', 'default:door-frame'), door: look.slot('leaf', 'default:door-leaf') };
  const group = new THREE.Group();
  const arch = archOf(element);
  const p = parseSystemParameters('door', arch?.['parameters']);
  const mount = typeof arch?.['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : 0;
  const width = element.width;
  const depth = 100;
  const bottom = p.threshold;
  const top = p.threshold + p.height;
  const jamb = 40;
  // Frame: two jambs and a head, centred on the wall line (local y = mount).
  const jambGeometry = new THREE.BoxGeometry(jamb, top - bottom, depth);
  const left = new THREE.Mesh(jambGeometry, MATERIALS.frame);
  left.position.set(jamb / 2, bottom + (top - bottom) / 2, mount);
  const right = new THREE.Mesh(jambGeometry, MATERIALS.frame);
  right.position.set(width - jamb / 2, bottom + (top - bottom) / 2, mount);
  const head = new THREE.Mesh(new THREE.BoxGeometry(width, jamb, depth), MATERIALS.frame);
  head.position.set(width / 2, top - jamb / 2, mount);
  group.add(left, right, head);
  // Leaf: hinged on the handing side, swung open into the template's swing area (+local y for "inside").
  const away = p.openingSide === 'outside' ? -1 : 1;
  const leafWidth = p.operation === 'double-swing' ? width / 2 - jamb : width - 2 * jamb;
  const leaves = p.operation === 'double-swing' ? [{ hinge: jamb, dir: 1 }, { hinge: width - jamb, dir: -1 }] : [{ hinge: p.handing === 'right' ? width - jamb : jamb, dir: p.handing === 'right' ? -1 : 1 }];
  for (const { hinge, dir } of leaves) {
    const pivot = new THREE.Group();
    pivot.position.set(hinge, bottom, mount);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafWidth, top - bottom - jamb, 40), MATERIALS.door);
    leaf.position.set((dir * leafWidth) / 2, (top - bottom - jamb) / 2, 0);
    pivot.add(slotted(leaf, 'leaf', look.slotId('leaf', 'default:door-leaf')));
    if (p.operation === 'swing' || p.operation === 'double-swing') pivot.rotation.y = -dir * away * (Math.PI / 2) * 0.9;
    else if (p.operation === 'sliding') pivot.position.set(hinge + dir * leafWidth * 0.5, bottom, mount + away * 60);
    group.add(pivot);
  }
  slotted(group, 'frame', look.slotId('frame', 'default:door-frame'));
  placeInFrame(group, matrix);
  return cutKey(group, 'door');
}

function buildWindow(doc: ArchaiDocument, element: Element & { kind: 'instance' }, matrix: Mat, depth: number): THREE.Object3D {
  const look = lookOf(doc, element);
  const MATERIALS = { windowFrame: look.slot('frame', 'default:window-frame'), glass: look.slot('glass', 'default:glass') };
  const group = new THREE.Group();
  const arch = archOf(element);
  const p = parseSystemParameters('window', arch?.['parameters']);
  const mount = typeof arch?.['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : depth / 2;
  const width = element.width;
  const bottom = p.sill;
  const height = p.height;
  const bar = 50;
  const frameDepth = Math.max(60, depth * 0.6);
  const vertical = new THREE.BoxGeometry(bar, height, frameDepth);
  const horizontal = new THREE.BoxGeometry(width, bar, frameDepth);
  const parts = [
    [new THREE.Mesh(vertical, MATERIALS.windowFrame), bar / 2, bottom + height / 2],
    [new THREE.Mesh(vertical, MATERIALS.windowFrame), width - bar / 2, bottom + height / 2],
    [new THREE.Mesh(horizontal, MATERIALS.windowFrame), width / 2, bottom + bar / 2],
    [new THREE.Mesh(horizontal, MATERIALS.windowFrame), width / 2, bottom + height - bar / 2],
  ] as const;
  for (const [mesh, x, y] of parts) {
    mesh.position.set(x, y, mount);
    group.add(cutKey(slotted(mesh, 'frame', look.slotId('frame', 'default:window-frame')), 'window:frame'));
  }
  const glass = new THREE.Mesh(new THREE.BoxGeometry(width - 2 * bar, height - 2 * bar, 12), MATERIALS.glass);
  glass.position.set(width / 2, bottom + height / 2, mount);
  group.add(cutKey(slotted(glass, 'glass', look.slotId('glass', 'default:glass')), 'window:glass'));
  placeInFrame(group, matrix);
  return group;
}

function buildColumn(doc: ArchaiDocument, element: Element & { kind: 'rect' }, matrix: Mat): THREE.Object3D {
  const look = lookOf(doc, element);
  const p = parseSystemParameters('column', archOf(element)?.['parameters']);
  const fallback = `default:${p.material}`;
  const material = look.slot('body', fallback);
  let geometry: THREE.BufferGeometry;
  if (p.shape === 'circle') geometry = new THREE.CylinderGeometry(element.width / 2, element.width / 2, p.height, 32);
  else if (p.shape === 'custom') {
    const shape = new THREE.Shape();
    p.profile.forEach(([x, y], index) => index === 0 ? shape.moveTo(x * element.width, y * element.height) : shape.lineTo(x * element.width, y * element.height));
    shape.closePath();
    geometry = new THREE.ExtrudeGeometry(shape, { depth: p.height, bevelEnabled: false });
    geometry.rotateX(Math.PI / 2);
  } else geometry = new THREE.BoxGeometry(element.width, p.height, element.height);
  const mesh = surfaceMesh(new THREE.Mesh(geometry, material), look, 'body', material, look.slotId('body', fallback));
  if (p.shape === 'custom') mesh.position.y = p.elevation + p.height;
  else mesh.position.set(element.width / 2, p.elevation + p.height / 2, element.height / 2);
  const group = new THREE.Group();
  group.add(mesh);
  placeInFrame(group, matrix);
  return cutKey(group, 'column');
}

function buildStair(doc: ArchaiDocument, element: Element & { kind: 'group' }, matrix: Mat): THREE.Object3D {
  const look = lookOf(doc, element);
  const SLOT_DEFAULTS = { tread: 'default:stair-tread', riser: 'default:stair-riser', landing: 'default:stair-landing', stringer: 'default:stair-stringer', rail: 'default:rail' } as const;
  const MATERIALS = Object.fromEntries(Object.entries(SLOT_DEFAULTS).map(([slot, fallback]) => [slot, look.slot(slot, fallback)])) as Record<keyof typeof SLOT_DEFAULTS, THREE.Material>;
  const tag = <T extends THREE.Object3D>(object: T, slot: keyof typeof SLOT_DEFAULTS): T => slotted(object, slot, look.slotId(slot, SLOT_DEFAULTS[slot]));
  const g = graphicsResolver(doc.workspace.graphics as GraphicsOverrides | undefined);
  const stringers = g.bool('stair', '3d', '*', 'stringer.visible');
  const group = new THREE.Group();
  const p = parseSystemParameters('stair', archOf(element)?.['parameters']);
  const flights: StairFlight[] = stairFlightsOf(element);
  const rectangularProfile = (profile: readonly [number, number][]) =>
    profile.length === 4 && profile.every((point, index) => point[0] === [[0, 0], [1, 0], [1, 1], [0, 1]][index]![0] && point[1] === [[0, 0], [1, 0], [1, 1], [0, 1]][index]![1]);
  let level = p.elevation;
  const w = p.width;
  for (const flight of flights) {
    const r = (flight.angle * Math.PI) / 180;
    const along = { x: Math.cos(r), y: Math.sin(r) };
    const perp = { x: -Math.sin(r), y: Math.cos(r) };
    if (flight.kind === 'landing') {
      const length = flightLength(flight, p);
      const across = flight.width ?? w;
      const offset = flight.offset ?? 0;
      const centre = { x: flight.x + along.x * (length / 2) + perp.x * (offset + across / 2 - w / 2), y: flight.y + along.y * (length / 2) + perp.y * (offset + across / 2 - w / 2) };
      const slab = new THREE.Mesh(new THREE.BoxGeometry(length, Math.max(40, p.riserHeight * 0.4), across), MATERIALS.landing);
      slab.position.set(centre.x, level - Math.max(40, p.riserHeight * 0.4) / 2, centre.y);
      slab.rotation.y = -r;
      group.add(tag(slab, 'landing'));
      continue;
    }
    const thickness = Math.max(40, p.riserHeight * 0.3);
    for (let i = 0; i < flight.treads; i++) {
      const treadTop = level + (i + 1) * p.riserHeight;
      let tread: THREE.Mesh;
      if (rectangularProfile(p.treadProfile)) {
        tread = new THREE.Mesh(new THREE.BoxGeometry(p.treadDepth + p.nosing, thickness, w), MATERIALS.tread);
        tread.position.set(flight.x + along.x * ((i + 0.5) * p.treadDepth), treadTop - thickness / 2, flight.y + along.y * ((i + 0.5) * p.treadDepth));
      } else {
        const treadShape = new THREE.Shape();
        p.treadProfile.forEach(([x, y], index) => index === 0 ? treadShape.moveTo(x * (p.treadDepth + p.nosing), y * thickness) : treadShape.lineTo(x * (p.treadDepth + p.nosing), y * thickness));
        treadShape.closePath();
        tread = new THREE.Mesh(new THREE.ExtrudeGeometry(treadShape, { depth: w, bevelEnabled: false }), MATERIALS.tread);
        tread.position.set(flight.x + along.x * (i * p.treadDepth), treadTop - thickness, flight.y + along.y * (i * p.treadDepth));
      }
      tread.rotation.y = -r;
      group.add(tag(tread, 'tread'));
      {
        // Render the vertical rise for every stair. Closed-riser stairs use a substantial
        // plate; open stairs keep a thin face so the rise remains legible in 3D.
        const riserDepth = p.treadStyle === 'closed-riser' ? 30 : 6;
        const riserHeight = p.riserHeight - thickness;
        if (riserHeight > 0) {
          let riser: THREE.Mesh;
          if (rectangularProfile(p.riserProfile)) {
            riser = new THREE.Mesh(new THREE.BoxGeometry(riserDepth, riserHeight, w), MATERIALS.riser);
            riser.position.set(flight.x + along.x * (i * p.treadDepth + riserDepth / 2), treadTop - thickness - riserHeight / 2, flight.y + along.y * (i * p.treadDepth + riserDepth / 2));
          } else {
            const riserShape = new THREE.Shape();
            p.riserProfile.forEach(([x, y], index) => index === 0 ? riserShape.moveTo(x * riserDepth, y * riserHeight) : riserShape.lineTo(x * riserDepth, y * riserHeight));
            riserShape.closePath();
            riser = new THREE.Mesh(new THREE.ExtrudeGeometry(riserShape, { depth: w, bevelEnabled: false }), MATERIALS.riser);
            riser.position.set(flight.x + along.x * (i * p.treadDepth), treadTop - thickness - riserHeight, flight.y + along.y * (i * p.treadDepth));
          }
          riser.rotation.y = -r;
          group.add(tag(riser, 'riser'));
        }
      }
    }
    if (stringers && flight.treads > 0) {
      // Stringers: a sloped beam under each side of the run, from the first riser to the last tread.
      const length = flight.treads * p.treadDepth;
      const rise = flight.treads * p.riserHeight;
      const slope = Math.hypot(length, rise);
      const pitch = Math.atan2(rise, length);
      const depth = Math.max(160, p.riserHeight * 1.2);
      for (const side of [-1, 1]) {
        const stringer = new THREE.Mesh(new THREE.BoxGeometry(slope, depth, 40), MATERIALS.stringer);
        const mid = { x: flight.x + along.x * (length / 2) + perp.x * side * (w / 2 - 20), y: flight.y + along.y * (length / 2) + perp.y * side * (w / 2 - 20) };
        stringer.position.set(mid.x, level + rise / 2 - depth / 2 - thickness / 2, mid.y);
        stringer.rotation.set(0, -r, 0);
        stringer.rotateZ(pitch);
        group.add(tag(stringer, 'stringer'));
      }
    }
    level += flight.treads * p.riserHeight;
  }
  // Railings nested under the stair use the stair's rise as well as its plan path.
  for (const railing of childrenOf(doc.elements, element.id)) {
    if (railing.kind !== 'line' || !isArchType(railing, 'railing')) continue;
    const rp = parseSystemParameters('railing', archOf(railing)?.['parameters']);
    const railingSide = railing.meta?.['stairSide'] === 'left' ? 'left' : 'right';
    let railLevel = p.elevation;
    for (const flight of flights) {
      const r = (flight.angle * Math.PI) / 180;
      const length = flightLength(flight, p);
      const across = flight.kind === 'landing' ? (flight.width ?? w) : w;
      const offset = flight.kind === 'landing' ? (flight.offset ?? 0) : 0;
      const side = -w / 2 + offset + (railingSide === 'right' ? across : 0);
      const ax = flight.x - Math.sin(r) * side;
      const az = flight.y + Math.cos(r) * side;
      const bx = ax + Math.cos(r) * length;
      const bz = az + Math.sin(r) * length;
      const rise = flight.kind === 'run' ? flight.treads * p.riserHeight : 0;
      const beam = beam3d(new THREE.Vector3(ax, railLevel + rp.height, az), new THREE.Vector3(bx, railLevel + rise + rp.height, bz), rp.thickness, MATERIALS.rail);
      if (beam) group.add(tag(beam, 'rail'));
      const spacing = Math.max(1, rp.balusterSpacing || length);
      const count = Math.max(1, Math.ceil(length / spacing));
      for (let index = 0; index <= count; index++) {
        const t = index / count;
        const base = railLevel + rise * t;
        const postHeight = Math.max(rp.thickness, rp.height - rp.thickness / 2);
        const post = new THREE.Mesh(new THREE.BoxGeometry(rp.thickness / 2, postHeight, rp.thickness / 2), MATERIALS.rail);
        post.position.set(ax + (bx - ax) * t, base + postHeight / 2, az + (bz - az) * t);
        group.add(tag(post, 'rail'));
      }
      railLevel += rise;
    }
  }
  // Flights are stored relative to the group origin.
  const origin = applyToPoint(matrix, { x: 0, y: 0 });
  group.position.set(origin.x, 0, origin.y);
  return cutKey(group, 'stair');
}

function buildRailing(doc: ArchaiDocument, element: LineElement, matrix: Mat): THREE.Object3D {
  const look = lookOf(doc, element);
  const MATERIALS = { rail: look.slot('rail', 'default:rail'), panel: look.slot('panel', 'default:rail-panel') };
  const group = new THREE.Group();
  const p = parseSystemParameters('railing', archOf(element)?.['parameters']);
  const points = linePoints(element).map(([x, y]) => applyToPoint(matrix, { x, y }));
  const base = p.elevation;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const rail = segmentBox(a, b, p.thickness, base + p.height - p.thickness, base + p.height, MATERIALS.rail);
    if (rail) group.add(rail);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (p.pattern === 'glass-panel' || p.pattern === 'solid') {
      const panel = segmentBox(a, b, p.pattern === 'solid' ? p.thickness : 12, base, base + p.height - p.thickness, p.pattern === 'solid' ? MATERIALS.rail : MATERIALS.panel);
      if (panel) group.add(p.pattern === 'solid' ? panel : slotted(panel, 'panel', look.slotId('panel', 'default:rail-panel')));
    }
    const spacing = p.pattern === 'baluster' ? p.balusterSpacing : Math.max(p.balusterSpacing, 900);
    if (spacing > 0) {
      const count = Math.max(1, Math.floor(length / spacing));
      for (let k = 0; k <= count; k++) {
        const t = Math.min(length, k * spacing) / length;
        const post = new THREE.Mesh(new THREE.BoxGeometry(p.thickness / 2, p.height - p.thickness, p.thickness / 2), MATERIALS.rail);
        post.position.set(a.x + (b.x - a.x) * t, base + (p.height - p.thickness) / 2, a.y + (b.y - a.y) * t);
        group.add(post);
      }
    }
    if (p.pattern === 'cable') {
      for (let k = 1; k <= 3; k++) {
        const cable = segmentBox(a, b, 8, base + (k * (p.height - p.thickness)) / 4, base + (k * (p.height - p.thickness)) / 4 + 8, MATERIALS.rail);
        if (cable) group.add(cable);
      }
    }
  }
  slotted(group, 'rail', look.slotId('rail', 'default:rail'));
  return cutKey(group, 'railing');
}

function buildCurtainWall(doc: ArchaiDocument, element: LineElement, matrix: Mat): THREE.Object3D {
  const look = lookOf(doc, element);
  const p = parseSystemParameters('curtain-wall', archOf(element)?.['parameters']);
  const points = linePoints(element).map(([x, y]) => applyToPoint(matrix, { x, y }));
  const group = new THREE.Group();
  const fallback = p.panelMaterial === 'glass' ? 'default:curtain-glass' : p.panelMaterial === 'timber' ? 'default:timber' : p.panelMaterial === 'metal' ? 'default:steel' : 'default:facade';
  const panelMaterial = look.slot('panel', fallback);
  for (let segment = 0; segment < points.length - 1; segment++) {
    const a = points[segment]!;
    const b = points[segment + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.5) continue;
    const count = Math.max(1, Math.ceil(length / p.mullionSpacing));
    const panelWidth = length / count;
    const angle = Math.atan2(dy, dx);
    for (let index = 0; index < count; index++) {
      const shape = new THREE.Shape();
      p.panelProfile.forEach(([x, y], pointIndex) => pointIndex === 0 ? shape.moveTo(x * panelWidth, (1 - y) * p.panelSpacing) : shape.lineTo(x * panelWidth, (1 - y) * p.panelSpacing));
      shape.closePath();
      const panel = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 12, bevelEnabled: false }), panelMaterial);
      panel.position.set(a.x + Math.cos(angle) * index * panelWidth, 0, a.y + Math.sin(angle) * index * panelWidth);
      panel.rotation.y = -angle;
      group.add(panel);
    }
  }
  slotted(group, 'panel', look.slotId('panel', fallback));
  return cutKey(group, 'curtain-wall');
}

/** Extrudes a closed polygon (world plan points) between two heights. */
function extrudePolygon(points: Vec2[], bottom: number, top: number, material: THREE.Material, holes: Vec2[][] = []): THREE.Mesh | null {
  if (points.length < 3) return null;
  const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, p.y)));
  for (const hole of holes) if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))));
  const depth = Math.max(top - bottom, 1);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  // ExtrudeGeometry extrudes along +Z; rotate so plan XY maps to scene XZ and the depth points up.
  geometry.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = top;
  return mesh;
}

/** A model material's slot name (unnamed materials share one). */
export function assetMaterialName(material: THREE.Material): string {
  return material.name?.trim() || 'Material';
}

/**
 * Tags a cloned model's meshes with their slots (`asset:<material name>`) and swaps in assigned
 * materials. Geometry stays the cached model's, except where a material was replaced (it gets its
 * own copy so world-mm UVs can be written).
 */
function modelSlots(clone: THREE.Object3D, look: Look): void {
  clone.traverse((child) => {
    child.userData['shared'] = true; // geometry belongs to the cached model
    if (!(child instanceof THREE.Mesh)) return;
    const list: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
    const slots = list.map((material) => `asset:${assetMaterialName(material)}`);
    const replaced = list.map((material, index) => look.assigned(slots[index]!) ?? look.assigned('body') ?? material);
    child.userData['assetMesh'] = true;
    child.userData['slots'] = slots;
    child.userData['slot'] = slots[0];
    if (replaced.some((material, index) => material !== list[index])) {
      child.material = Array.isArray(child.material) ? replaced : replaced[0]!;
      child.geometry = child.geometry.clone();
      child.userData['shared'] = false;
      child.userData['assetMesh'] = false;
    }
  });
}

/** A mesh element (src/view3d/meshes.ts): its model, or its plan box while the model decodes. */
function buildMeshElement(doc: ArchaiDocument, element: Element & { kind: 'rect' }, matrix: Mat, mesh: MeshMeta): THREE.Object3D | null {
  const look = lookOf(doc, element);
  const group = new THREE.Group();
  const model = meshStore.models.get(mesh.blobId);
  if (model) {
    const clone = model.clone(true);
    modelSlots(clone, look);
    group.add(clone);
  } else {
    const box = new THREE.Mesh(new THREE.BoxGeometry(element.width, Math.max(1, mesh.height), element.height), look.slot('body', 'default:asset'));
    box.position.set(element.width / 2, Math.max(1, mesh.height) / 2, element.height / 2);
    group.add(box);
  }
  placeInFrame(group, matrix);
  return cutKey(group, 'asset');
}

/** The material slots inside a loaded asset model, in model order. */
export function assetMaterialNames(model: THREE.Object3D | undefined): string[] {
  const names = new Set<string>();
  model?.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) names.add(assetMaterialName(material));
  });
  return [...names];
}

/** The element's own colour as a material (rects and closed lines with a fill), cached per colour. */
const fillMaterials = new Map<string, THREE.Material>();
function fillMaterial(colour: string, doubleSided: boolean): THREE.Material {
  const key = `${colour}|${doubleSided}`;
  let material = fillMaterials.get(key);
  if (!material) fillMaterials.set(key, (material = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness: 0.9, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide })));
  return material;
}

function buildGeneric(doc: ArchaiDocument, element: Element, matrix: Mat, textures: Map<string, THREE.Texture>): THREE.Object3D | null {
  const look = lookOf(doc, element);
  const MATERIALS = {
    flat: look.slot('body', 'default:flat', true),
    fallback: look.slot('body', 'default:asset'),
    generic: look.slot('body', 'default:generic'),
    floor: look.slot('body', 'default:floor'),
    ceiling: look.slot('body', 'default:ceiling'),
    curtainWall: look.slot('body', 'default:curtain-glass'),
    facade: look.slot('body', 'default:facade'),
    lineSolid: look.slot('body', 'default:line'),
  };
  // An assigned material replaces the element's own fill colour / image.
  const assigned = look.assigned('body');
  const solid = solidOf(element);
  const bottom = solid.elevation;
  const top = solid.elevation + solid.height;
  switch (element.kind) {
    case 'rect':
    case 'image':
    case 'instance':
    case 'text': {
      const corners = [
        { x: 0, y: 0 },
        { x: element.width, y: 0 },
        { x: element.width, y: element.height },
        { x: 0, y: element.height },
      ].map((c) => applyToPoint(matrix, c));
      if (solid.height <= 0) {
        // Flat: a plane on the floor, textured for images.
        let material: THREE.Material = MATERIALS.flat;
        if (element.kind === 'text') return null;
        if (look.assigned('body', true)) material = look.assigned('body', true)!;
        else if (element.kind === 'image') {
          const blob = doc.blobs[element.blobId];
          const texture = blob ? textures.get(blob.id) : undefined;
          if (texture) material = new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 1 });
        } else if (element.kind === 'rect' && element.style.fill) material = fillMaterial(element.style.fill, true);
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(element.width, element.height), material);
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(element.width / 2, bottom + 2, element.height / 2);
        plane.userData['slot'] = 'body';
        plane.userData['surfaceByNormal'] = true;
        const group = new THREE.Group();
        group.add(plane);
        placeInFrame(group, matrix);
        return group;
      }
      let material: THREE.Material = element.kind === 'instance' ? MATERIALS.fallback : MATERIALS.generic;
      if (!assigned && element.kind === 'rect' && element.style.fill) material = fillMaterial(element.style.fill, false);
      const extruded = extrudePolygon(corners, bottom, top, material);
      if (!extruded) return null;
      surfaceMesh(extruded, look, 'body', material, look.slotId('body', element.kind === 'instance' ? 'default:asset' : 'default:generic'));
      return cutKey(extruded, element.kind === 'instance' ? 'asset' : 'rect');
    }
    case 'line': {
      const points = linePoints(element).map(([x, y]) => applyToPoint(matrix, { x, y }));
      if (element.closed && element.style.fill) {
        const type = archTypeOf(element);
        const fallback = type === 'floor' ? 'default:floor' : type === 'ceiling' ? 'default:ceiling' : 'default:generic';
        const material = type === 'floor' ? MATERIALS.floor : type === 'ceiling' ? MATERIALS.ceiling : (assigned ?? fillMaterial(element.style.fill, true));
        // Openings (shafts, voids) go right through the slab.
        const holes = type === 'floor' || type === 'ceiling' ? slabOpenings(element).map((opening) => opening.points.map(([x, y]) => applyToPoint(matrix, { x, y }))) : [];
        const extruded = extrudePolygon(points, bottom, top, material, holes);
        if (!extruded) return null;
        surfaceMesh(extruded, look, 'body', material, look.slotId('body', fallback));
        return cutKey(extruded, type === 'floor' || type === 'ceiling' ? type : 'line');
      }
      const group = new THREE.Group();
      const thickness = Math.max(element.style.strokeWidth, 10);
      const height = solid.height > 0 ? solid.height : 4;
      const type = archTypeOf(element);
      const fallback = type === 'curtain-wall' ? 'default:curtain-glass' : type === 'facade-element' ? 'default:facade' : 'default:line';
      const material = type === 'curtain-wall' ? MATERIALS.curtainWall : type === 'facade-element' ? MATERIALS.facade : MATERIALS.lineSolid;
      const ribbon = ribbonMesh(points, thickness, bottom, bottom + height, material, element.closed);
      if (ribbon) group.add(surfaceMesh(ribbon, look, 'body', material, look.slotId('body', fallback)));
      return cutKey(group, type === 'curtain-wall' || type === 'facade-element' ? type : 'line');
    }
    default:
      return null;
  }
}

export interface BuildOptions {
  /** Select output roots before construction; dependency queries still see the full document. */
  include?: (id: string) => boolean;
  /** Textures for image blobs, keyed by blob id (prepared asynchronously by the scene). */
  textures: Map<string, THREE.Texture>;
  /** Loaded catalog models keyed by definition id; missing entries fall back to a footprint box. */
  models: Map<string, THREE.Object3D>;
  /** Low level of detail models (only packages that ship one) and the view's level of detail. */
  lowModels?: Map<string, THREE.Object3D>;
  lod?: 'high' | 'low';
  /** A 2D view (plan / section): assets always show a model, never a stand-in box. */
  drawing?: boolean;
}

function buildLevelDatum(element: Element, matrix: Mat): THREE.Object3D | null {
  if (element.kind !== 'rect') return null;
  const elevation = levelElevationOf(element);
  if (elevation === null) return null;
  const points = [
    { x: 0, y: 0 }, { x: element.width, y: 0 },
    { x: element.width, y: element.height }, { x: 0, y: element.height },
  ].map((point) => toScene(applyToPoint(matrix, point), elevation));
  const material = new THREE.LineDashedMaterial({ color: 0x2563eb, dashSize: 180, gapSize: 100, transparent: true, opacity: 0.85, depthTest: false });
  const datum = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material);
  datum.computeLineDistances();
  datum.renderOrder = 20;
  return datum;
}

/**
 * Builds one object per top-level element (children of groups are folded into their group).
 * With `previous` (the last build, by id), elements whose dependencies and shared inputs are
 * unchanged keep their previous entry, object included, so an edit rebuilds only what it touched.
 */
export function buildScene(doc: ArchaiDocument, options: BuildOptions, previous?: ReadonlyMap<string, Built>): Built[] {
  const built: Built[] = [];
  const elements: ElementTable = doc.elements;
  const inputs: BuildInputs = { workspace: doc.workspace, definitions: doc.definitions, blobs: doc.blobs, materials: doc.materials, textures: options.textures, models: options.models, lowModels: options.lowModels, lod: options.lod, drawing: options.drawing };
  const visit = (element: Element) => {
    if (!element.visible) return;
    // Board annotations (sketches, sticky notes) never reach 3D views or section cuts.
    if (element.meta?.['annotation'] || element.meta?.['annotationLayer']) return;
    const matrix = worldMatrix(elements, element);
    const type = archTypeOf(element);
    let object: THREE.Object3D | null = null;
    if (levelElevationOf(element) !== null) object = buildLevelDatum(element, matrix);
    else if (type === 'wall' && element.kind === 'line') object = buildWall(doc, element, matrix);
    else if (type === 'door' && element.kind === 'instance') object = buildDoor(doc, element, matrix);
    else if (type === 'window' && element.kind === 'instance') {
      const host = hostOf(element);
      const depth = (host ? wallThicknessOf(elements[host]) : null) ?? 150;
      object = buildWindow(doc, element, matrix, depth);
    } else if (type === 'column' && element.kind === 'rect') object = buildColumn(doc, element, matrix);
    else if (type === 'stair' && element.kind === 'group') object = buildStair(doc, element, matrix);
    else if (type === 'railing' && element.kind === 'line') object = buildRailing(doc, element, matrix);
    else if (type === 'curtain-wall' && element.kind === 'line') object = buildCurtainWall(doc, element, matrix);
    else if (type === 'facade-element' && element.kind === 'instance') {
      const p = parseSystemParameters('facade-element', archOf(element)?.['parameters']);
      const points = p.profile.map(([x, y]) => applyToPoint(matrix, { x: x * element.width, y: y * element.height }));
      const look = lookOf(doc, element);
      const material = look.slot('body', 'default:facade');
      const mesh = extrudePolygon(points, 0, p.height, material);
      object = mesh ? cutKey(surfaceMesh(mesh, look, 'body', material, look.slotId('body', 'default:facade')), 'facade-element') : null;
    }
    else if (type === 'room' && element.kind === 'line') {
      const points = linePoints(element).map(([x, y]) => applyToPoint(matrix, { x, y }));
      const look = lookOf(doc, element);
      const material = look.slot('floor', 'default:room-floor');
      const mesh = extrudePolygon(points, -20, 0, material);
      object = mesh ? surfaceMesh(mesh, look, 'floor', material, look.slotId('floor', 'default:room-floor')) : null;
    } else if (type === 'room-label' || type === 'room-divider' || element.meta?.['view3d'] || element.meta?.['sectionLine'] || element.meta?.['planRegion'] || element.meta?.['cameraMarker'] || element.meta?.['analysis'] || element.meta?.['location'] || element.meta?.['noiseEmitter']) {
      object = null;
    } else if (isPoint(element) && element.kind === 'rect') {
      // Built at the ground; its elevation is added below like any element's (the stem reaches back down).
      object = pointMarker(toScene(applyToPoint(matrix, { x: element.width / 2, y: element.height / 2 })), element.style.stroke ?? '#7c3aed', instanceElevationOf(element, elements), vrStopOf(element)?.heading ?? null);
    } else if (element.kind === 'rect' && meshOf(element)) {
      object = buildMeshElement(doc, element, matrix, meshOf(element)!);
    } else if (element.kind === 'group' && isConceptGroup(element)) {
      object = buildConcept(elements, element);
    } else if (element.kind === 'group' || element.meta?.['paper']) {
      const group = new THREE.Group();
      for (const child of childrenOf(elements, element.id)) {
        const childBuilt = buildOne(child);
        if (childBuilt) group.add(childBuilt);
      }
      object = group;
    } else if (element.kind === 'instance') {
      const lod = elementLod(element) ?? options.lod ?? 'high';
      // Low detail uses the package's low-poly model; 2D views fall back to the full model instead of a box.
      const model = lod === 'low' ? (options.lowModels?.get(element.definitionId) ?? (options.drawing ? options.models.get(element.definitionId) : undefined)) : options.models.get(element.definitionId);
      const definition = doc.definitions[element.definitionId];
      // A parametric package copy with its own values shows its rebuilt model once it is ready.
      const recipe = recipeOf(definition);
      const overrides = recipe ? instanceOverrides(recipe, parametricInstanceOf(element)) : {};
      const rebuilt = recipe && definition && Object.keys(overrides).length > 0 ? rebuiltModel(definition.id, overrides) : undefined;
      const source = rebuilt?.status === 'ready' ? composeRebuilt(model, rebuilt.model) : model;
      if (source && definition) {
        const clone = rebuilt?.status === 'ready' ? source : source.clone(true);
        modelSlots(clone, lookOf(doc, element));
        // Scale the model's footprint to the instance size; keep height proportional to width.
        const box = new THREE.Box3().setFromObject(clone);
        const size = box.getSize(new THREE.Vector3());
        if (recipe) {
          // Parametric: the box maps the recorded model footprint, so a rebuilt model keeps its
          // origin and scale while it grows or shrinks (the box then follows, see fit-parametric-footprint).
          const fp = parametricInstanceOf(element).footprint ?? footprintOfBounds(recipe.bounds);
          const scale = Math.min(element.width / Math.max(1e-6, fp.maxX - fp.minX), element.height / Math.max(1e-6, fp.maxZ - fp.minZ)) || 1;
          clone.scale.setScalar(scale);
          clone.position.set(-fp.minX * scale, -recipe.bounds.min[1] * scale + solidOf(element).elevation, -fp.minZ * scale);
        } else {
          const sx = size.x > 0 ? element.width / size.x : 1;
          const sz = size.z > 0 ? element.height / size.z : 1;
          const scale = Math.min(sx, sz) || 1;
          clone.scale.setScalar(scale);
          clone.position.set(-box.min.x * scale + (element.width - size.x * scale) / 2, -box.min.y * scale + solidOf(element).elevation, -box.min.z * scale + (element.height - size.z * scale) / 2);
        }
        const group = new THREE.Group();
        group.add(clone);
        placeInFrame(group, matrix);
        object = cutKey(group, 'asset');
      } else if (definition?.kind === 'template') {
        // User/template assets: render their primitives scaled into the instance box.
        const group = new THREE.Group();
        const sx = definition.width > 0 ? element.width / definition.width : 1;
        const sy = definition.height > 0 ? element.height / definition.height : 1;
        const table = definition.elements;
        for (const child of childrenOf(table, null)) {
          const local = worldMatrix(table, child);
          const scaled: Mat = [local[0] * sx, local[1] * sy, local[2] * sx, local[3] * sy, local[4] * sx, local[5] * sy];

          const childObject = buildGeneric(doc, child, scaled, options.textures);
          if (childObject) group.add(childObject);
        }
        placeInFrame(group, matrix);
        object = cutKey(group, type === 'facade-element' ? 'facade-element' : 'asset');
      } else {
        object = buildGeneric(doc, element, matrix, options.textures);
      }
    } else {
      object = buildGeneric(doc, element, matrix, options.textures);
    }
    if (object) {
      object.position.y += instanceElevationOf(element, elements) - baseElevationOf(element);
      // The element a mesh belongs to, kept when groups fold their children in (painting targets it).
      object.traverse((child) => {
        if (child.userData['ownerId'] === undefined) child.userData['ownerId'] = element.id;
      });
      applyWorldUvs(object);
      built.push({ id: element.id, object: tagged(object, element.id) });
    }
  };
  const buildOne = (element: Element): THREE.Object3D | null => {
    const before = built.length;
    visit(element);
    const produced = built.splice(before);
    if (produced.length === 0) return null;
    const group = new THREE.Group();
    for (const item of produced) group.add(item.object);
    return group;
  };
  for (const element of childrenOf(elements, null)) {
    if (options.include && !options.include(element.id)) continue;
    const dependencies = sceneDependencies(elements, element);
    const last = previous?.get(element.id);
    if (last?.dependencies && last.inputs && sameInputs(last.inputs, inputs) && sameElements(last.dependencies, dependencies)) {
      built.push(last);
      continue;
    }
    const before = built.length;
    visit(element);
    for (let index = before; index < built.length; index++) built[index] = { ...built[index]!, dependencies, inputs };
  }
  return built;
}

/** Tallest point of the built scene (walls, columns, assets), for framing sections. */
export function sceneHeight(doc: ArchaiDocument): number {
  let top = 0;
  for (const element of Object.values(doc.elements)) {
    if (!element.visible) continue;
    const levelElevation = levelElevationOf(element);
    if (levelElevation !== null) top = Math.max(top, levelElevation);
    const elev = instanceElevationOf(element, doc.elements);
    const solid = solidOf(element);
    top = Math.max(top, elev + solid.height);
  }
  return top > 0 ? top : 3000;
}

/** Elements farther than this from the bulk of the model are left out of framing. */
const FRAMING_REACH = 5_000_000;

/**
 * What "frame all" looks at: the project, not stray far-away items. Generated site context only
 * counts when there is nothing else, and elements far from the median position (e.g. context
 * left behind when a map was re-centred on another city) are ignored, so one outlier can no
 * longer push the camera hundreds of kilometres out.
 */
export function sceneCentre(doc: ArchaiDocument): { centre: THREE.Vector3; radius: number } {
  const items: { box: THREE.Box3; context: boolean }[] = [];
  for (const element of Object.values(doc.elements)) {
    if (!element.visible || element.kind === 'group' || element.meta?.['view3d'] || element.meta?.['paper'] || element.meta?.['sectionLine'] || element.meta?.['analysis'] || element.meta?.['location'] || element.meta?.['noiseEmitter']) continue;
    const matrix = worldMatrix(doc.elements, element);
    const corners = element.kind === 'line' ? linePoints(element).map(([x, y]) => ({ x, y })) : [{ x: 0, y: 0 }, { x: 'width' in element ? element.width : 0, y: 'height' in element ? element.height : 0 }];
    const itemBox = new THREE.Box3();
    for (const corner of corners) itemBox.expandByPoint(toScene(applyToPoint(matrix, corner)));
    items.push({ box: itemBox, context: Boolean(element.meta?.['siteContext']) });
  }
  const project = items.filter((item) => !item.context);
  const pool = project.length ? project : items;
  const box = new THREE.Box3();
  if (pool.length) {
    const centres = pool.map((item) => item.box.getCenter(new THREE.Vector3()));
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const mx = median(centres.map((c) => c.x));
    const mz = median(centres.map((c) => c.z));
    pool.forEach((item, index) => {
      const c = centres[index]!;
      if (Math.hypot(c.x - mx, c.z - mz) <= FRAMING_REACH) box.union(item.box);
    });
  }
  if (box.isEmpty()) return { centre: new THREE.Vector3(0, 0, 0), radius: 5000 };
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(3000, box.getSize(new THREE.Vector3()).length() / 2);
  return { centre, radius };
}

const MASSING_MATERIAL = new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.85 });

/**
 * A site concept: the union of its solid forms minus its voids, computed by the massing worker.
 * Until that result is cached the solids show as plain prisms; the scene rebuilds once it is (see
 * `prepareMassing`).
 */
function buildConcept(elements: ElementTable, element: Element): THREE.Object3D | null {
  const forms = formsOf(elements, element.id);
  const group = new THREE.Group();
  const positions = cachedMassing(forms);
  if (positions) group.add(new THREE.Mesh(geometryFromPositions(positions), MASSING_MATERIAL));
  else if (positions === undefined) {
    // Not computed yet (see prepareMassing): plain solids until the booleans arrive.
    for (const form of forms) {
      if (form.meta.kind !== 'solid' || !form.visible) continue;
      const geometry = prismGeometry(form);
      if (geometry) group.add(new THREE.Mesh(geometry, MASSING_MATERIAL));
    }
  }
  return cutKey(group, 'rect');
}
