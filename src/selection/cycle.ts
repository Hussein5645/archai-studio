/**
 * Tab selection cycling (Revit): with the cursor over overlapping elements, Tab steps through
 * everything under it, front to back, and a click selects the highlighted candidate. A wall or
 * line that connects end to end with others also offers the whole chain.
 */
import { archTypeOf } from '@/assets/arch-meta';
import type { ArchaiDocument, Element, ElementTable } from '@/document';
import { applyToPoint, hitTestAll, linePoints, worldMatrix, type Vec2 } from '@/geometry';
import { selectableTarget } from './index';

export interface CycleCandidate {
  ids: string[];
  label: string;
}

function title(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1).replace(/-/g, ' ') : text;
}

export function describeElement(element: Element): string {
  if (element.name) return element.name;
  const type = archTypeOf(element);
  if (type) return title(type);
  if (element.meta?.['annotation']) return 'Annotation';
  if (element.meta?.['diagram']) return 'Diagram';
  return title(element.kind);
}

/** What kind of chain a line belongs to: walls join walls, plain lines join plain lines. */
function chainClass(element: Element): string | null {
  if (element.kind !== 'line' || element.closed) return null;
  if (element.meta?.['annotation'] || element.meta?.['diagram'] || element.meta?.['sectionLine'] || element.meta?.['cameraMarker'] || element.meta?.['measure']) return null;
  const type = archTypeOf(element);
  if (type === 'wall' || type === 'curtain-wall' || type === 'railing') return type;
  return type ? null : 'line';
}

function ends(elements: ElementTable, element: Element): [Vec2, Vec2] | null {
  if (element.kind !== 'line') return null;
  const points = linePoints(element);
  if (points.length < 2) return null;
  const m = worldMatrix(elements, element);
  const [a, b] = [points[0]!, points.at(-1)!];
  return [applyToPoint(m, { x: a[0], y: a[1] }), applyToPoint(m, { x: b[0], y: b[1] })];
}

/** Lines of the same class connected end to end with `start`, `start` first. */
export function lineChain(elements: ElementTable, start: Element, tolerance: number): string[] {
  const kind = chainClass(start);
  if (!kind) return [start.id];
  const pool = Object.values(elements).filter((element) => element.visible && element.parentId === start.parentId && chainClass(element) === kind);
  const endsOf = new Map(pool.map((element) => [element.id, ends(elements, element)] as const));
  const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= tolerance;
  const chain = [start.id];
  const seen = new Set(chain);
  for (let i = 0; i < chain.length; i++) {
    const own = endsOf.get(chain[i]!);
    if (!own) continue;
    for (const other of pool) {
      if (seen.has(other.id)) continue;
      const theirs = endsOf.get(other.id);
      if (!theirs || !own.some((p) => theirs.some((q) => near(p, q)))) continue;
      seen.add(other.id);
      chain.push(other.id);
    }
  }
  return chain;
}

/** Everything Tab can step through at `point`, front-most first. */
export function cycleCandidates(doc: ArchaiDocument, point: Vec2, tolerance: number, scopeId: string | null = null): CycleCandidate[] {
  const out: CycleCandidate[] = [];
  const keys = new Set<string>();
  const push = (ids: string[], label: string) => {
    const key = [...ids].sort().join('|');
    if (keys.has(key)) return;
    keys.add(key);
    out.push({ ids, label });
  };
  for (const hit of hitTestAll(doc, point, { tolerance, includeLocked: true, scopeId })) {
    const target = selectableTarget(doc.elements, hit, false, scopeId);
    push([target.id], describeElement(target));
    // Inside a group: the element itself too (Revit's Tab into a group).
    if (target.id !== hit.id) push([hit.id], describeElement(hit));
    const chain = lineChain(doc.elements, hit, Math.max(tolerance, 10));
    if (chain.length > 1) push(chain, `Chain of ${chain.length} ${chainClass(hit) === 'line' ? 'lines' : `${title(chainClass(hit)!).toLowerCase()}s`}`);
  }
  return out;
}
