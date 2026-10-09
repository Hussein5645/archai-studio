export type Point3 = [number, number, number];

export type InferenceType =
  | 'grid'
  | 'work-plane-origin'
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'quadrant'
  | 'point-on-edge'
  | 'point-on-face'
  | 'edge-intersection'
  | 'face-intersection'
  | 'axis'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'extension'
  | 'alignment'
  | 'body-vertex'
  | 'body-edge'
  | 'body-face'
  | 'reference-plane'
  | 'guide-point'
  | 'guide-line';

export interface InferenceCandidate {
  position: Point3;
  type: InferenceType;
  source?: unknown;
  screenDistance: number;
  priority?: number;
  direction?: Point3;
  plane?: { origin: Point3; normal: Point3 };
  label: string;
  marker: 'square' | 'circle' | 'diamond' | 'triangle' | 'cross' | 'line';
  guides?: { from: Point3; to: Point3; dotted?: boolean }[];
  visible?: boolean;
  occluded?: boolean;
  selected?: boolean;
}

export interface InferenceSettings {
  enabled: boolean;
  geometry: boolean;
  inference: boolean;
  grid: boolean;
  guides: boolean;
  workPlane: boolean;
  tolerance: number;
  xray: boolean;
  disabledTypes: Partial<Record<InferenceType, boolean>>;
}

export const DEFAULT_INFERENCE_SETTINGS: InferenceSettings = {
  enabled: true,
  geometry: true,
  inference: true,
  grid: true,
  guides: true,
  workPlane: true,
  tolerance: 10,
  xray: false,
  disabledTypes: {},
};

const PRIORITY: Record<InferenceType, number> = {
  endpoint: 120, 'body-vertex': 118, 'edge-intersection': 116, 'face-intersection': 114,
  midpoint: 108, center: 106, quadrant: 104, 'guide-point': 102, 'work-plane-origin': 100,
  'point-on-edge': 92, 'body-edge': 90, 'point-on-face': 82, 'body-face': 80,
  tangent: 76, perpendicular: 74, parallel: 72, extension: 70, alignment: 68, axis: 66,
  'guide-line': 62, 'reference-plane': 58, grid: 40,
};

const GEOMETRY = new Set<InferenceType>(['endpoint', 'midpoint', 'center', 'quadrant', 'point-on-edge', 'point-on-face', 'edge-intersection', 'face-intersection', 'body-vertex', 'body-edge', 'body-face']);
const INFERRED = new Set<InferenceType>(['axis', 'parallel', 'perpendicular', 'tangent', 'extension', 'alignment']);
const GUIDES = new Set<InferenceType>(['guide-point', 'guide-line']);

export interface ResolveContext {
  tool?: string;
  xray?: boolean;
}

/** Shared candidate filtering, ranking, cycling, and inference locking. */
export class InferenceEngine {
  private candidates: InferenceCandidate[] = [];
  private cycleIndex = 0;
  private locked: InferenceCandidate | null = null;

  constructor(public settings: InferenceSettings = { ...DEFAULT_INFERENCE_SETTINGS, disabledTypes: {} }) {}

  resolve(input: readonly InferenceCandidate[], context: ResolveContext = {}): InferenceCandidate | null {
    if (!this.settings.enabled) return null;
    this.candidates = input
      .filter((candidate) => this.allowed(candidate, context))
      .sort((a, b) => this.score(b, context) - this.score(a, context));
    this.cycleIndex = Math.min(this.cycleIndex, Math.max(0, this.candidates.length - 1));
    if (this.locked) return this.locked;
    return this.candidates[this.cycleIndex] ?? null;
  }

  cycle(): InferenceCandidate | null {
    if (!this.candidates.length) return null;
    this.cycleIndex = (this.cycleIndex + 1) % this.candidates.length;
    return this.candidates[this.cycleIndex]!;
  }

  lock(candidate: InferenceCandidate | null = this.candidates[this.cycleIndex] ?? null): InferenceCandidate | null {
    this.locked = candidate;
    return this.locked;
  }

  clearLock(): void {
    this.locked = null;
    this.cycleIndex = 0;
  }

  get currentLock(): InferenceCandidate | null {
    return this.locked;
  }

  private allowed(candidate: InferenceCandidate, context: ResolveContext): boolean {
    const settings = this.settings;
    if (settings.disabledTypes[candidate.type] || candidate.visible === false) return false;
    if (candidate.occluded && !(context.xray ?? settings.xray)) return false;
    if (candidate.screenDistance > settings.tolerance) return false;
    if (GEOMETRY.has(candidate.type) && !settings.geometry) return false;
    if (INFERRED.has(candidate.type) && !settings.inference) return false;
    if (GUIDES.has(candidate.type) && !settings.guides) return false;
    if (candidate.type === 'grid' && !settings.grid) return false;
    if ((candidate.type === 'work-plane-origin' || candidate.type === 'reference-plane') && !settings.workPlane) return false;
    return true;
  }

  private score(candidate: InferenceCandidate, context: ResolveContext): number {
    const selected = candidate.selected ? 24 : 0;
    const toolBonus = context.tool === 'pushpull' && (candidate.type === 'body-face' || candidate.type === 'point-on-face') ? 18 : 0;
    const distance = (candidate.screenDistance / Math.max(1, this.settings.tolerance)) * 35;
    return PRIORITY[candidate.type] + (candidate.priority ?? 0) + selected + toolBonus - distance;
  }
}

export function projectToDirection(point: Point3, origin: Point3, direction: Point3): Point3 {
  const length = Math.hypot(...direction);
  if (length < 1e-9) return [...origin];
  const unit: Point3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  const amount = (point[0] - origin[0]) * unit[0] + (point[1] - origin[1]) * unit[1] + (point[2] - origin[2]) * unit[2];
  return [origin[0] + unit[0] * amount, origin[1] + unit[1] * amount, origin[2] + unit[2] * amount];
}
