/**
 * The 3D marker of a reference point (see src/document/point.ts): a ring-and-cross glyph that is
 * always the same size on screen, plus a thin stem down to its level so its height reads. It is
 * picked by screen distance (see SceneView.pick), not by ray, since it has no real size.
 */
import * as THREE from 'three';

export const POINT_MARKER_PX = 18;

let glyph: THREE.Texture | null = null;

function glyphTexture(): THREE.Texture | null {
  if (glyph || typeof document === 'undefined') return glyph;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const c = size / 2;
  g.lineCap = 'round';
  const draw = (colour: string, width: number) => {
    g.strokeStyle = colour;
    g.lineWidth = width;
    g.beginPath();
    g.arc(c, c, 17, 0, Math.PI * 2);
    g.moveTo(c - 29, c); g.lineTo(c - 10, c);
    g.moveTo(c + 10, c); g.lineTo(c + 29, c);
    g.moveTo(c, c - 29); g.lineTo(c, c - 10);
    g.moveTo(c, c + 10); g.lineTo(c, c + 29);
    g.stroke();
  };
  draw('rgba(255,255,255,0.95)', 12);
  draw('#ffffff', 6);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(c, c, 5, 0, Math.PI * 2);
  g.fill();
  glyph = new THREE.CanvasTexture(canvas);
  glyph.colorSpace = THREE.SRGBColorSpace;
  return glyph;
}

/**
 * A point marker at `position` (scene coordinates), with a stem down `stem` mm; a VR stop also
 * gets an arrow along its `heading` (degrees clockwise from +x on the board).
 */
export function pointMarker(position: THREE.Vector3, colour: string, stem: number, heading: number | null = null): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(position);
  const map = glyphTexture();
  const material = new THREE.PointsMaterial({ size: POINT_MARKER_PX, sizeAttenuation: false, color: colour, transparent: true, depthTest: false, depthWrite: false, ...(map ? { map, alphaTest: 0.05 } : {}) });
  const points = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)), material);
  points.renderOrder = 35;
  points.frustumCulled = false;
  points.userData['pointMarker'] = true;
  group.add(points);
  if (Math.abs(stem) > 1) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -stem, 0)]),
      new THREE.LineDashedMaterial({ color: colour, dashSize: 120, gapSize: 80, transparent: true, opacity: 0.8 }),
    );
    line.computeLineDistances();
    line.userData['pointStem'] = true;
    group.add(line);
  }
  if (heading !== null) {
    const r = (heading * Math.PI) / 180;
    const along = new THREE.Vector3(Math.cos(r), 0, Math.sin(r));
    const side = new THREE.Vector3(-along.z, 0, along.x);
    const tip = along.clone().multiplyScalar(900);
    const back = along.clone().multiplyScalar(650);
    const arrow = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        along.clone().multiplyScalar(200), tip,
        tip, back.clone().addScaledVector(side, 160),
        tip, back.clone().addScaledVector(side, -160),
      ]),
      new THREE.LineBasicMaterial({ color: colour, transparent: true, depthTest: false }),
    );
    arrow.renderOrder = 35;
    arrow.userData['pointStem'] = true;
    group.add(arrow);
  }
  return group;
}
