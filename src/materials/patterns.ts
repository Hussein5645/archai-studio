/**
 * Procedural material patterns (brick, tiles, planks, stone, stripes): one seamless period of
 * the pattern rendered to RGBA pixel buffers (albedo, normal and roughness), plus the period's
 * real size in millimetres so a texture maps at true scale. Pure (no canvas), so it is tested in
 * node and rendered to canvases by ./three.ts.
 *
 * Every pattern is a cell function: for a point (u, v) in mm inside the period it returns which
 * unit (brick / tile / plank / stone) the point belongs to and how far it is from that unit's
 * edge. Unit ids are taken from the unit's position wrapped into the period, so units crossing
 * the period's border get the same colour on both sides and the texture tiles without seams.
 */
import type { MaterialPattern } from '@/document';

export interface PatternImage {
  width: number;
  height: number;
  /** Real size of the period, mm. */
  periodU: number;
  periodV: number;
  albedo: Uint8ClampedArray;
  normal: Uint8ClampedArray;
  roughness: Uint8ClampedArray;
}

interface Cell {
  /** Unit identity (stable across the period's borders). */
  id: number;
  /** Distance to the unit's edge, mm (Infinity for patterns without joints). */
  edge: number;
  /** Position inside the unit along its length, mm (grain). */
  along: number;
  /** Whether the unit runs along v (herringbone verticals, rotated grain). */
  turned?: boolean;
}

/** Integer hash → [0, 1). */
function hash(a: number, b: number, seed: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Tileable value noise: `cells` lattice cells across each period. */
function noise(u: number, v: number, cellsU: number, cellsV: number, seed: number): number {
  const x = u * cellsU;
  const y = v * cellsV;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (i: number, j: number) => hash(mod(i, cellsU), mod(j, cellsV), seed);
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** Fractal value noise on the unit square (u, v in [0, 1)), seamless. */
function fbm(u: number, v: number, base: number, seed: number, aspect = 1): number {
  let total = 0;
  let amplitude = 0.5;
  let frequency = base;
  for (let octave = 0; octave < 4; octave++) {
    total += noise(u, v, Math.max(1, Math.round(frequency * aspect)), Math.max(1, Math.round(frequency)), seed + octave * 101) * amplitude;
    amplitude /= 2;
    frequency *= 2;
  }
  return total / 0.9375;
}

interface Layout {
  periodU: number;
  periodV: number;
  cell: (u: number, v: number) => Cell;
}

/** Rows of units (bricks, tiles, planks): each row is a run of unit lengths, shifted per row. */
function rowLayout(p: MaterialPattern, rows: number, unitsPerRow: number, lengths: (row: number) => number[], shift: (row: number, periodU: number) => number): Layout {
  const rowHeight = p.unitHeight + p.joint;
  const first = lengths(0);
  const runLength = first.reduce((sum, length) => sum + length, 0);
  const periodU = runLength * unitsPerRow;
  const periodV = rowHeight * rows;
  return {
    periodU,
    periodV,
    cell: (u, v) => {
      const row = Math.min(rows - 1, Math.floor(v / rowHeight));
      const inRow = v - row * rowHeight;
      const run = lengths(row);
      const offset = shift(row, periodU);
      let x = mod(u + offset, periodU);
      let index = 0;
      let start = 0;
      // Walk the repeating run of lengths to the unit containing x.
      for (;;) {
        const length = run[index % run.length]!;
        if (x < start + length || start + length >= periodU) break;
        start += length;
        index++;
      }
      const length = run[index % run.length]!;
      x -= start;
      // Joints sit at the end of each unit and at the top of each row.
      const edgeU = Math.min(x, length - p.joint - x);
      const edgeV = Math.min(inRow, p.unitHeight - inRow);
      const inJoint = x > length - p.joint || inRow > p.unitHeight;
      const unitStart = mod(start - offset, periodU);
      return { id: row * 1009 + Math.round(unitStart), edge: inJoint ? -1 : Math.min(edgeU, edgeV), along: x };
    },
  };
}

function herringbone(p: MaterialPattern): Layout {
  const cellSize = p.unitHeight + p.joint;
  const k = Math.max(2, Math.round((p.unitWidth + p.joint) / cellSize));
  const period = 2 * k * cellSize;
  return {
    periodU: period,
    periodV: period,
    cell: (u, v) => {
      const xu = u / cellSize;
      const yu = v / cellSize;
      const a = Math.floor(xu);
      const b = Math.floor(yu);
      const shift = Math.floor((a - b + k) / (2 * k));
      const m = a - b - shift * 2 * k;
      const fx = xu - a;
      const fy = yu - b;
      // Units (cells): horizontal bricks k × 1 starting on the diagonal, verticals 1 × k below them.
      let localX: number;
      let localY: number;
      let lengthX: number;
      let lengthY: number;
      let originX: number;
      let originY: number;
      let turned = false;
      if (m >= 0) {
        localX = m + fx;
        localY = fy;
        lengthX = k;
        lengthY = 1;
        originX = a - m;
        originY = b;
      } else {
        const n = a - 2 * k * shift;
        localX = fx;
        localY = b - n - 1 + fy;
        lengthX = 1;
        lengthY = k;
        originX = a;
        originY = n + 1;
        turned = true;
      }
      const joint = p.joint / cellSize;
      const inJoint = localX > lengthX - joint || localY > lengthY - joint;
      const edge = Math.min(localX, lengthX - joint - localX, localY, lengthY - joint - localY) * cellSize;
      const id = mod(originX, 2 * k) * 97 + mod(originY, 2 * k) + (turned ? 50_000 : 0);
      return { id, edge: inJoint ? -1 : edge, along: (turned ? localY : localX) * cellSize, turned };
    },
  };
}

/** Nearest-centre cells (stone, hexagons): the edge is half the gap between the two nearest centres. */
function voronoi(periodU: number, periodV: number, centres: { x: number; y: number; id: number }[], joint: number): Layout {
  return {
    periodU,
    periodV,
    cell: (u, v) => {
      let best = Infinity;
      let second = Infinity;
      let id = 0;
      for (const centre of centres) {
        for (let du = -1; du <= 1; du++) {
          for (let dv = -1; dv <= 1; dv++) {
            const d = Math.hypot(u - (centre.x + du * periodU), v - (centre.y + dv * periodV));
            if (d < best) {
              second = best;
              best = d;
              id = centre.id;
            } else if (d < second) second = d;
          }
        }
      }
      const edge = (second - best) / 2;
      return { id, edge: joint > 0 && edge < joint / 2 ? -1 : edge - joint / 2, along: u };
    },
  };
}

function layoutOf(p: MaterialPattern): Layout {
  const L = p.unitWidth + p.joint;
  switch (p.kind) {
    case 'brick': {
      if (p.layout === 'herringbone') return herringbone(p);
      if (p.layout === 'flemish') {
        const header = (p.unitWidth - p.joint) / 2 + p.joint;
        return rowLayout(p, 8, 4, () => [L, header], (row, periodU) => (row % 2) * ((L + header) / 2) + (row % 4 >= 2 ? periodU / 8 : 0));
      }
      const stack = p.layout === 'stack';
      return rowLayout(p, 8, 4, () => [L], (row) => (stack ? 0 : (row % 2) * (L / 2)));
    }
    case 'tiles': {
      if (p.layout === 'hexagon') {
        // Pointy-top hexagons, `unitWidth` across the flats.
        const w = p.unitWidth;
        const rowStep = (w * Math.sqrt(3)) / 2;
        const centres: { x: number; y: number; id: number }[] = [];
        for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) centres.push({ x: col * w + (row % 2) * (w / 2), y: row * rowStep, id: row * 2 + col });
        return voronoi(2 * w, 2 * rowStep, centres, p.joint);
      }
      const offset = p.layout === 'offset';
      const rows = Math.max(2, Math.ceil(600 / (p.unitHeight + p.joint)));
      return rowLayout(p, rows - (rows % 2), Math.max(2, Math.ceil(600 / L)), () => [L], (row) => (offset ? (row % 2) * (L / 2) : 0));
    }
    case 'planks': {
      const rows = Math.max(2, Math.min(16, Math.ceil(1200 / (p.unitHeight + p.joint))));
      if (p.layout === 'offset') return rowLayout(p, rows - (rows % 3) || 3, 2, () => [L], (row) => (row % 3) * (L / 3));
      return rowLayout(p, rows, 2, () => [L], (row, periodU) => Math.floor(hash(row, 17, p.seed) * 8) * (periodU / 8));
    }
    case 'stone': {
      const across = Math.max(2, Math.min(24, Math.round(Math.max(600, p.unitWidth * 4) / p.unitWidth)));
      const down = Math.max(2, Math.min(24, Math.round(Math.max(600, p.unitHeight * 4) / p.unitHeight)));
      const centres: { x: number; y: number; id: number }[] = [];
      for (let j = 0; j < down; j++) for (let i = 0; i < across; i++) centres.push({ x: (i + 0.15 + hash(i, j, p.seed) * 0.7) * p.unitWidth, y: (j + 0.15 + hash(j, i, p.seed + 1) * 0.7) * p.unitHeight, id: j * across + i });
      return voronoi(across * p.unitWidth, down * p.unitHeight, centres, p.joint);
    }
    case 'stripes': {
      const count = Math.max(2, Math.ceil(600 / L));
      return {
        periodU: count * L,
        periodV: p.unitHeight,
        cell: (u, v) => {
          const index = Math.floor(u / L);
          const x = u - index * L;
          return { id: index, edge: x > p.unitWidth ? -1 : Math.min(x, p.unitWidth - x), along: v };
        },
      };
    }
  }
}

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1, 7), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Renders one period of a pattern; `maxSize` caps the larger side in pixels. */
export function renderPattern(p: MaterialPattern, baseColor: string, maxSize = 1024): PatternImage {
  const layout = layoutOf(p);
  const { periodU, periodV } = layout;
  // Enough pixels for the joints to read (≥ 3 px), within the size cap.
  const wanted = Math.max(512 / Math.max(periodU, periodV), p.joint > 0 ? 3 / p.joint : 0);
  const scale = Math.min(wanted, maxSize / Math.max(periodU, periodV));
  const width = Math.max(16, Math.round(periodU * scale));
  const height = Math.max(16, Math.round(periodV * scale));
  const albedo = new Uint8ClampedArray(width * height * 4);
  const roughness = new Uint8ClampedArray(width * height * 4);
  const heights = new Float32Array(width * height);
  const base = rgb(baseColor);
  const accent = rgb(p.accent);
  const joint = rgb(p.jointColor);
  const bevel = Math.max(p.joint * 0.6, 1 / scale);
  const grain = p.kind === 'planks' || p.kind === 'stripes';
  // Jointless stone with large cells is a continuous surface (concrete, corten): cloudy, not faceted.
  const cloudy = p.kind === 'stone' && p.joint === 0 && p.unitWidth >= 150;
  for (let y = 0; y < height; y++) {
    const v = ((y + 0.5) / height) * periodV;
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width) * periodU;
      const cell = layout.cell(u, v);
      const i = y * width + x;
      const o = i * 4;
      // Per-unit tone: brightness and a pull towards the accent colour.
      const r1 = hash(cell.id, 1, p.seed);
      const r2 = hash(cell.id, 2, p.seed);
      const tone = 1 + (r1 - 0.5) * p.variation * 0.7;
      const pull = r2 * p.variation * (p.kind === 'stone' && p.joint === 0 ? 1 : 0.45);
      // Surface detail: wood grain streaks along the unit, speckle elsewhere.
      const detail = grain
        ? fbm((cell.turned ? v : u) / (cell.turned ? periodV : periodU), ((cell.turned ? u : v) / (cell.turned ? periodU : periodV) + r1) % 1, 3, p.seed + 7, 0.08)
        : fbm(u / periodU, v / periodV, 6, p.seed + 3, periodU / periodV);
      const shade = (detail - 0.5) * (grain ? 0.35 : 0.18) * (0.4 + p.variation);
      let colour: [number, number, number];
      let h: number;
      let rough: number;
      if (cloudy) {
        const cloud = fbm(u / periodU, v / periodV, 3, p.seed + 11, periodU / periodV);
        const mix = Math.max(0, Math.min(1, (cloud - 0.35) * 1.6)) * p.variation * 1.4;
        colour = [0, 1, 2].map((c) => (base[c]! + (accent[c]! - base[c]!) * mix) * (1 + shade)) as [number, number, number];
        h = 0.5 + shade * 0.5;
        rough = 215 + (detail - 0.5) * 50;
      } else if (cell.edge < 0) {
        colour = joint;
        h = 0;
        rough = 255;
      } else {
        colour = [0, 1, 2].map((c) => (base[c]! + (accent[c]! - base[c]!) * pull) * tone * (1 + shade)) as [number, number, number];
        h = Math.min(1, cell.edge / bevel) * 0.85 + 0.15 + shade * 0.4;
        rough = 205 + (detail - 0.5) * 60;
      }
      albedo[o] = colour[0];
      albedo[o + 1] = colour[1];
      albedo[o + 2] = colour[2];
      albedo[o + 3] = 255;
      roughness[o] = roughness[o + 1] = roughness[o + 2] = rough;
      roughness[o + 3] = 255;
      heights[i] = p.joint > 0 ? h : 0.5 + shade * 0.5;
    }
  }
  // Normals from the height field (wrapping, so the map tiles too).
  const normal = new Uint8ClampedArray(width * height * 4);
  const strength = 2 + p.relief * 10;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (dx: number, dy: number) => heights[mod(y + dy, height) * width + mod(x + dx, width)]!;
      const nx = (at(-1, 0) - at(1, 0)) * strength;
      // Texture v runs up in three.js while rows run down, hence the sign.
      const ny = (at(0, 1) - at(0, -1)) * strength;
      const length = Math.hypot(nx, ny, 1);
      const o = (y * width + x) * 4;
      normal[o] = ((nx / length) * 0.5 + 0.5) * 255;
      normal[o + 1] = ((ny / length) * 0.5 + 0.5) * 255;
      normal[o + 2] = ((1 / length) * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  }
  return { width, height, periodU, periodV, albedo, normal, roughness };
}

/** A stable key for caching a pattern's textures. */
export function patternKey(p: MaterialPattern, baseColor: string): string {
  return JSON.stringify([p, baseColor]);
}
