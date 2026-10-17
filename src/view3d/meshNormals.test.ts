import * as THREE from 'three';
import { expect, it } from 'vitest';
import { inspectNormals, repairNormals } from './meshNormals';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
it('detects inverted shading normals and repairs them without mutating source geometry', () => {
  const source = new THREE.PlaneGeometry();
  const normal = source.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, 0, 0, -1);
  expect(inspectNormals(new THREE.Mesh(source))).toContain('2 faces with normals opposing winding');
  const repaired = repairNormals(source, 'recompute');
  expect(repaired.getAttribute('normal').getZ(0)).toBe(1);
  expect(source.getAttribute('normal').getZ(0)).toBe(-1);
});
it('flips nonindexed faces preserving UVs and groups and reverses shading normals', () => {
  const source = new THREE.PlaneGeometry().toNonIndexed();
  const repaired = repairNormals(source, 'flip');
  expect(Array.from(repaired.index!.array)).toEqual([0, 2, 1, 3, 5, 4]);
  expect(repaired.getAttribute('normal').getZ(0)).toBe(-1);
  expect(Array.from(repaired.getAttribute('uv').array)).toEqual(Array.from(source.getAttribute('uv').array));
  expect(source.index).toBeNull();
});

function outwardBox(g: THREE.BufferGeometry, center = new THREE.Vector3()) {
  const p = g.getAttribute('position'), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < (g.index?.count ?? p.count); i += 3) {
    a.fromBufferAttribute(p, g.index?.getX(i) ?? i);
    b.fromBufferAttribute(p, g.index?.getX(i + 1) ?? i + 1);
    c.fromBufferAttribute(p, g.index?.getX(i + 2) ?? i + 2);
    const mid = a.clone().add(b).add(c).divideScalar(3).sub(center);
    expect(b.sub(a).cross(c.sub(a)).dot(mid)).toBeGreaterThan(0);
  }
}

it('auto orients mixed faces across UV seams and turns an inward closed shell outward', () => {
  const source = new THREE.BoxGeometry(2, 3, 4);
  const index = source.index!;
  for (let face = 0; face < index.count / 3; face++) {
    if (face === 2 || face === 7) continue;
    const i = face * 3, b = index.getX(i + 1); index.setX(i + 1, index.getX(i + 2)); index.setX(i + 2, b);
  }
  const before = Array.from(index.array);
  const repaired = repairNormals(source, 'auto');
  outwardBox(repaired);
  expect(repaired.userData.normalRepair).toMatchObject({ closedShells: 1, ambiguousShells: 0 });
  expect(inspectNormals(new THREE.Mesh(repaired))).toContain('0 faces with normals opposing winding');
  expect(Array.from(repaired.getAttribute('uv').array)).toEqual(Array.from(source.getAttribute('uv').array));
  expect(repaired.groups).toEqual(source.groups);
  expect(Array.from(source.index!.array)).toEqual(before);
  expect(Array.from(repairNormals(repaired, 'auto').index!.array)).toEqual(Array.from(repaired.index!.array));
});

it('orients disconnected nonindexed shells independently, including a distant inward shell', () => {
  const a = new THREE.BoxGeometry().toNonIndexed();
  const inward = repairNormals(new THREE.BoxGeometry().translate(1e6, 0, 0), 'flip').toNonIndexed();
  const source = mergeGeometries([a, inward])!;
  const repaired = repairNormals(source, 'auto');
  expect(repaired.userData.normalRepair).toMatchObject({ closedShells: 2, ambiguousShells: 0 });
  const first = repaired.clone(); first.setIndex(Array.from(repaired.index!.array).slice(0, 36)); outwardBox(first);
  const second = repaired.clone(); second.setIndex(Array.from(repaired.index!.array).slice(36)); outwardBox(second, new THREE.Vector3(1e6, 0, 0));
  expect(source.index).toBeNull();
});

it('makes an open patch consistent without claiming an inferred outside', () => {
  const source = new THREE.PlaneGeometry();
  const i = source.index!, b = i.getX(1); i.setX(1, i.getX(2)); i.setX(2, b);
  const repaired = repairNormals(source, 'auto');
  expect(repaired.userData.normalRepair).toMatchObject({ closedShells: 0, ambiguousShells: 1 });
  const n = repaired.getAttribute('normal');
  for (let j = 1; j < n.count; j++) expect(n.getZ(j)).toBeCloseTo(n.getZ(0));
});

it('keeps nonmanifold and degenerate triangles finite and preserves every source face', () => {
  const source = new THREE.BufferGeometry();
  source.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 0,-1,0, 0,0,1], 3));
  source.setIndex([0,1,2, 1,0,3, 0,1,4, 0,0,0]);
  const repaired = repairNormals(source, 'auto');
  expect(repaired.index!.count).toBe(12);
  expect(Array.from(repaired.getAttribute('normal').array).every(Number.isFinite)).toBe(true);
  expect(repaired.userData.normalRepair.closedShells).toBe(0);
});

it('uses independently owned worker repair results and releases cached geometry with its source', async () => {
  const {cacheNormalRepair}=await import('./meshNormals');
  const {packGeometry,unpackGeometry,geometryTransfers}=await import('./geometryPacket');
  const source=new THREE.BoxGeometry();
  const expected=repairNormals(source,'recompute-flip');
  const packet=packGeometry(expected);
  expect(geometryTransfers(packet).length).toBeGreaterThan(0);
  const cached=unpackGeometry(packet);
  let disposed=false;cached.addEventListener('dispose',()=>{disposed=true;});
  cacheNormalRepair(source,'recompute-flip',cached);
  const a=repairNormals(source,'recompute-flip'),b=repairNormals(source,'recompute-flip');
  expect(Array.from(a.index!.array)).toEqual(Array.from(expected.index!.array));
  expect(a.groups).toEqual(expected.groups);
  a.getAttribute('position').setX(0,999);
  expect(b.getAttribute('position').getX(0)).not.toBe(999);
  expect(source.getAttribute('position').getX(0)).not.toBe(999);
  source.dispose();expect(disposed).toBe(true);
});
