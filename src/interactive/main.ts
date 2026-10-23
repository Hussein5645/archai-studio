import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true; renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#dce6ee');
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 100000);
const rig = new THREE.Group(); rig.add(camera); scene.add(rig);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
const status = document.getElementById('status')!, progress = document.getElementById('progress') as HTMLProgressElement;
const selected = document.getElementById('selection')!;
const raycaster = new THREE.Raycaster();
let model: THREE.Object3D | null = null, outline: THREE.BoxHelper | null = null;
const choose = (hit?: THREE.Intersection) => {
  outline?.removeFromParent(); outline?.geometry.dispose();
  if (outline) (outline.material as THREE.Material).dispose(); outline = null;
  if (!hit) { selected.textContent = ''; return; }
  let owner = hit.object;
  while (owner.parent && !owner.userData['archai']) owner = owner.parent;
  selected.textContent = owner.userData['archai']?.id ? `${owner.name || 'Element'} · ${owner.userData['archai'].id}` : hit.object.name || 'Element';
  outline = new THREE.BoxHelper(owner, 0x316bff); scene.add(outline);
};
const frame = () => {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model), center = box.getCenter(new THREE.Vector3()), radius = Math.max(2, box.getSize(new THREE.Vector3()).length());
  rig.position.set(0, 0, 0); camera.position.copy(center).add(new THREE.Vector3(-radius * 0.7, radius * 0.5, radius * 0.7));
  controls.target.copy(center); controls.update();
};
document.getElementById('frame')!.addEventListener('click', frame);
let press: [number, number] = [0, 0];
renderer.domElement.addEventListener('pointerdown', event => { press = [event.clientX, event.clientY]; });
renderer.domElement.addEventListener('pointerup', event => {
  if (!model || Math.hypot(event.clientX-press[0], event.clientY-press[1]) > 5) return;
  raycaster.setFromCamera(new THREE.Vector2(event.clientX/innerWidth*2-1, 1-event.clientY/innerHeight*2), camera);
  choose(raycaster.intersectObject(model, true)[0]);
});
for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i); rig.add(controller);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-20)]), new THREE.LineBasicMaterial({ color: 0x316bff })); controller.add(line);
  controller.addEventListener('selectstart', () => {
    if (!model) return;
    const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld), direction = new THREE.Vector3(0,0,-1).transformDirection(controller.matrixWorld);
    raycaster.set(origin, direction); const hit = raycaster.intersectObject(model, true)[0];
    if (hit?.face && hit.face.normal.clone().transformDirection(hit.object.matrixWorld).y > 0.6) {
      const head = renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
      rig.position.x += hit.point.x - head.x; rig.position.z += hit.point.z - head.z; rig.position.y = hit.point.y;
    } else choose(hit);
  });
}
const keys = new Set<string>();
addEventListener('keydown', event => keys.add(event.key.toLowerCase())); addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
addEventListener('blur', () => keys.clear());
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!renderer.xr.isPresenting) {
    const forward = camera.getWorldDirection(new THREE.Vector3()); forward.y = 0; forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, camera.up);
    const movement = forward.multiplyScalar(Number(keys.has('w')) - Number(keys.has('s'))).addScaledVector(right, Number(keys.has('d')) - Number(keys.has('a'))).multiplyScalar(dt * 3);
    camera.position.add(movement); controls.target.add(movement); controls.update();
  }
  renderer.render(scene, camera);
});
renderer.xr.addEventListener('sessionstart', () => { controls.enabled = false; if (model) { const box = new THREE.Box3().setFromObject(model); rig.position.set(box.min.x, box.min.y, box.min.z); camera.position.set(0,1.6,0); } });
renderer.xr.addEventListener('sessionend', () => { controls.enabled = true; frame(); });
addEventListener('resize', () => { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); });

try {
  const manifest = await fetch('./scene.json').then(response => { if (!response.ok) throw Error('Scene metadata is missing'); return response.json(); });
  renderer.xr.enabled = manifest.vrEnabled !== false;
  if (renderer.xr.enabled) document.body.append(VRButton.createButton(renderer));
  const s = manifest.settings;
  renderer.toneMappingExposure = Math.pow(2, s.exposure ?? 0);
  const environment = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(environment, 0.04).texture; environment.dispose(); pmrem.dispose();
  const sun = new THREE.DirectionalLight(0xfff5e5, s.sunEnabled ? s.sunIntensity : 0), direction = manifest.sunDirection ?? [1,2,1];
  sun.position.set(...direction as [number,number,number]).multiplyScalar(100); sun.castShadow = true; sun.shadow.mapSize.set(2048,2048);
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.03;
  scene.add(sun, new THREE.HemisphereLight(0xd8e8ff, 0x7a7165, s.skyIntensity));
  for (const l of s.lights ?? []) {
    const color = new THREE.Color(l.color), light = l.kind === 'spot' ? new THREE.SpotLight(color) : new THREE.PointLight(color);
    light.position.set(...l.position as [number,number,number]); light.intensity = l.enabled ? l.intensity / (4 * Math.PI) : 0; light.distance = l.radius;
    if (light instanceof THREE.SpotLight) { const yaw = THREE.MathUtils.degToRad(l.yaw), tilt = THREE.MathUtils.degToRad(l.tilt); light.target.position.copy(light.position).add(new THREE.Vector3(Math.cos(yaw)*Math.cos(tilt),Math.sin(tilt),Math.sin(yaw)*Math.cos(tilt))); scene.add(light.target); }
    scene.add(light);
  }
  const gltf = await new GLTFLoader().loadAsync('./model.glb', event => { if (event.total) { progress.max = event.total; progress.value = event.loaded; } });
  model = gltf.scene; scene.add(model);
  const bounds = new THREE.Box3().setFromObject(model), center = bounds.getCenter(new THREE.Vector3()), radius = Math.max(5,bounds.getSize(new THREE.Vector3()).length()/2);
  sun.target.position.copy(center); sun.position.copy(center).add(new THREE.Vector3(...direction as [number,number,number]).normalize().multiplyScalar(radius*3)); scene.add(sun.target);
  Object.assign(sun.shadow.camera,{left:-radius,right:radius,top:radius,bottom:-radius,near:0.1,far:radius*6}); sun.shadow.camera.updateProjectionMatrix();
  model.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } });
  frame();
  if (manifest.camera) { camera.position.fromArray(manifest.camera.position).multiplyScalar(0.001); controls.target.fromArray(manifest.camera.target).multiplyScalar(0.001); controls.update(); }
  status.textContent = s.bakedPreview ? 'Saved baked lighting · ready' : 'Real-time web lighting · ready'; progress.hidden = true;
  if (new URLSearchParams(location.search).has('vr')) status.textContent += ' · Choose Enter VR below';
} catch (reason) { status.textContent = reason instanceof Error ? reason.message : String(reason); progress.hidden = true; }
