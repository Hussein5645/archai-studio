/**
 * On-screen highlights for vertices, edges and faces (hovered, selected, or snapped to) and the
 * snap markers. Markers and edge strokes have a fixed pixel size in every pane, so a snap reads
 * the same zoomed right in or looking at a whole building, in 2D and 3D.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { TopologyHit } from './topology';

export type HighlightSlot = 'hover' | 'selected' | 'snap';

export type MarkerShape = 'square' | 'circle' | 'triangle' | 'diamond' | 'cross' | 'x';

const SLOT_COLOURS: Record<HighlightSlot, number> = { hover: 0x00a6d6, selected: 0xf59e0b, snap: 0x16a36a };

/** Snap colours and shapes by inference type (SketchUp-like: green ends, cyan middles, red on-edge). */
export function markerStyle(type: string): { shape: MarkerShape; colour: number } {
  switch (type) {
    case 'endpoint':
    case 'body-vertex':
      return { shape: 'square', colour: 0x16a36a };
    case 'midpoint':
      return { shape: 'triangle', colour: 0x06b6d4 };
    case 'center':
    case 'quadrant':
    case 'work-plane-origin':
      return { shape: 'circle', colour: 0x2f6fed };
    case 'edge-intersection':
    case 'face-intersection':
      return { shape: 'x', colour: 0xf97316 };
    case 'body-edge':
    case 'point-on-edge':
      return { shape: 'diamond', colour: 0xd946ef };
    case 'alignment':
    case 'axis':
      return { shape: 'diamond', colour: 0x2f6fed };
    default:
      return { shape: 'cross', colour: 0xd64545 };
  }
}

const textures = new Map<MarkerShape, THREE.Texture>();

/** A white marker glyph with a dark rim, tinted by the material colour. */
function markerTexture(shape: MarkerShape): THREE.Texture {
  const cached = textures.get(shape);
  if (cached) return cached;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const m = 10, s = size - m * 2;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const path = () => {
    g.beginPath();
    if (shape === 'square') g.rect(m, m, s, s);
    else if (shape === 'circle') g.arc(size / 2, size / 2, s / 2, 0, Math.PI * 2);
    else if (shape === 'triangle') { g.moveTo(size / 2, m); g.lineTo(size - m, size - m); g.lineTo(m, size - m); g.closePath(); }
    else if (shape === 'diamond') { g.moveTo(size / 2, m); g.lineTo(size - m, size / 2); g.lineTo(size / 2, size - m); g.lineTo(m, size / 2); g.closePath(); }
    else if (shape === 'cross') { g.moveTo(size / 2, m); g.lineTo(size / 2, size - m); g.moveTo(m, size / 2); g.lineTo(size - m, size / 2); }
    else { g.moveTo(m, m); g.lineTo(size - m, size - m); g.moveTo(size - m, m); g.lineTo(m, size - m); }
  };
  const stroked = shape === 'cross' || shape === 'x';
  path();
  g.strokeStyle = 'rgba(15,23,42,0.85)';
  g.lineWidth = stroked ? 16 : 14;
  g.stroke();
  path();
  if (!stroked) {
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fill();
  }
  g.strokeStyle = '#ffffff';
  g.lineWidth = stroked ? 8 : 7;
  g.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textures.set(shape, texture);
  return texture;
}

/** A fixed-size (screen pixels) marker at `position`, drawn over everything. */
export function screenMarker(position: THREE.Vector3, shape: MarkerShape, colour: number, sizePx = 16): THREE.Points {
  const material = new THREE.PointsMaterial({ size: sizePx, sizeAttenuation: false, map: markerTexture(shape), color: colour, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.05 });
  const points = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)), material);
  points.position.copy(position);
  points.renderOrder = 40;
  points.userData['overlay'] = true;
  points.frustumCulled = false;
  return points;
}

export class TopologyHighlights {
  readonly group = new THREE.Group();
  private readonly slots: Record<HighlightSlot, { key: string; object: THREE.Group } | null> = { hover: null, selected: null, snap: null };
  private readonly lineMaterials = new Set<LineMaterial>();
  private resolution = new THREE.Vector2(1, 1);

  constructor() {
    this.group.name = 'topology-highlights';
    this.group.renderOrder = 40;
  }

  /** Line widths are in pixels of the pane being drawn: the viewport calls this per pane. */
  setResolution(width: number, height: number): void {
    this.resolution.set(Math.max(1, width), Math.max(1, height));
    for (const material of this.lineMaterials) material.resolution.copy(this.resolution);
  }

  set(slot: HighlightSlot, hit: TopologyHit | null): void {
    const key = hit ? JSON.stringify(hit.kind === 'face' ? { k: 'f', p: hit.triangles.slice(0, 9), n: hit.triangles.length } : hit) : '';
    if ((this.slots[slot]?.key ?? '') === key) return;
    this.clear(slot);
    if (!hit) return;
    const colour = SLOT_COLOURS[slot];
    const object = new THREE.Group();
    if (hit.kind === 'vertex') {
      object.add(screenMarker(new THREE.Vector3(...hit.point), 'circle', colour, 18));
    } else if (hit.kind === 'edge') {
      object.add(this.stroke([hit.a, hit.b], colour, slot === 'snap' ? 4 : 5));
      object.add(screenMarker(new THREE.Vector3(...hit.a), 'square', colour, 10), screenMarker(new THREE.Vector3(...hit.b), 'square', colour, 10));
      // The snapped spot itself (a midpoint or a point along the edge) before it is projected onto the work plane.
      if (slot === 'snap') object.add(screenMarker(new THREE.Vector3(...hit.point), 'circle', colour, 12));
    } else {
      const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(hit.triangles, 3));
      const material = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: slot === 'selected' ? 0.42 : 0.28, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 39;
      mesh.userData['overlay'] = true;
      object.add(mesh);
      const outline = new THREE.EdgesGeometry(geometry, 1);
      const positions = outline.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < positions.count; i += 2) {
        object.add(this.stroke([[positions.getX(i), positions.getY(i), positions.getZ(i)], [positions.getX(i + 1), positions.getY(i + 1), positions.getZ(i + 1)]], colour, 3));
      }
      outline.dispose();
    }
    this.slots[slot] = { key, object };
    this.group.add(object);
  }

  private stroke(points: [number, number, number][], colour: number, widthPx: number): Line2 {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flat());
    const material = new LineMaterial({ color: colour, linewidth: widthPx, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    material.resolution.copy(this.resolution);
    this.lineMaterials.add(material);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 41;
    line.userData['overlay'] = true;
    line.frustumCulled = false;
    return line;
  }

  clear(slot: HighlightSlot): void {
    const current = this.slots[slot];
    if (!current) return;
    current.object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
        child.geometry.dispose();
        const material = child.material as THREE.Material;
        if (material instanceof LineMaterial) this.lineMaterials.delete(material);
        material.dispose();
      }
    });
    current.object.removeFromParent();
    this.slots[slot] = null;
  }
}
