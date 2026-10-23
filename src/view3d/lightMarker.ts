import * as THREE from 'three';
import { pointMarker } from './pointMarker';
const maps = new Map<string, THREE.CanvasTexture>();
export function lightMarker(position: THREE.Vector3, height: number, kind: string, size: number, target?: THREE.Vector3): THREE.Group {
  const group = pointMarker(position, '#d99b12', height);
  let map = maps.get(kind);
  if (!map && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const g = canvas.getContext('2d')!; g.strokeStyle = '#ffffff'; g.lineWidth = 5; g.fillStyle = '#ffffff'; g.lineCap = 'round';
    if (kind === 'spot') { g.beginPath(); g.moveTo(20, 8); g.lineTo(44, 8); g.lineTo(44, 28); g.lineTo(58, 55); g.lineTo(6, 55); g.lineTo(20, 28); g.closePath(); g.stroke(); }
    else if (kind === 'area') { g.strokeRect(8, 10, 48, 28); for (const x of [16, 32, 48]) { g.beginPath(); g.moveTo(x, 45); g.lineTo(x, 59); g.stroke(); } }
    else { g.beginPath(); g.arc(32, 32, 12, 0, Math.PI * 2); g.stroke(); for (let i=0;i<8;i++) { const a=i*Math.PI/4; g.beginPath(); g.moveTo(32+Math.cos(a)*21,32+Math.sin(a)*21); g.lineTo(32+Math.cos(a)*29,32+Math.sin(a)*29);g.stroke(); } }
    map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; maps.set(kind, map);
  }
  const glyph = group.children[0] as THREE.Points;
  if (map) { (glyph.material as THREE.PointsMaterial).map = map; (glyph.material as THREE.PointsMaterial).size = 24; }
  const vertices: THREE.Vector3[] = [];
  if (target) {
    vertices.push(new THREE.Vector3(), target);
    const aim = pointMarker(target, '#d99b12', 0); group.add(aim);
  }
  if (kind === 'area') { const s=size*500; const corners=[new THREE.Vector3(-s,0,-s),new THREE.Vector3(s,0,-s),new THREE.Vector3(s,0,s),new THREE.Vector3(-s,0,s)]; for(let i=0;i<4;i++) vertices.push(corners[i]!,corners[(i+1)%4]!); }
  if (vertices.length) { const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(vertices), new THREE.LineBasicMaterial({ color:'#d99b12', depthTest:false })); lines.userData['pointStem']=true;group.add(lines); }
  return group;
}
