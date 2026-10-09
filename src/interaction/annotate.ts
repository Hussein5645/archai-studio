/** Pointer helpers of the board annotation tools (see src/annotations and useInteractions). */
import { isEffectivelyLocked, isEffectivelyVisible, type ArchaiDocument } from '@/document';
import { applyToPoint, linePoints, worldMatrix, type Vec2 } from '@/geometry';
import { annotationOf, distanceToPolyline } from '@/annotations/model';

export interface InkCandidate {
  id: string;
  /** World points of the stroke. */
  points: Vec2[];
  /** Half the stroke width, world mm. */
  reach: number;
}

/** Visible, unlocked ink strokes the eraser can wipe. */
export function inkCandidates(doc: ArchaiDocument): InkCandidate[] {
  const out: InkCandidate[] = [];
  for (const element of Object.values(doc.elements)) {
    if (element.kind !== 'line' || annotationOf(element)?.kind !== 'ink') continue;
    if (!isEffectivelyVisible(doc.elements, element.id) || isEffectivelyLocked(doc.elements, element.id)) continue;
    const matrix = worldMatrix(doc.elements, element);
    const scale = Math.hypot(matrix[0], matrix[1]);
    out.push({ id: element.id, points: linePoints(element).map(([x, y]) => applyToPoint(matrix, { x, y })), reach: (element.style.strokeWidth * scale) / 2 });
  }
  return out;
}

/** Strokes within `radius` of the segment a..b (the eraser's path since the last move). */
export function inkUnder(candidates: readonly InkCandidate[], a: Vec2, b: Vec2, radius: number): string[] {
  const hits: string[] = [];
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(radius, 1e-6)));
  for (const candidate of candidates) {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (distanceToPolyline(p, candidate.points) <= radius + candidate.reach) {
        hits.push(candidate.id);
        break;
      }
    }
  }
  return hits;
}

/** Pen pressure of a pointer sample, or null when the device does not report real pressure. */
export function penPressure(event: { pointerType: string; pressure: number }): number | null {
  return event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : null;
}

/** Fades (or restores) erased strokes on screen while the eraser gesture is still going. */
export function fadeOnBoard(container: HTMLElement | null, ids: Iterable<string>, faded: boolean): void {
  if (!container) return;
  for (const id of ids) {
    for (const node of container.querySelectorAll<SVGGElement>(`[data-element-id="${CSS.escape(id)}"]`)) node.style.opacity = faded ? '0.2' : '';
  }
}
