import { expect, it } from 'vitest';
import * as THREE from 'three';
import { presentationMaterial, featureEdgeObject, FEATURE_EDGE_LOOK } from './displayMaterials';

it('keeps imported texture, vertex colours and cutouts in material colours without changing the source', () => {
  const map=new THREE.Texture(),alphaMap=new THREE.Texture();
  const source=new THREE.MeshStandardMaterial({color:'#527e45',map,alphaMap,vertexColors:true,alphaTest:0.45,side:THREE.DoubleSide});
  const shown=presentationMaterial(source,'consistent') as THREE.MeshBasicMaterial;
  expect(shown.color.equals(source.color)).toBe(true);expect(shown.map).toBe(map);expect(shown.vertexColors).toBe(true);
  expect(shown.alphaTest).toBe(.45);expect(shown.alphaMap).toBe(alphaMap);expect(shown.toneMapped).toBe(false);
  expect(source.type).toBe('MeshStandardMaterial');shown.dispose();source.dispose();map.dispose();alphaMap.dispose();
});
it('uses feature lines and translucent faces for structure instead of triangulating every face', () => {
  const source=new THREE.MeshStandardMaterial();const shown=presentationMaterial(source,'wireframe') as THREE.MeshBasicMaterial;
  expect(shown.wireframe).toBe(false);expect(shown.opacity).toBeLessThan(.2);expect(shown.depthWrite).toBe(false);
  shown.dispose();source.dispose();
});
it('places feature edges at every hardware instance', () => {
  const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial(),2);
  mesh.setMatrixAt(1,new THREE.Matrix4().makeTranslation(100,0,0));
  const source=new THREE.EdgesGeometry(mesh.geometry),edge=featureEdgeObject(mesh,source,FEATURE_EDGE_LOOK.realistic);
  expect((edge.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);
  expect(edge.geometry.getAttribute('edgeInstanceMatrix').array).toBe(mesh.instanceMatrix.array);
  expect(edge.userData.ownsEdgeGeometry).toBe(true);expect(edge.frustumCulled).toBe(false);
  edge.geometry.dispose();(edge.material as THREE.Material).dispose();source.dispose();mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();
});
