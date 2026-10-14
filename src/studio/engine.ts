/**
 * The ArchAI Render engine (docs/render-studio.md): the document's 3D scene in metres, lit by a
 * physical sky or an HDRI plus a sun, with entourage from the render library. Two modes:
 *
 * - real time: shadow-mapped sun, image-based light, ground-truth ambient occlusion, bloom and
 *   filmic tone mapping (AgX / ACES / Neutral);
 * - path traced: three-gpu-pathtracer, progressive global illumination with glass, depth of field
 *   and soft sky light, the way D5's path tracing mode works.
 *
 * The sky is always an equirectangular float texture (generated from three's physical Sky shader,
 * or an HDRI), so both modes and still renders see the same light.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { EquirectCamera, PhysicalCamera, WebGLPathTracer } from 'three-gpu-pathtracer';
import { ParallelMeshBVHWorker } from 'three-mesh-bvh/worker';
import type { AssetCatalog } from '@/catalog';
import type { ArchaiDocument } from '@/document';
import { localToUtc, sunDirection, sunPosition } from '@/analysis/sun';
import { buildSurfaces } from '@/view3d/vrExport';
import type { CameraState, SurfaceTarget } from '@/view3d/SceneView';
import { GROUNDS, type EntourageItem, type RenderSettings } from './settings';
import type { LibraryModel } from './library';
import { bakeScene, type BakedScene } from './bake';
import { throwIfCancelled, VR_QUALITY, type VrQuality } from './vrPreparation';

export type RenderMode = 'realtime' | 'pathtrace';
export type ClickMode = 'preview' | 'select' | 'place' | 'focus' | 'paint' | 'pick';

export interface EngineEvents {
  /** Path tracing progress (samples so far) or null in real time. */
  onSamples?(samples: number | null): void;
  onStatus?(status: string | null): void;
  /** A click in place mode: where to put the entourage (metres, scene axes). */
  onPlace?(point: [number, number, number]): void;
  /** A click in focus mode: the distance from the camera (metres). */
  onFocus?(distance: number): void;
  onSelect?(id: string | null): void;
  /** An entourage item moved, turned or scaled with the gizmo. */
  onEntourageChange?(id: string, position: [number, number, number], rotation: number, scale: number): void;
  onCameraChange?(): void;
  /** A click in paint mode on the model: what was hit and the model material slots of its element. Shift / Ctrl ask for the part / object. */
  onPaint?(target: SurfaceTarget, assetSlots: string[], modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void;
  /** A click in pick mode: the surface whose material to adjust. */
  onPick?(target: SurfaceTarget): void;
}

const TONE: Record<RenderSettings['toneMapping'], THREE.ToneMapping> = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
};

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** glTF quantised (meshopt) attributes as plain floats, which the path tracer expects. */
function toFloatAttributes(geometry: THREE.BufferGeometry): void {
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name);
    if (attribute instanceof THREE.InterleavedBufferAttribute || !(attribute.array instanceof Float32Array)) {
      const values = new Float32Array(attribute.count * attribute.itemSize);
      for (let i = 0; i < attribute.count; i++) {
        for (let c = 0; c < attribute.itemSize; c++) values[i * attribute.itemSize + c] = attribute.getComponent(i, c);
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
    }
  }
}

export class StudioEngine {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera = new PhysicalCamera(55, 1, 0.05, 20_000);
  private readonly controls: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly composer: EffectComposer;
  private readonly gtao: GTAOPass;
  private readonly bloom: UnrealBloomPass;
  private readonly pathTracer: WebGLPathTracer;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly content = new THREE.Group();
  private readonly entourage = new THREE.Group();
  private readonly ground: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly loader: GLTFLoader;
  private readonly templates = new Map<string, Promise<THREE.Group>>();
  private readonly resize: ResizeObserver;
  private settings: RenderSettings | null = null;
  private skyKey = '';
  private skyTexture: THREE.Texture | null = null;
  private mode: RenderMode = 'realtime';
  private click: ClickMode = 'select';
  private selected: string | null = null;
  private dirty = true;
  /** The path tracer's scene (BVH) is stale: rebuild before the next sample. */
  private traceStale = true;
  private tracing: Promise<void> | null = null;
  private busy = false;
  private frame = 0;
  private disposed = false;
  private compiling = false;
  private down: { x: number; y: number } | null = null;
  private bounds = new THREE.Sphere(new THREE.Vector3(), 30);
  private previewBake: THREE.Group | null = null;

  constructor(private readonly container: HTMLElement, private readonly events: EngineEvents = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.append(this.renderer.domElement);

    this.camera.position.set(25, 12, 25);
    this.camera.apertureBlades = 6;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.cameraMoved());

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (event) => {
      this.controls.enabled = !(event as unknown as { value: boolean }).value;
      if (!(event as unknown as { value: boolean }).value) this.traceStale = true;
    });
    this.gizmo.addEventListener('objectChange', () => this.gizmoChanged());
    this.scene.add(this.gizmo.getHelper());

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.03;
    // Soft edges (PCF with a blur radius).
    this.sun.shadow.radius = 3;
    this.sun.shadow.blurSamples = 16;
    this.scene.add(this.sun, this.sun.target);

    this.ground = new THREE.Mesh(new THREE.CircleGeometry(2000, 96), new THREE.MeshStandardMaterial({ color: GROUNDS.grass, roughness: 0.95 }));
    this.ground.name = 'Ground';
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.02;
    this.ground.receiveShadow = true;
    this.scene.add(this.content, this.entourage, this.ground);

    this.loader = new GLTFLoader();
    this.loader.setMeshoptDecoder(MeshoptDecoder);

    const size = new THREE.Vector2(1, 1);
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1, samples: 16 });
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(size, 0.15, 0.4, 1.4);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.pathTracer = new WebGLPathTracer(this.renderer);
    this.pathTracer.tiles.set(2, 2);
    this.pathTracer.minSamples = 1;
    this.pathTracer.renderDelay = 60;
    this.pathTracer.fadeDuration = 250;
    this.pathTracer.dynamicLowRes = true;
    this.pathTracer.lowResScale = 0.35;
    this.pathTracer.filterGlossyFactor = 0.4;
    this.pathTracer.transmissiveBounces = 10;
    // BVHs are built in workers, so preparing a large model does not freeze the studio.
    this.pathTracer.setBVHWorker(new ParallelMeshBVHWorker());

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(container);
    this.layout();
    this.loop();
  }

  // ---- the model ------------------------------------------------------------------------------

  async setDocument(doc: ArchaiDocument, catalog: AssetCatalog): Promise<void> {
    this.showBake(null);
    const root = await buildSurfaces(doc, catalog);
    if (this.disposed) return;
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      // AO's override material needs normals even when an imported flat-shaded material does not.
      // Clone cached asset geometry so the board and other views remain unchanged.
      if (!child.geometry.getAttribute('normal')) {
        child.geometry = child.geometry.clone();
        child.geometry.computeVertexNormals();
      }
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const seeThrough = materials.some((m) => m.transparent || (m as THREE.MeshPhysicalMaterial).transmission > 0);
      child.castShadow = !seeThrough;
      child.receiveShadow = true;
    });
    for (const old of [...this.content.children]) {
      this.content.remove(old);
      old.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
    }
    this.content.add(root);
    this.content.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.content);
    if (!box.isEmpty()) box.getBoundingSphere(this.bounds);
    this.placeSun();
    this.traceStale = true;
    this.dirty = true;
  }

  /** Frames the whole model from a three-quarter view on its sunlit side. */
  frameAll(): void {
    if (this.busy) return;
    const { center, radius } = this.bounds;
    const distance = Math.max(radius, 5) / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.9;
    const sun = this.sunVector();
    const flat = new THREE.Vector3(sun.x, 0, sun.z);
    if (flat.lengthSq() < 1e-6) flat.set(0.7, 0, 0.7);
    // A little off the sun's bearing, so the lit faces show some modelling.
    flat.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(35));
    this.camera.position.copy(center).add(flat.setY(0.55).normalize().multiplyScalar(distance));
    this.controls.target.copy(center);
    this.controls.update();
    this.cameraMoved();
  }

  /** A 3D view's camera (millimetres) in the studio's metres. */
  setCamera(state: CameraState): void {
    if (this.busy) return;
    this.camera.position.set(state.position[0] / 1000, state.position[1] / 1000, state.position[2] / 1000);
    this.controls.target.set(state.target[0] / 1000, state.target[1] / 1000, state.target[2] / 1000);
    if (state.fov) this.camera.fov = state.fov;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.cameraMoved();
  }

  getCamera(): CameraState {
    const p = this.camera.position;
    const t = this.controls.target;
    return { position: [p.x * 1000, p.y * 1000, p.z * 1000], target: [t.x * 1000, t.y * 1000, t.z * 1000], fov: this.camera.fov };
  }

  // ---- settings -------------------------------------------------------------------------------

  async applySettings(settings: RenderSettings, hdriUrl: string | null): Promise<void> {
    const previous = this.settings;
    this.settings = settings;
    this.renderer.toneMapping = TONE[settings.toneMapping];
    this.renderer.toneMappingExposure = 2 ** settings.exposure * (this.previewBake?.userData['bakeScale'] as number ?? 1);
    this.gtao.blendIntensity = settings.ambientOcclusion;
    this.gtao.enabled = settings.ambientOcclusion > 0;
    this.bloom.strength = settings.bloom;
    this.bloom.enabled = settings.bloom > 0;
    if (this.camera.fov !== settings.fov) {
      this.camera.fov = settings.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.fStop = settings.depthOfField ? settings.fStop : 1000;
    this.camera.focusDistance = settings.focusDistance;
    this.pathTracer.bounces = settings.bounces;
    const ground = GROUNDS[settings.ground];
    this.ground.visible = Boolean(ground);
    if (ground) (this.ground.material as THREE.MeshStandardMaterial).color.set(ground);

    this.placeSun();
    const skyKey = settings.sky === 'hdri' ? `hdri:${hdriUrl}` : `sun:${this.sunVector().toArray().map((v) => v.toFixed(3)).join(',')}`;
    if (skyKey !== this.skyKey) {
      this.skyKey = skyKey;
      const texture = settings.sky === 'hdri' && hdriUrl ? await this.loadHdri(hdriUrl) : this.physicalSky();
      if (this.skyKey !== skyKey) {
        texture.dispose();
        return;
      }
      this.skyTexture?.dispose();
      this.skyTexture = texture;
      this.scene.environment = texture;
      this.scene.background = texture;
    }
    const rotation = settings.sky === 'hdri' ? THREE.MathUtils.degToRad(settings.hdriRotation) : 0;
    this.scene.environmentRotation.set(0, rotation, 0);
    this.scene.backgroundRotation.set(0, rotation, 0);
    this.scene.environmentIntensity = settings.skyIntensity;
    this.scene.backgroundIntensity = settings.skyIntensity;

    // Only what the path tracer cannot pick up by itself restarts its accumulation.
    this.pathTracer.updateLights();
    this.pathTracer.updateEnvironment();
    this.pathTracer.updateMaterials();
    this.pathTracer.updateCamera();
    if (previous?.ground !== settings.ground) this.traceStale = true;
    this.dirty = true;
  }

  /** Unit vector towards the sun (scene axes). */
  private sunVector(): THREE.Vector3 {
    const s = this.settings;
    if (!s) return new THREE.Vector3(0.5, 0.6, 0.4).normalize();
    const position =
      s.sunMode === 'time'
        ? sunPosition(localToUtc(s.date, `${String(Math.floor(s.time)).padStart(2, '0')}:${String(Math.round((s.time % 1) * 60) % 60).padStart(2, '0')}`, s.utcOffset), s.latitude, s.longitude)
        : { azimuth: THREE.MathUtils.degToRad(s.azimuth), altitude: THREE.MathUtils.degToRad(s.altitude) };
    return new THREE.Vector3(...sunDirection(position, s.northAngle)).normalize();
  }

  private placeSun(): void {
    const s = this.settings;
    const direction = this.sunVector();
    const { center } = this.bounds;
    const radius = Math.max(this.bounds.radius, 10) * 1.2;
    this.sun.position.copy(center).addScaledVector(direction, radius * 2);
    this.sun.target.position.copy(center);
    const up = direction.y > 0;
    // Sunlight fades out at the horizon and is off at night.
    this.sun.visible = Boolean(s?.sunEnabled) && up;
    this.sun.intensity = (s?.sunIntensity ?? 3) * THREE.MathUtils.smoothstep(direction.y, 0, 0.12);
    const shadow = this.sun.shadow.camera;
    shadow.left = -radius;
    shadow.right = radius;
    shadow.top = radius;
    shadow.bottom = -radius;
    shadow.near = 0.5;
    shadow.far = radius * 4;
    shadow.updateProjectionMatrix();
  }

  /** three's physical Sky rendered to a float equirectangular texture (sun disc clamped: the sun light carries the sun). */
  private physicalSky(): THREE.DataTexture {
    const sky = new Sky();
    sky.scale.setScalar(1000);
    const uniforms = sky.material.uniforms as Record<string, { value: unknown }>;
    (uniforms['turbidity'] as { value: number }).value = 3;
    (uniforms['rayleigh'] as { value: number }).value = 1.2;
    (uniforms['mieCoefficient'] as { value: number }).value = 0.004;
    (uniforms['mieDirectionalG'] as { value: number }).value = 0.82;
    (uniforms['sunPosition'] as { value: THREE.Vector3 }).value.copy(this.sunVector());
    const skyScene = new THREE.Scene();
    skyScene.add(sky);
    const cube = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cubeCamera = new THREE.CubeCamera(1, 3000, cube);
    const toneMapping = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;
    cubeCamera.update(this.renderer, skyScene);

    const width = 1024;
    const height = 512;
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
    const quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { cube: { value: cube.texture } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `
          uniform samplerCube cube;
          varying vec2 vUv;
          void main() {
            float phi = (vUv.x - 0.5) * 6.28318530718;
            float theta = (vUv.y - 0.5) * 3.14159265359;
            vec3 dir = vec3(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi));
            vec3 colour = textureCube(cube, dir).rgb;
            // Below the horizon: a dim neutral ground bounce instead of the shader's dark void.
            colour = mix(colour, vec3(0.18, 0.18, 0.17) * max(colour.b, 0.25), smoothstep(0.0, -0.08, dir.y));
            gl_FragColor = vec4(min(colour, vec3(6.0)) * 0.35, 1.0);
          }`,
      }),
    );
    this.renderer.setRenderTarget(target);
    quad.render(this.renderer);
    const data = new Float32Array(width * height * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, data);
    this.renderer.setRenderTarget(null);
    this.renderer.toneMapping = toneMapping;
    quad.dispose();
    (quad.material as THREE.Material).dispose();
    target.dispose();
    cube.dispose();
    sky.geometry.dispose();
    sky.material.dispose();

    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  private async loadHdri(url: string): Promise<THREE.DataTexture> {
    this.events.onStatus?.('Loading sky…');
    try {
      const texture = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(url);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      return texture;
    } finally {
      this.events.onStatus?.(null);
    }
  }

  // ---- entourage ------------------------------------------------------------------------------

  private template(model: LibraryModel): Promise<THREE.Group> {
    let template = this.templates.get(model.id);
    if (!template) {
      template = (model.load ? model.load().then((bytes) => this.loader.parseAsync(bytes, '')) : this.loader.loadAsync(model.url)).then((gltf) => {
        const group = gltf.scene;
        // Package models (.CAI) come in any unit: scale to the package's real size, base centred on the origin.
        if (model.widthMm) {
          const box = new THREE.Box3().setFromObject(group);
          const size = box.getSize(new THREE.Vector3());
          const scale = size.x > 0 ? model.widthMm / 1000 / size.x : 1;
          const centre = box.getCenter(new THREE.Vector3());
          const holder = new THREE.Group();
          group.position.set(-centre.x, -box.min.y, -centre.z);
          holder.add(group);
          holder.scale.setScalar(scale);
          holder.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            toFloatAttributes(child.geometry);
            if (!child.geometry.getAttribute('normal')) child.geometry.computeVertexNormals();
            child.castShadow = true;
            child.receiveShadow = true;
          });
          holder.updateMatrixWorld(true);
          const wrapper = new THREE.Group();
          wrapper.add(holder);
          return wrapper;
        }
        group.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          toFloatAttributes(child.geometry);
          if (!child.geometry.getAttribute('normal')) child.geometry.computeVertexNormals();
          child.castShadow = true;
          child.receiveShadow = true;
        });
        // Bake the node transforms (meshopt quantisation puts scales there) into one rest pose.
        group.updateMatrixWorld(true);
        return group;
      });
      template.catch(() => this.templates.delete(model.id));
      this.templates.set(model.id, template);
    }
    return template;
  }

  /** Brings the placed entourage in line with the settings (adds, moves, removes). */
  async syncEntourage(items: EntourageItem[], models: Map<string, LibraryModel>): Promise<void> {
    const wanted = new Map(items.map((item) => [item.id, item]));
    let changed = false;
    for (const child of [...this.entourage.children]) {
      if (!wanted.has(child.userData['entourageId'] as string)) {
        if (this.gizmo.object === child) this.gizmo.detach();
        this.entourage.remove(child);
        changed = true;
      }
    }
    for (const item of items) {
      let object = this.entourage.children.find((child) => child.userData['entourageId'] === item.id);
      if (!object) {
        const model = models.get(item.asset);
        if (!model) continue;
        this.events.onStatus?.(`Loading ${model.name}…`);
        try {
          object = (await this.template(model)).clone(true);
        } catch {
          continue;
        } finally {
          this.events.onStatus?.(null);
        }
        if (this.entourage.children.some((child) => child.userData['entourageId'] === item.id)) continue;
        object.userData['entourageId'] = item.id;
        object.name = model.name;
        this.entourage.add(object);
        changed = true;
      }
      const [x, y, z] = item.position;
      if (object.position.x !== x || object.position.y !== y || object.position.z !== z || object.rotation.y !== item.rotation || object.scale.x !== item.scale) {
        object.position.set(x, y, z);
        object.rotation.set(0, item.rotation, 0);
        object.scale.setScalar(item.scale);
        changed = true;
      }
    }
    if (changed) {
      this.entourage.updateMatrixWorld(true);
      this.traceStale = true;
      this.dirty = true;
    }
    if (this.selected && !wanted.has(this.selected)) this.select(null);
  }

  select(id: string | null): void {
    this.selected = id;
    const object = id ? this.entourage.children.find((child) => child.userData['entourageId'] === id) : undefined;
    if (object) this.gizmo.attach(object);
    else this.gizmo.detach();
    this.dirty = true;
    this.events.onSelect?.(object ? id : null);
  }

  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmo.setMode(mode);
    this.gizmo.showX = mode !== 'rotate';
    this.gizmo.showZ = mode !== 'rotate';
    this.gizmo.showY = mode !== 'translate' || true;
    this.dirty = true;
  }

  private gizmoChanged(): void {
    const object = this.gizmo.object;
    if (!object) return;
    const id = object.userData['entourageId'] as string;
    // Uniform scale, turning about the vertical only.
    if (this.gizmo.mode === 'scale') object.scale.setScalar(Math.max(0.05, (object.scale.x + object.scale.y + object.scale.z) / 3));
    this.events.onEntourageChange?.(id, [object.position.x, object.position.y, object.position.z], object.rotation.y, object.scale.x);
    this.dirty = true;
  }

  setClickMode(mode: ClickMode): void {
    this.click = mode;
    this.renderer.domElement.style.cursor = mode === 'select' || mode === 'preview' ? '' : mode === 'paint' ? 'cell' : mode === 'pick' ? 'copy' : 'crosshair';
  }

  // ---- interaction ----------------------------------------------------------------------------

  private onPointerDown = (event: PointerEvent) => {
    this.down = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.click === 'preview') { this.down = null; return; }
    const down = this.down;
    this.down = null;
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4 || event.button !== 0) return;
    if (this.gizmo.dragging) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    const targets = this.click === 'select' ? [this.entourage] : [this.content, this.entourage, this.ground];
    const hit = this.raycaster.intersectObjects(targets, true).find((h) => h.object.visible);
    if (this.click === 'place') {
      if (hit) this.events.onPlace?.([hit.point.x, hit.point.y, hit.point.z]);
      return;
    }
    if (this.click === 'focus') {
      if (hit) this.events.onFocus?.(hit.distance);
      return;
    }
    if (this.click === 'paint' || this.click === 'pick') {
      const target = this.surfaceHit();
      if (target && (this.click === 'pick' || event.altKey)) this.events.onPick?.(target);
      else if (target) this.events.onPaint?.(target, this.assetSlotsOf(target.elementId), event);
      return;
    }
    let object: THREE.Object3D | null = hit?.object ?? null;
    while (object && !object.userData['entourageId']) object = object.parent;
    this.select((object?.userData['entourageId'] as string | undefined) ?? null);
  };

  /** The model surface under the raycaster (set from the last click): element, slot, surface and material. */
  private surfaceHit(): SurfaceTarget | null {
    for (const hit of this.raycaster.intersectObjects([this.content], true)) {
      const mesh = hit.object;
      if (!(mesh instanceof THREE.Mesh) || !hit.face || !mesh.visible) continue;
      const elementId = (mesh.userData['ownerId'] ?? mesh.userData['elementId']) as string | undefined;
      if (typeof elementId !== 'string') continue;
      const group = hit.face.materialIndex ?? 0;
      const slots = mesh.userData['slots'] as string[] | undefined;
      const surfaces = mesh.userData['surfaces'] as (string | null)[] | null | undefined;
      let surface = surfaces?.[group] ?? null;
      if (!surface && mesh.userData['surfaceByNormal']) {
        const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
        surface = normal.y > 0.7 ? 'top' : normal.y < -0.7 ? 'bottom' : 'sides';
      }
      const material = Array.isArray(mesh.material) ? (mesh.material[group] ?? mesh.material[0]) : mesh.material;
      const materialId = typeof material?.userData['materialId'] === 'string' ? (material.userData['materialId'] as string) : null;
      return { elementId, slot: slots?.[group] ?? (mesh.userData['slot'] as string | undefined) ?? null, surface, materialId };
    }
    return null;
  }

  private assetSlotsOf(elementId: string): string[] {
    const slots = new Set<string>();
    this.content.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || (child.userData['ownerId'] ?? child.userData['elementId']) !== elementId) return;
      for (const slot of (child.userData['slots'] as string[] | undefined) ?? []) if (slot.startsWith('asset:')) slots.add(slot);
    });
    return [...slots];
  }

  private cameraMoved(): void {
    this.pathTracer.updateCamera();
    this.dirty = true;
    this.events.onCameraChange?.();
  }

  private layout(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (this.busy) return;
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.pathTracer.updateCamera();
    this.dirty = true;
  }

  // ---- rendering ------------------------------------------------------------------------------

  showBake(root: THREE.Group | null): void {
    if (this.previewBake) this.scene.remove(this.previewBake);
    this.previewBake = root;
    // Unlit prepared geometry already contains occlusion and can omit normals.
    this.gtao.enabled = !root && (this.settings?.ambientOcclusion ?? 0) > 0;
    this.bloom.enabled = !root;
    this.renderer.toneMappingExposure = 2 ** (this.settings?.exposure ?? 0) * (root?.userData['bakeScale'] as number ?? 1);
    if (root) this.scene.add(root);
    this.content.visible = !root;
    this.entourage.visible = !root;
    this.ground.visible = !root && this.settings?.ground !== 'none';
    this.gizmo.getHelper().visible = !root && this.mode === 'realtime';
    this.traceStale = true;
    this.dirty = true;
  }

  async bakeVr(quality: VrQuality, signal: AbortSignal, progress: (fraction: number) => void): Promise<BakedScene> {
    this.assertLegacyLoaded();
    throwIfCancelled(signal);
    if (this.busy) throw new Error('Preparation is already running');
    this.showBake(null);
    const controlsEnabled = this.controls.enabled;
    this.controls.enabled = false;
    this.busy = true;
    const source = new THREE.Group();
    source.add(this.content.clone(true), this.entourage.clone(true));
    if (this.ground.visible) {
      const ground = this.ground.clone();
      // The preview ground covers the horizon. Publish only the area visitors can reach.
      ground.geometry = new THREE.CircleGeometry(Math.max(30, this.bounds.radius * 2), 48);
      ground.position.x = this.bounds.center.x;
      ground.position.z = this.bounds.center.z;
      source.add(ground);
    }
    const image = this.skyTexture?.image as { data?: Float32Array; width?: number; height?: number } | undefined;
    const environment = image?.data instanceof Float32Array && image.width && image.height ? { data: image.data.slice(), width: image.width, height: image.height, rotation: this.settings?.sky === 'hdri' ? THREE.MathUtils.degToRad(this.settings.hdriRotation) : 0 } : null;
    let background: THREE.Texture | null = null;
    try {
      background = this.bakeBackground();
      return await bakeScene(source, { environment, sun: this.sunVector().toArray() as [number, number, number], sunIntensity: this.sun.visible ? this.sun.intensity : 0, skyIntensity: this.settings?.skyIntensity ?? 1 }, quality, signal, progress, background ?? undefined);
    } catch (error) {
      background?.dispose();
      throw error;
    } finally {
      // Only the temporary ground is owned by this snapshot; project geometry is shared.
      if (this.ground.visible) (source.children.at(-1) as THREE.Mesh)?.geometry.dispose();
      this.controls.enabled = controlsEnabled;
      this.busy = false;
      this.dirty = true;
    }
  }

  /** Embed the chosen sky as a display-ready texture, so shared VR needs no account/HDRI fetch. */
  private bakeBackground(): THREE.Texture | null {
    if (!this.skyTexture) return null;
    const width = 1024, height = 512;
    const target = new THREE.WebGLRenderTarget(width, height);
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const mapping = this.settings?.toneMapping === 'aces' ? 'ACESFilmicToneMapping' : this.settings?.toneMapping === 'neutral' ? 'NeutralToneMapping' : 'AgXToneMapping';
    const material = new THREE.ShaderMaterial({
      toneMapped: false,
      uniforms: { sky: { value: this.skyTexture }, strength: { value: this.settings?.skyIntensity ?? 1 }, rotation: { value: this.settings?.sky === 'hdri' ? THREE.MathUtils.degToRad(this.settings.hdriRotation) / (2 * Math.PI) : 0 }, toneMappingExposure: { value: 2 ** (this.settings?.exposure ?? 0) } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D sky; uniform float strength; uniform float rotation; varying vec2 vUv;
        #include <tonemapping_pars_fragment>
        void main() { vec3 colour = texture2D(sky, vec2(fract(vUv.x + rotation), vUv.y)).rgb * strength;
          gl_FragColor = vec4(${mapping}(colour), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const quad = new FullScreenQuad(material);
    const savedTarget = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(target);
      quad.render(this.renderer);
      const pixels = new Uint8Array(width * height * 4);
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The prepared sky could not be encoded');
      const image = context.createImageData(width, height);
      for (let row = 0; row < height; row++) image.data.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), (height - row - 1) * width * 4);
      context.putImageData(image, 0, 0);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    } finally { this.renderer.setRenderTarget(savedTarget); quad.dispose(); material.dispose(); target.dispose(); }
  }

  async renderPanorama(quality: VrQuality, signal: AbortSignal, progress: (fraction: number) => void): Promise<Blob> {
    this.assertLegacyLoaded();
    throwIfCancelled(signal);
    this.showBake(null);
    this.busy = true;
    const helper = this.gizmo.getHelper();
    const helperVisible = helper.visible;
    helper.visible = false;
    const pixelRatio = this.renderer.getPixelRatio();
    const controlsEnabled = this.controls.enabled;
    this.controls.enabled = false;
    const { dynamicLowRes, rasterizeScene, renderDelay, fadeDuration, minSamples } = this.pathTracer;
    const tiles = this.pathTracer.tiles.clone();
    const preset = VR_QUALITY[quality];
    try {
      await this.prepareTrace();
      throwIfCancelled(signal);
      const camera = new EquirectCamera();
      camera.position.copy(this.camera.position);
      // Store a world-oriented panorama; the viewer chooses the initial facing direction.
      camera.updateMatrixWorld(true);
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(preset.panoramaWidth, preset.panoramaWidth / 2, false);
      this.pathTracer.dynamicLowRes = false;
      this.pathTracer.rasterizeScene = false;
      this.pathTracer.renderDelay = 0;
      this.pathTracer.fadeDuration = 0;
      this.pathTracer.minSamples = 1;
      this.pathTracer.tiles.set(3, 3);
      this.pathTracer.setCamera(camera);
      this.pathTracer.reset();
      let last = performance.now();
      while (this.pathTracer.samples < preset.panoramaSamples) {
        throwIfCancelled(signal);
        if (this.disposed) throw new DOMException('Preparation cancelled', 'AbortError');
        this.pathTracer.renderSample();
        if (performance.now() - last > 30) {
          progress(Math.min(1, this.pathTracer.samples / preset.panoramaSamples));
          await nextFrame();
          last = performance.now();
        }
      }
      throwIfCancelled(signal);
      const blob = await new Promise<Blob>((resolve, reject) => this.renderer.domElement.toBlob((result) => result ? resolve(result) : reject(new Error('The panorama could not be encoded')), 'image/png'));
      progress(1);
      return blob;
    } finally {
      this.pathTracer.dynamicLowRes = dynamicLowRes;
      this.pathTracer.rasterizeScene = rasterizeScene;
      this.pathTracer.renderDelay = renderDelay;
      this.pathTracer.fadeDuration = fadeDuration;
      this.pathTracer.minSamples = minSamples;
      this.pathTracer.tiles.copy(tiles);
      this.controls.enabled = controlsEnabled;
      helper.visible = helperVisible;
      this.busy = false;
      if (!this.disposed) {
        this.pathTracer.setCamera(this.camera);
        this.renderer.setPixelRatio(pixelRatio);
        this.layout();
        this.pathTracer.reset();
      }
    }
  }

  private assertLegacyLoaded(): void {
    const missing = this.settings?.entourage.filter((item) => !this.entourage.children.some((child) => child.userData['entourageId'] === item.id));
    if (missing?.length) throw new Error('Some saved Render placements could not be loaded. Sign in and reopen VR preparation before exporting this scene.');
  }

  setMode(mode: RenderMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.gizmo.getHelper().visible = mode === 'realtime';
    this.dirty = true;
    if (mode === 'realtime') this.events.onSamples?.(null);
  }

  /** Rebuilds the path tracer's scene (BVH) when the model or entourage changed. */
  private prepareTrace(): Promise<void> {
    if (!this.traceStale) return Promise.resolve();
    this.tracing ??= (async () => {
      this.traceStale = false;
      this.events.onStatus?.('Preparing path tracing…');
      const helper = this.gizmo.getHelper();
      this.scene.remove(helper);
      try {
        await this.pathTracer.setSceneAsync(this.scene, this.camera);
      } finally {
        this.scene.add(helper);
        this.events.onStatus?.(null);
        this.tracing = null;
      }
    })();
    return this.tracing;
  }

  private loop = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    if (this.busy) return;
    this.controls.update();
    if (this.mode === 'pathtrace') {
      if (this.traceStale || this.tracing) {
        void this.prepareTrace();
        return;
      }
      this.pathTracer.renderSample();
      if ((this.pathTracer as WebGLPathTracer & { isCompiling: boolean }).isCompiling !== this.compiling) {
        this.compiling = (this.pathTracer as WebGLPathTracer & { isCompiling: boolean }).isCompiling;
        this.events.onStatus?.(this.compiling ? 'Compiling the path tracer… (a few seconds, once per session)' : null);
      }
      this.events.onSamples?.(Math.floor(this.pathTracer.samples));
      return;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.composer.render();
  };

  /**
   * Renders a still at `width` × `height` and returns a PNG. Path traced stills accumulate
   * `samples` samples; real-time ones are a single high-resolution frame.
   */
  async renderStill(options: { width: number; height: number; samples: number; pathTraced: boolean }, onProgress?: (fraction: number) => void): Promise<Blob> {
    if (options.pathTraced) await this.prepareTrace();
    this.busy = true;
    const helper = this.gizmo.getHelper();
    helper.visible = false;
    const pixelRatio = this.renderer.getPixelRatio();
    const aspect = this.camera.aspect;
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(options.width, options.height, false);
      this.camera.aspect = options.width / options.height;
      this.camera.updateProjectionMatrix();
      if (options.pathTraced) {
        const { dynamicLowRes, tiles } = this.pathTracer;
        const savedTiles = tiles.clone();
        this.pathTracer.dynamicLowRes = false;
        this.pathTracer.tiles.set(3, 3);
        this.pathTracer.updateCamera();
        this.pathTracer.reset();
        let last = performance.now();
        while (this.pathTracer.samples < options.samples) {
          this.pathTracer.renderSample();
          if (performance.now() - last > 30) {
            onProgress?.(Math.min(1, this.pathTracer.samples / options.samples));
            await nextFrame();
            last = performance.now();
          }
        }
        this.pathTracer.dynamicLowRes = dynamicLowRes;
        this.pathTracer.tiles.copy(savedTiles);
      } else {
        this.composer.setPixelRatio(1);
        this.composer.setSize(options.width, options.height);
        this.composer.render();
      }
      onProgress?.(1);
      return await new Promise<Blob>((resolve, reject) => this.renderer.domElement.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded'))), 'image/png'));
    } finally {
      this.renderer.setPixelRatio(pixelRatio);
      this.camera.aspect = aspect;
      helper.visible = this.mode === 'realtime';
      this.busy = false;
      this.layout();
      this.pathTracer.reset();
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.gizmo.dispose();
    this.pathTracer.dispose();
    this.composer.dispose();
    this.skyTexture?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
