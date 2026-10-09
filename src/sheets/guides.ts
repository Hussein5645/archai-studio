/**
 * Smart guides for laying out a sheet (Figma / InDesign style): while a view, title block or note
 * is dragged, its edges and centre snap to the paper margins and centre lines and to the edges
 * and centres of the other items, and to equal gaps between neighbours. Pure; world millimetres.
 */
import type { Rect, Vec2 } from '@/geometry';

export interface GuideLine {
  a: Vec2;
  b: Vec2;
}

export interface GuideResult {
  dx: number;
  dy: number;
  guides: GuideLine[];
}

export interface GuideTargets {
  /** Rectangles of the other items on the sheet. */
  items: readonly Rect[];
  /** Extra vertical (x) and horizontal (y) lines: paper margins and centre lines. */
  xs: readonly number[];
  ys: readonly number[];
  /** The paper, for drawing guide lines across it. */
  paper: Rect;
}

const edgesX = (r: Rect) => [r.x, r.x + r.width / 2, r.x + r.width];
const edgesY = (r: Rect) => [r.y, r.y + r.height / 2, r.y + r.height];

/** The paper's margin lines (inset by `margin`) and centre lines. */
export function paperLines(paper: Rect, margin: number): { xs: number[]; ys: number[] } {
  return {
    xs: [paper.x + margin, paper.x + paper.width / 2, paper.x + paper.width - margin],
    ys: [paper.y + margin, paper.y + paper.height / 2, paper.y + paper.height - margin],
  };
}

/** Snaps one axis: the smallest correction bringing any moving edge onto any target line. */
function snapAxis(moving: number[], targets: number[], tolerance: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const m of moving) {
    for (const t of targets) {
      const d = t - m;
      if (Math.abs(d) <= tolerance && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t };
    }
  }
  return best;
}

/**
 * Equal spacing along x: when the moving item sits between two neighbours in the same band,
 * centre it so both gaps match; beside one neighbour, repeat a gap already used between others.
 */
function equalGapX(moving: Rect, items: readonly Rect[], tolerance: number): { delta: number; guides: GuideLine[] } | null {
  const band = items.filter((r) => r.y < moving.y + moving.height && r.y + r.height > moving.y);
  const left = band.filter((r) => r.x + r.width <= moving.x + tolerance).sort((p, q) => q.x + q.width - (p.x + p.width))[0];
  const right = band.filter((r) => r.x >= moving.x + moving.width - tolerance).sort((p, q) => p.x - q.x)[0];
  if (left && right) {
    const space = right.x - (left.x + left.width) - moving.width;
    const target = left.x + left.width + space / 2;
    const delta = target - moving.x;
    if (Math.abs(delta) <= tolerance && space > 0) {
      const y = moving.y + moving.height / 2;
      return { delta, guides: [{ a: { x: left.x + left.width, y }, b: { x: target, y } }, { a: { x: target + moving.width, y }, b: { x: right.x, y } }] };
    }
  }
  // Gaps between other pairs in the band.
  const sorted = [...band].sort((p, q) => p.x - q.x);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]!.x - (sorted[i - 1]!.x + sorted[i - 1]!.width));
  for (const gap of gaps.filter((g) => g > 0)) {
    if (left) {
      const delta = left.x + left.width + gap - moving.x;
      if (Math.abs(delta) <= tolerance) {
        const y = moving.y + moving.height / 2;
        return { delta, guides: [{ a: { x: left.x + left.width, y }, b: { x: left.x + left.width + gap, y } }] };
      }
    }
    if (right) {
      const delta = right.x - gap - (moving.x + moving.width);
      if (Math.abs(delta) <= tolerance) {
        const y = moving.y + moving.height / 2;
        return { delta, guides: [{ a: { x: right.x - gap, y }, b: { x: right.x, y } }] };
      }
    }
  }
  return null;
}

/** Transposes a rectangle (x ↔ y), so the x-axis equal-gap logic serves the y-axis too. */
const flip = (r: Rect): Rect => ({ x: r.y, y: r.x, width: r.height, height: r.width });

/**
 * The correction to apply to a drag so that `moving` (its bounds after the raw drag) lines up,
 * with the guide lines explaining it.
 */
export function smartGuides(moving: Rect, targets: GuideTargets, tolerance: number): GuideResult {
  const xs = [...targets.xs, ...targets.items.flatMap(edgesX)];
  const ys = [...targets.ys, ...targets.items.flatMap(edgesY)];
  const guides: GuideLine[] = [];
  let dx = 0;
  let dy = 0;
  const sx = snapAxis(edgesX(moving), xs, tolerance);
  if (sx) {
    dx = sx.delta;
    guides.push({ a: { x: sx.at, y: targets.paper.y }, b: { x: sx.at, y: targets.paper.y + targets.paper.height } });
  } else {
    const gap = equalGapX(moving, targets.items, tolerance);
    if (gap) {
      dx = gap.delta;
      guides.push(...gap.guides);
    }
  }
  const sy = snapAxis(edgesY(moving), ys, tolerance);
  if (sy) {
    dy = sy.delta;
    guides.push({ a: { x: targets.paper.x, y: sy.at }, b: { x: targets.paper.x + targets.paper.width, y: sy.at } });
  } else {
    const gap = equalGapX(flip(moving), targets.items.map(flip), tolerance);
    if (gap) {
      dy = gap.delta;
      guides.push(...gap.guides.map((g) => ({ a: { x: g.a.y, y: g.a.x }, b: { x: g.b.y, y: g.b.x } })));
    }
  }
  return { dx, dy, guides };
}
