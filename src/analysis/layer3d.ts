/**
 * Draws the running analysis inside one 3D view. The view's own scene is left untouched: after
 * its normal render, the building is drawn a second time with an analysis material (lines and
 * helpers hidden), and a ground receiver plane, wind streaks or emitter markers are added as
 * extras. Shadows and sun hours come from a depth-map atlas rendered from each sun direction;
 * noise occlusion and wind obstacles come from a top-down height map of the model.
 */
import * as THREE from 'three';
import type { ViewStyle } from '@/view3d/SceneView';
import type { AnalysisSpec } from './model';
import { WindSolver } from './windSolver';

const MAX_SUN = 24;
const MAX_EMITTERS = 16;
const HEIGHT_RES = 512;
const WIND_RES = 96;
const PARTICLES = 1400;

const RAMP_GLSL = /* glsl */ `
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.19, 0.28, 0.73), c1 = vec3(0.13, 0.69, 0.87), c2 = vec3(0.35, 0.80, 0.36), c3 = vec3(0.98, 0.80, 0.20), c4 = vec3(0.86, 0.19, 0.13);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}`;

const STOPS: [number, number, number][] = [
  [0.19, 0.28, 0.73],
  [0.13, 0.69, 0.87],
  [0.35, 0.8, 0.36],
  [0.98, 0.8, 0.2],
  [0.86, 0.19, 0.13],
];

export function ramp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * 4;
  const i = Math.min(3, Math.floor(x));
  const f = x - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 local = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    n = mat3(instanceMatrix) * n;
  #endif
  vec4 world = modelMatrix * local;
  vWorld = world.xyz;
  vNormal = length(n) > 0.0 ? normalize(mat3(modelMatrix) * n) : vec3(0.0);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
varying vec3 vWorld;
varying vec3 vNormal;
uniform vec3 uLight;
uniform float uGround;
uniform float uShading;
uniform float uOpacity;
${RAMP_GLSL}

#if defined(SUN)
uniform sampler2D uAtlas;
uniform mat4 uLightMatrices[${MAX_SUN}];
uniform vec3 uSunDirs[${MAX_SUN}];
uniform float uHours[${MAX_SUN}];
uniform int uCount;
uniform float uGrid;
uniform float uMaxHours;
uniform float uOffset;
uniform float uDepthBias;
float lit(int i, vec3 p, vec3 n) {
  vec3 dir = uSunDirs[i];
  if (length(n) > 0.0 && dot(n, dir) <= 0.0) return 0.0;
  vec4 lp = uLightMatrices[i] * vec4(p + n * uOffset, 1.0);
  vec3 ndc = lp.xyz / lp.w;
  vec2 uv = ndc.xy * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float tile = float(i);
  vec2 cell = vec2(mod(tile, uGrid), floor(tile / uGrid));
  float stored = texture2D(uAtlas, (cell + uv) / uGrid).r;
  return (ndc.z * 0.5 + 0.5) - uDepthBias > stored ? 0.0 : 1.0;
}
#endif

#if defined(NOISE)
uniform vec4 uEmitters[${MAX_EMITTERS}];
uniform int uEmitterCount;
uniform float uMin;
uniform float uMax;
uniform float uBarrier;
uniform float uReceiver;
#endif

#if defined(NOISE) || defined(WIND)
uniform sampler2D uHeight;
uniform vec4 uBox; // centre x, centre z, half size, max height
uniform float uTexel;
vec2 boxUv(vec2 xz) {
  return vec2((xz.x - (uBox.x - uBox.z)) / (2.0 * uBox.z), ((uBox.y + uBox.z) - xz.y) / (2.0 * uBox.z));
}
float heightAt(vec2 xz) {
  vec2 uv = boxUv(xz);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture2D(uHeight, uv).r * uBox.w;
}
#endif

#if defined(WIND)
uniform sampler2D uSpeed;
uniform vec4 uWindHeights;
#endif

void main() {
  #include <clipping_planes_fragment>
  vec3 n = vNormal;
  if (!gl_FrontFacing && length(n) > 0.0) n = -n;
  float shade = length(n) > 0.0 ? 0.72 + 0.28 * max(dot(n, uLight), 0.0) : 0.9;
  vec3 colour = vec3(0.93);
  // The analysed quantity itself (hours, lit 0/1, dB), for data export (OUTPUT_VALUE).
  float value = -1.0;

  #if defined(SUN_SHADOWS)
    float l = uCount > 0 ? lit(0, vWorld, n) : 0.0;
    float direct = uCount > 0 && length(n) > 0.0 ? max(dot(n, uSunDirs[0]), 0.0) : 0.6;
    colour = vec3(0.95, 0.94, 0.91) * (0.5 + 0.5 * l * direct) + vec3(0.02, 0.02, 0.05) * (1.0 - l);
    shade = 1.0;
    value = l;
  #elif defined(SUN_HOURS)
    float hours = 0.0;
    for (int i = 0; i < ${MAX_SUN}; i++) {
      if (i >= uCount) break;
      hours += lit(i, vWorld, n) * uHours[i];
    }
    colour = ramp(hours / max(uMaxHours, 0.001));
    value = hours;
  #elif defined(NOISE)
    vec3 p = uGround > 0.5 ? vWorld + vec3(0.0, uReceiver, 0.0) : vWorld + n * uTexel * 1.5;
    float energy = 0.0;
    for (int i = 0; i < ${MAX_EMITTERS}; i++) {
      if (i >= uEmitterCount) break;
      vec3 e = uEmitters[i].xyz;
      float r = max(distance(p, e) / 1000.0, 1.0);
      float level = uEmitters[i].w - 20.0 * log(r) / log(10.0);
      for (int s = 1; s < 24; s++) {
        vec3 q = mix(e, p, float(s) / 24.0);
        if (heightAt(q.xz) > q.y + 250.0) { level -= uBarrier; break; }
      }
      energy += pow(10.0, level / 10.0);
    }
    float db = 10.0 * log(max(energy, 1e-6)) / log(10.0);
    colour = ramp((db - uMin) / max(uMax - uMin, 1.0));
    value = db;
  #elif defined(WIND)
    vec2 uv = boxUv(vWorld.xz + n.xz * uTexel * 2.0);
    float band = uGround > 0.5 ? 0.0 : (vWorld.y < (uWindHeights.x + uWindHeights.y) * 0.5 ? 0.0 : vWorld.y < (uWindHeights.y + uWindHeights.z) * 0.5 ? 1.0 : vWorld.y < (uWindHeights.z + uWindHeights.w) * 0.5 ? 2.0 : 3.0);
    colour = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec3(0.9) : texture2D(uSpeed, vec2(uv.x, (clamp(uv.y, 0.005, 0.995) + band) / 4.0)).rgb;
    if (uGround > 0.5) shade = 1.0;
  #endif
  #if defined(OUTPUT_VALUE)
    gl_FragColor = vec4(value, vWorld.y, 1.0, 1.0);
  #else
    gl_FragColor = vec4(colour * mix(1.0, shade, uShading), uOpacity);
  #endif
}`;

export interface AnalysisSample {
  /** Board millimetres (x, y) and the sampled surface height (z). */
  x: number;
  y: number;
  z: number;
  value: number;
}

interface Host {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  content: THREE.Object3D;
  container: HTMLElement;
  helpers: () => THREE.Object3D[];
  /** Centre and radius of the project (not generated context or far-away items); the whole scene when absent. */
  focus?: () => { centre: THREE.Vector3; radius: number };
}

function isLineLike(object: THREE.Object3D): boolean {
  const o = object as unknown as Record<string, unknown>;
  const material = (object as THREE.Mesh).material as unknown as Record<string, unknown> | undefined;
  return Boolean(o['isLine'] || o['isLineSegments2'] || o['isLine2'] || o['isPoints'] || o['isSprite'] || material?.['isLineMaterial']);
}

export class AnalysisLayer {
  private spec: AnalysisSpec | null = null;
  private key = '';
  private dirty = true;
  private readonly extras = new THREE.Group();
  private contentMaterial: THREE.ShaderMaterial | null = null;
  private groundMaterial: THREE.ShaderMaterial | null = null;
  private ground: THREE.Mesh | null = null;
  private atlas: THREE.WebGLRenderTarget | null = null;
  private height: THREE.WebGLRenderTarget | null = null;
  private lines: THREE.Object3D[] = [];
  private readonly legend: HTMLDivElement;
  private readonly depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  private heightMaterial: THREE.ShaderMaterial | null = null;
  private box = { x: 0, z: 0, half: 1, top: 1 };
  // wind
  private solver: WindSolver | null = null;
  private windSolvers: WindSolver[] = [];
  private windHeights: number[] = [];
  private particles: THREE.LineSegments | null = null;
  private particleState: Float32Array | null = null;
  private speedTexture: THREE.DataTexture | null = null;
  private speedBuffer: Float32Array | null = null;
  private frameCount = 0;

  constructor(private readonly host: Host) {
    this.extras.name = 'analysis-extras';
    host.scene.add(this.extras);
    this.legend = document.createElement('div');
    Object.assign(this.legend.style, {
      position: 'absolute', left: '8px', top: '8px', padding: '6px 8px', borderRadius: '6px', background: 'rgba(255,255,255,0.92)',
      boxShadow: '0 1px 4px rgba(0,0,0,0.18)', font: '11px system-ui, sans-serif', color: '#1f2328', pointerEvents: 'none', display: 'none', maxWidth: '70%',
    } satisfies Partial<CSSStyleDeclaration>);
    host.container.append(this.legend);
  }

  get active(): boolean {
    return this.spec !== null;
  }

  get animating(): boolean {
    return this.spec?.kind === 'wind';
  }

  set(spec: AnalysisSpec | null): void {
    const key = spec ? JSON.stringify(spec) : '';
    if (key === this.key) return;
    this.key = key;
    this.spec = spec;
    this.teardown();
    this.dirty = true;
    this.legend.style.display = spec ? 'block' : 'none';
  }

  pickEmitter(raycaster: THREE.Raycaster): string | null {
    const hit = raycaster.intersectObjects(this.extras.children, true).find((hit) => typeof hit.object.userData['emitterId'] === 'string');
    return hit ? hit.object.userData['emitterId'] as string : null;
  }

  emitterPosition(id: string): THREE.Vector3 | null {
    const emitter = this.spec?.kind === 'noise' ? this.spec.emitters.find((item) => item.id === id) : null;
    return emitter ? new THREE.Vector3(emitter.x, emitter.y, emitter.z) : null;
  }

  /** Sets up maps for the current spec now (normally done lazily by the next render). */
  ensureReady(): void {
    if (this.spec && this.dirty) {
      this.dirty = false;
      this.prepare();
    }
  }

  /**
   * The analysed values on a grid over the analysis box, in board millimetres: `x`, `y` on the
   * board, `z` the height of the surface sampled. Sun and noise render the display shader top
   * down in a value mode into a float target (the same computation as on screen); `clipTop`
   * cuts away everything above a height, to sample a level's floor. Wind reads its solvers at
   * their four heights (m/s = speed ratio × the free-stream speed).
   */
  sampleValues(spacing: number, clipTop: number | null): AnalysisSample[] {
    const spec = this.spec;
    if (!spec) return [];
    this.ensureReady();
    if (spec.kind === 'wind') return this.windSamples(spec.speed);
    if (!this.contentMaterial || !this.groundMaterial || !this.ground) return [];
    const { renderer, scene } = this.host;
    const res = Math.min(512, Math.max(2, Math.round((2 * this.box.half) / spacing)));
    const step = (2 * this.box.half) / res;
    const valueMaterial = (base: THREE.ShaderMaterial) => {
      const material = base.clone();
      material.defines = { ...base.defines, OUTPUT_VALUE: '' };
      // Share the live uniforms (atlas, emitters, maps) rather than copies.
      for (const [name, uniform] of Object.entries(base.uniforms)) material.uniforms[name] = uniform;
      material.polygonOffset = false;
      material.wireframe = false;
      material.transparent = false;
      material.depthWrite = true;
      material.needsUpdate = true;
      return material;
    };
    const content = valueMaterial(this.contentMaterial);
    const groundValue = valueMaterial(this.groundMaterial);
    const target = new THREE.WebGLRenderTarget(res, res, { type: THREE.FloatType, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const h = this.box.half;
    const top = Math.max(this.box.top, 1000);
    const camera = new THREE.OrthographicCamera(-h, h, h, -h, 1, top * 2 + 10);
    camera.position.set(this.box.x, top * 1.5 + 5, this.box.z);
    camera.up.set(0, 0, -1);
    camera.lookAt(this.box.x, 0, this.box.z);
    camera.updateMatrixWorld();
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const pixels = new Float32Array(res * res * 4);
    const groundMaterial = this.ground.material;
    try {
      this.withDepthPass(() => {
        if (clipTop !== null) renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), clipTop)];
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        // The receiver plane first, then the model over it (depth-tested, as seen from above).
        this.ground!.material = groundValue;
        renderer.render(this.ground!, camera);
        scene.overrideMaterial = content;
        renderer.render(scene, camera);
        renderer.autoClear = autoClear;
        renderer.readRenderTargetPixels(target, 0, 0, res, res, pixels);
      });
    } finally {
      this.ground.material = groundMaterial;
      renderer.setClearColor(clear, alpha);
      target.dispose();
      content.dispose();
      groundValue.dispose();
    }
    const samples: AnalysisSample[] = [];
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const k = (j * res + i) * 4;
        // Rows are read bottom-up; the camera's up is board −y.
        if (pixels[k + 3]! < 0.5 || pixels[k]! < 0) continue;
        samples.push({ x: this.box.x - h + (i + 0.5) * step, y: this.box.z + h - (j + 0.5) * step, z: pixels[k + 1]!, value: pixels[k]! });
      }
    }
    return samples;
  }

  private windSamples(freeStream: number): AnalysisSample[] {
    const n = WIND_RES;
    const cell = (2 * this.box.half) / n;
    const buffer = new Float32Array(n * n);
    const samples: AnalysisSample[] = [];
    this.windSolvers.forEach((solver, band) => {
      const ratios = solver.speedRatio(buffer);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = j * n + i;
          if (solver.solid[k]) continue;
          samples.push({ x: this.box.x - this.box.half + (i + 0.5) * cell, y: this.box.z + this.box.half - (j + 0.5) * cell, z: this.windHeights[band]!, value: ratios[k]! * freeStream });
        }
      }
    });
    return samples;
  }

  /** The model changed: depth and height maps are stale. */
  invalidate(): void {
    this.dirty = true;
  }

  render(camera: THREE.Camera, style: ViewStyle = 'shaded'): void {
    const { renderer, scene } = this.host;
    if (!this.spec) {
      renderer.render(scene, camera);
      return;
    }
    if (this.dirty) {
      this.dirty = false;
      this.prepare();
    }
    if (this.spec.kind === 'wind') this.advanceWind();
    const compact = this.host.container.clientWidth < 420 ? 'scale(0.7)' : '';
    if (this.legend.style.transform !== compact) {
      this.legend.style.transform = compact;
      this.legend.style.transformOrigin = '0 0';
    }
    renderer.render(scene, camera);
    if (!this.contentMaterial) return;
    // Keep the portal's graphic style while presenting the same computed values.
    this.contentMaterial.polygonOffsetFactor = style === 'hidden-line' ? 1 : -1;
    this.contentMaterial.polygonOffsetUnits = style === 'hidden-line' ? 1 : -1;
    this.contentMaterial.wireframe = style === 'wireframe';
    this.contentMaterial.transparent = style === 'realistic';
    this.contentMaterial.depthWrite = style !== 'realistic';
    this.contentMaterial.uniforms['uShading']!.value = style === 'consistent' || style === 'hidden-line' || style === 'wireframe' ? 0 : 1;
    this.contentMaterial.uniforms['uOpacity']!.value = style === 'realistic' ? 0.6 : 1;
    const hidden = this.hideFor([...this.host.helpers(), this.extras, ...this.lines]);
    const background = scene.background;
    const autoClear = renderer.autoClear;
    scene.background = null;
    scene.overrideMaterial = this.contentMaterial;
    renderer.autoClear = false;
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    this.restore(hidden);
    if (style === 'hidden-line' || style === 'wireframe') {
      for (const line of this.lines) if (line.visible && line.parent?.visible) renderer.render(line, camera);
    }
    renderer.autoClear = autoClear;
    scene.background = background;
  }

  dispose(): void {
    this.teardown();
    this.host.scene.remove(this.extras);
    this.depthMaterial.dispose();
    this.heightMaterial?.dispose();
    this.legend.remove();
  }

  // ---- setup ------------------------------------------------------------------------------------

  private hideFor(objects: THREE.Object3D[]): THREE.Object3D[] {
    const hidden: THREE.Object3D[] = [];
    for (const object of objects) {
      if (!object.visible) continue;
      object.visible = false;
      hidden.push(object);
    }
    return hidden;
  }

  private restore(hidden: THREE.Object3D[]): void {
    for (const object of hidden) object.visible = true;
  }

  private teardown(): void {
    for (const child of [...this.extras.children]) {
      this.extras.remove(child);
      child.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          if (o.material !== this.groundMaterial) (o.material as THREE.Material).dispose();
        }
      });
    }
    this.contentMaterial?.dispose();
    this.groundMaterial?.dispose();
    this.atlas?.dispose();
    this.height?.dispose();
    this.speedTexture?.dispose();
    this.contentMaterial = this.groundMaterial = null;
    this.atlas = this.height = null;
    this.ground = null;
    this.solver = null;
    this.windSolvers = [];
    this.particles = null;
    this.particleState = null;
    this.speedTexture = null;
    this.speedBuffer = null;
  }

  private prepare(): void {
    const spec = this.spec;
    if (!spec) return;
    // Keep materials and extras across model edits; only re-derive the maps.
    let bounds = new THREE.Box3().setFromObject(this.host.content);
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-5000, 0, -5000), new THREE.Vector3(5000, 3000, 5000));
    // Analyse the project, not everything loaded: with 1:1 maps the scene also holds hundreds of
    // metres of generated context (and sometimes stray far-away items), which would stretch every
    // map over it and cost the project its shadow detail.
    const focus = this.host.focus?.();
    if (focus) {
      const r = Math.max(focus.radius, 5000);
      bounds = new THREE.Box3(new THREE.Vector3(focus.centre.x - r, Math.min(bounds.min.y, 0), focus.centre.z - r), new THREE.Vector3(focus.centre.x + r, bounds.max.y, focus.centre.z + r));
    }
    const size = bounds.getSize(new THREE.Vector3());
    const centre = bounds.getCenter(new THREE.Vector3());
    this.lines = [];
    this.host.content.traverse((o) => {
      if (isLineLike(o)) this.lines.push(o);
    });
    const reach = Math.max(size.x, size.z, 10_000);
    // `reach` is the full width: sun studies cover it with a margin (their shadow views reach a bit
    // further for casters); wind and noise keep a wider field around the model.
    this.box = { x: centre.x, z: centre.z, half: reach * (spec.kind === 'wind' ? 1.6 : spec.kind === 'sun' ? 0.8 : 1.1), top: Math.max(bounds.max.y, 1000) * 1.02 };
    const light = new THREE.Vector3(0.4, 0.8, 0.3).normalize();

    if (!this.contentMaterial) {
      const defines: Record<string, string> =
        spec.kind === 'sun' ? { SUN: '', [spec.display === 'sun-hours' ? 'SUN_HOURS' : 'SUN_SHADOWS']: '' } : spec.kind === 'noise' ? { NOISE: '' } : { WIND: '' };
      const uniforms: Record<string, THREE.IUniform> = {
        uLight: { value: light },
        uGround: { value: 0 },
        uShading: { value: 1 },
        uOpacity: { value: 1 },
        uAtlas: { value: null },
        uLightMatrices: { value: Array.from({ length: MAX_SUN }, () => new THREE.Matrix4()) },
        uSunDirs: { value: Array.from({ length: MAX_SUN }, () => new THREE.Vector3(0, 1, 0)) },
        uHours: { value: new Array<number>(MAX_SUN).fill(0) },
        uCount: { value: 0 },
        uGrid: { value: 1 },
        uMaxHours: { value: 1 },
        uOffset: { value: 60 },
        uDepthBias: { value: 0.0008 },
        uEmitters: { value: Array.from({ length: MAX_EMITTERS }, () => new THREE.Vector4()) },
        uEmitterCount: { value: 0 },
        uMin: { value: 35 },
        uMax: { value: 85 },
        uBarrier: { value: 15 },
        uReceiver: { value: 1500 },
        uHeight: { value: null },
        uBox: { value: new THREE.Vector4() },
        uTexel: { value: 100 },
        uSpeed: { value: null },
        uWindHeights: { value: new THREE.Vector4() },
      };
      this.contentMaterial = new THREE.ShaderMaterial({ defines, uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, side: THREE.DoubleSide, clipping: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthFunc: THREE.LessEqualDepth });
      this.groundMaterial = this.contentMaterial.clone();
      // Clones copy uniform values; share the big ones and flag the receiver plane.
      for (const [name, uniform] of Object.entries(this.contentMaterial.uniforms)) if (name !== 'uGround') this.groundMaterial.uniforms[name] = uniform;
      this.groundMaterial.uniforms['uGround'] = { value: 1 };
      this.groundMaterial.clipping = true;
    }
    const uniforms = this.contentMaterial.uniforms;
    uniforms['uBox']!.value.set(this.box.x, this.box.z, this.box.half, this.box.top);
    uniforms['uTexel']!.value = (2 * this.box.half) / HEIGHT_RES;

    if (!this.ground) {
      this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.groundMaterial!);
      this.ground.renderOrder = -1;
      this.extras.add(this.ground);
    }
    this.ground.scale.set(this.box.half * 2, 1, this.box.half * 2);
    this.ground.position.set(this.box.x, 2, this.box.z);

    if (spec.kind === 'sun') this.prepareSun(spec);
    else if (spec.kind === 'noise') this.prepareNoise(spec);
    else this.prepareWind(spec);
  }

  private withDepthPass<T>(run: () => T): T {
    const { renderer, scene } = this.host;
    const hidden = this.hideFor([...this.host.helpers(), this.extras, ...this.lines]);
    const background = scene.background;
    const clipping = renderer.clippingPlanes;
    const target = renderer.getRenderTarget();
    scene.background = null;
    renderer.clippingPlanes = [];
    try {
      return run();
    } finally {
      scene.overrideMaterial = null;
      scene.background = background;
      renderer.clippingPlanes = clipping;
      renderer.setRenderTarget(target);
      this.restore(hidden);
    }
  }

  private prepareSun(spec: Extract<AnalysisSpec, { kind: 'sun' }>): void {
    const { renderer, scene } = this.host;
    const dirs = spec.display === 'sun-hours' ? spec.samples.slice(0, MAX_SUN) : spec.current ? [{ dir: spec.current, hours: 1 }] : [];
    const uniforms = this.contentMaterial!.uniforms;
    uniforms['uCount']!.value = dirs.length;
    uniforms['uMaxHours']!.value = Math.max(0.001, dirs.reduce((sum, d) => sum + d.hours, 0));
    const hours = uniforms['uHours']!.value as number[];
    dirs.forEach((d, i) => (hours[i] = d.hours));
    const total = dirs.reduce((sum, d) => sum + d.hours, 0);
    this.setLegend(
      spec.title,
      spec.display === 'sun-hours' ? ['0 h', `${(total / 2).toFixed(1)} h`, `${total.toFixed(1)} h`] : spec.current ? ['shadow', '', 'direct sun'] : ['sun below the horizon'],
      spec.display === 'sun-hours',
    );
    if (dirs.length === 0) return;
    const grid = Math.ceil(Math.sqrt(dirs.length));
    // Bigger atlas where the GPU is roomy (desktop); tablets and phones keep 4096.
    const roomy = renderer.capabilities.maxTextureSize >= 8192 && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    const maxSize = Math.min(roomy ? 6144 : 4096, renderer.capabilities.maxTextureSize);
    const tile = Math.min(2048, Math.floor(maxSize / grid));
    this.atlas?.dispose();
    this.atlas = new THREE.WebGLRenderTarget(tile * grid, tile * grid, { depthBuffer: true });
    this.atlas.depthTexture = new THREE.DepthTexture(tile * grid, tile * grid);
    this.atlas.depthTexture.type = THREE.UnsignedIntType;
    uniforms['uAtlas']!.value = this.atlas.depthTexture;
    uniforms['uGrid']!.value = grid;
    // Shadow receivers: the analysis box. Casters just outside it (neighbouring context) still
    // shade it, so the volume each sun view covers reaches a little further out.
    const top = Math.max(this.box.top, 3000);
    const margin = Math.min(top * 2, 60_000);
    const reach = this.box.half + margin;
    const corners: THREE.Vector3[] = [];
    for (const x of [-reach, reach]) for (const z of [-reach, reach]) for (const y of [0, top]) corners.push(new THREE.Vector3(this.box.x + x, y, this.box.z + z));
    const ground = new THREE.Vector3(this.box.x, 0, this.box.z);
    const distance = reach * 3 + top;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, distance * 2);
    const matrices = uniforms['uLightMatrices']!.value as THREE.Matrix4[];
    const sunDirs = uniforms['uSunDirs']!.value as THREE.Vector3[];
    let texel = 0;
    this.withDepthPass(() => {
      scene.overrideMaterial = this.depthMaterial;
      renderer.setRenderTarget(this.atlas);
      dirs.forEach((d, i) => {
        const dir = new THREE.Vector3(...d.dir).normalize();
        sunDirs[i]!.copy(dir);
        camera.position.copy(ground).addScaledVector(dir, distance);
        camera.up.set(0, 1, 0);
        if (Math.abs(dir.y) > 0.999) camera.up.set(0, 0, -1);
        camera.lookAt(ground);
        camera.updateMatrixWorld();
        // Fit each sun's view tightly around the analysed volume as that sun sees it: overhead
        // suns get the whole tile for the site, not a square sized for the worst case.
        const view = camera.matrixWorldInverse;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const corner of corners) {
          const p = corner.clone().applyMatrix4(view);
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
        camera.left = minX; camera.right = maxX; camera.bottom = minY; camera.top = maxY;
        camera.updateProjectionMatrix();
        texel = Math.max(texel, (maxX - minX) / tile, (maxY - minY) / tile);
        matrices[i]!.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const x = (i % grid) * tile;
        const y = Math.floor(i / grid) * tile;
        this.atlas!.viewport.set(x, y, tile, tile);
        this.atlas!.scissor.set(x, y, tile, tile);
        this.atlas!.scissorTest = true;
        // three.js reads a target's viewport/scissor only when it is bound: bind again per tile, or
        // every sun view lands on the whole atlas and each overwrites the last.
        renderer.setRenderTarget(this.atlas);
        renderer.render(scene, camera);
      });
    });
    // Biases in real units from the shadow texel size (they used to grow with the whole scene and
    // could hide a low building's shadow entirely): nudge along the normal by about a texel and
    // allow a texel of depth difference.
    uniforms['uOffset']!.value = Math.min(300, Math.max(15, texel * 1.5));
    uniforms['uDepthBias']!.value = (texel * 2 + 10) / (camera.far - camera.near);
  }

  /** Top-down height map (red = height / box top) over the analysis box. */
  private renderHeight(resolution: number): THREE.WebGLRenderTarget {
    const { renderer, scene } = this.host;
    this.heightMaterial ??= new THREE.ShaderMaterial({
      uniforms: { uTop: { value: 1 } },
      vertexShader: /* glsl */ `varying float vY; void main() { vec4 local = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
        #endif
        vec4 world = modelMatrix * local; vY = world.y; gl_Position = projectionMatrix * viewMatrix * world; }`,
      fragmentShader: /* glsl */ `uniform float uTop; varying float vY; void main() { gl_FragColor = vec4(clamp(vY / uTop, 0.0, 1.0), 0.0, 0.0, 1.0); }`,
      side: THREE.DoubleSide,
    });
    this.heightMaterial.uniforms['uTop']!.value = this.box.top;
    const target = new THREE.WebGLRenderTarget(resolution, resolution, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const h = this.box.half;
    const camera = new THREE.OrthographicCamera(-h, h, h, -h, 1, this.box.top * 2 + 10);
    camera.position.set(this.box.x, this.box.top * 1.5 + 5, this.box.z);
    camera.up.set(0, 0, -1);
    camera.lookAt(this.box.x, 0, this.box.z);
    camera.updateMatrixWorld();
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    this.withDepthPass(() => {
      scene.overrideMaterial = this.heightMaterial;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(scene, camera);
    });
    renderer.setClearColor(clear, alpha);
    return target;
  }

  private prepareNoise(spec: Extract<AnalysisSpec, { kind: 'noise' }>): void {
    const uniforms = this.contentMaterial!.uniforms;
    this.height?.dispose();
    this.height = this.renderHeight(HEIGHT_RES);
    uniforms['uHeight']!.value = this.height.texture;
    const emitters = uniforms['uEmitters']!.value as THREE.Vector4[];
    spec.emitters.slice(0, MAX_EMITTERS).forEach((e, i) => emitters[i]!.set(e.x, e.y, e.z, e.level));
    uniforms['uEmitterCount']!.value = Math.min(MAX_EMITTERS, spec.emitters.length);
    uniforms['uMin']!.value = spec.min;
    uniforms['uMax']!.value = spec.max;
    uniforms['uBarrier']!.value = spec.barrier;
    uniforms['uReceiver']!.value = spec.receiverHeight;
    for (const child of [...this.extras.children]) if (child.name === 'emitter') this.extras.remove(child);
    for (const e of spec.emitters) {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(250, 16, 12), new THREE.MeshBasicMaterial({ color: 0xdc2626 }));
      marker.name = 'emitter';
      marker.userData['emitterId'] = e.id;
      marker.position.set(e.x, e.y, e.z);
      this.extras.add(marker);
    }
    const mid = (spec.min + spec.max) / 2;
    this.setLegend(spec.emitters.length ? spec.title : 'Noise · add emitters to the origin', [`${spec.min} dB`, `${mid} dB`, `${spec.max} dB`], true);
  }

  private prepareWind(spec: Extract<AnalysisSpec, { kind: 'wind' }>): void {
    const { renderer } = this.host;
    const uniforms = this.contentMaterial!.uniforms;
    const target = this.renderHeight(WIND_RES);
    const pixels = new Uint8Array(WIND_RES * WIND_RES * 4);
    renderer.readRenderTargetPixels(target, 0, 0, WIND_RES, WIND_RES, pixels);
    target.dispose();
    const ceiling = Math.max(spec.height + 3000, this.box.top * 1.15);
    this.windHeights = [spec.height, spec.height + (ceiling - spec.height) / 3, spec.height + (ceiling - spec.height) * 2 / 3, ceiling];
    uniforms['uWindHeights']!.value.set(...this.windHeights);
    this.windSolvers = this.windHeights.map((height) => {
      const solid = new Uint8Array(WIND_RES * WIND_RES);
      for (let k = 0; k < solid.length; k++) solid[k] = pixels[k * 4]! / 255 > height / this.box.top ? 1 : 0;
      const solver = new WindSolver(WIND_RES, solid, [spec.flow[0], -spec.flow[1]]);
      for (let i = 0; i < 60; i++) solver.step();
      return solver;
    });
    this.solver = this.windSolvers[0]!;
    this.speedBuffer = new Float32Array(WIND_RES * WIND_RES);
    this.speedTexture?.dispose();
    this.speedTexture = new THREE.DataTexture(new Uint8Array(WIND_RES * WIND_RES * 4 * 4), WIND_RES, WIND_RES * 4, THREE.RGBAFormat);
    this.speedTexture.magFilter = THREE.LinearFilter;
    this.speedTexture.minFilter = THREE.LinearFilter;
    uniforms['uSpeed']!.value = this.speedTexture;
    this.updateSpeedTexture();

    if (!this.particles) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLES * 6), 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(PARTICLES * 6), 3));
      this.particles = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
      this.particles.frustumCulled = false;
      this.extras.add(this.particles);
      this.particleState = new Float32Array(PARTICLES * 3);
      for (let p = 0; p < PARTICLES; p++) this.respawn(p);
    }
    this.setLegend(spec.title, ['calm', 'free stream', '1.5× faster'], true, 'Relative speed around the building at four heights. Surface colours sample nearby flow. Qualitative stacked 2D flow, not a full 3D CFD simulation.');
  }

  private respawn(p: number): void {
    const state = this.particleState!;
    const n = WIND_RES;
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 10; tries++) {
      x = 1 + Math.random() * (n - 3);
      y = 1 + Math.random() * (n - 3);
      if (!this.windSolvers[p % 4]?.isSolid(x, y)) break;
    }
    state[p * 3] = x;
    state[p * 3 + 1] = y;
    state[p * 3 + 2] = Math.random() * 120;
  }

  private updateSpeedTexture(): void {
    if (!this.solver || !this.speedTexture || !this.speedBuffer) return;
    const data = this.speedTexture.image.data as Uint8Array;
    this.windSolvers.forEach((solver, band) => {
      const speeds = solver.speedRatio(this.speedBuffer!);
      for (let k = 0; k < speeds.length; k++) {
        const [r, g, b] = solver.solid[k] ? [0.55, 0.56, 0.6] : ramp(speeds[k]! / 1.5);
        const offset = (band * WIND_RES * WIND_RES + k) * 4;
        data[offset] = r * 255; data[offset + 1] = g * 255; data[offset + 2] = b * 255; data[offset + 3] = 255;
      }
    });
    this.speedTexture.needsUpdate = true;
  }

  private advanceWind(): void {
    const spec = this.spec;
    if (!this.solver || !this.particles || !this.particleState || spec?.kind !== 'wind') return;
    for (const solver of this.windSolvers) solver.step();
    this.frameCount += 1;
    if (this.frameCount % 6 === 0) this.updateSpeedTexture();
    const n = WIND_RES;
    const cell = (2 * this.box.half) / n;
    const state = this.particleState;
    const positions = this.particles.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colours = this.particles.geometry.getAttribute('color') as THREE.BufferAttribute;

    const pace = 0.35 * Math.max(0.1, Math.min(3, spec.speed / 5));
    for (let p = 0; p < PARTICLES; p++) {
      let x = state[p * 3]!;
      let j = state[p * 3 + 1]!;
      const solver = this.windSolvers[p % 4]!;
      const y = this.windHeights[p % 4]!;
      const [u, v] = solver.sample(x, j);
      x += u * pace;
      j += v * pace;
      state[p * 3 + 2] = state[p * 3 + 2]! - 1;
      if (state[p * 3 + 2]! <= 0 || x < 0 || j < 0 || x > n - 1 || j > n - 1 || solver.isSolid(x, j)) {
        this.respawn(p);
        x = state[p * 3]!;
        j = state[p * 3 + 1]!;
      } else {
        state[p * 3] = x;
        state[p * 3 + 1] = j;
      }
      const speed = Math.hypot(u, v);
      const tail = 2.2;
      const wx = this.box.x - this.box.half + (x + 0.5) * cell;
      const wz = this.box.z + this.box.half - (j + 0.5) * cell;
      positions.setXYZ(p * 2, wx, y, wz);
      positions.setXYZ(p * 2 + 1, wx - u * tail * cell, y, wz + v * tail * cell);
      const [r, g, b] = ramp(speed / 1.5);
      colours.setXYZ(p * 2, r, g, b);
      colours.setXYZ(p * 2 + 1, r * 0.4 + 0.6, g * 0.4 + 0.6, b * 0.4 + 0.6);
    }
    positions.needsUpdate = true;
    colours.needsUpdate = true;
  }

  private setLegend(title: string, labels: string[], gradient: boolean, note?: string): void {
    const stops = STOPS.map((c, i) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')}) ${i * 25}%`).join(', ');
    const bar = gradient ? `<div style="height:8px;border-radius:4px;margin:4px 0 2px;background:linear-gradient(90deg, ${stops})"></div>` : '<div style="height:8px;border-radius:4px;margin:4px 0 2px;background:linear-gradient(90deg,#3d3f47,#f2f0e8)"></div>';
    const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    this.legend.innerHTML = `<div style="font-weight:600">${escape(title)}</div>${bar}<div style="display:flex;justify-content:space-between;gap:12px;color:#57606a">${labels.map((l) => `<span>${escape(l)}</span>`).join('')}</div>${note ? `<div style="margin-top:3px;color:#6e7781">${escape(note)}</div>` : ''}`;
  }
}
