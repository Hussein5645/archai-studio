/**
 * Picking inside a view frame: a board point on the sheet is mapped into the frame. Plan and
 * board-area frames hit-test the real elements at the matching crop point; 3D / section /
 * camera frames raycast their source view framed as the frame's image.
 */
import type { ArchaiDocument, Element } from '@/document';
import { applyToPoint, hitTest, invert, worldMatrix, type Vec2 } from '@/geometry';
import { mountedViews } from '@/view3d/SceneView';
import { effectiveOverride, frameContentIds, sheetViewOf } from './model';

/**
 * The element under `world` inside frame `frameId`: its id, null inside the frame over nothing,
 * or undefined outside the frame. `tolerance` is in board millimetres on the sheet.
 */
export function pickInFrame(doc: ArchaiDocument, frameId: string, world: Vec2, tolerance: number): string | null | undefined {
  const frame = doc.elements[frameId];
  const view = sheetViewOf(frame);
  if (!frame || frame.kind !== 'rect' || !view) return undefined;
  const local = applyToPoint(invert(worldMatrix(doc.elements, frame)), world);
  if (local.x < 0 || local.y < 0 || local.x > frame.width || local.y > frame.height) return undefined;
  const u = local.x / frame.width;
  const v = local.y / frame.height;
  const hidden = (id: string) => effectiveOverride(view, id)?.visibility === 'hidden';

  if (view.source === 'view') {
    const source = view.sourceId ? mountedViews.get(view.sourceId) : undefined;
    if (!source) return null;
    const skip = new Set(Object.keys(view.overrides).filter(hidden));
    return source.pickAt(u, v, frame.width / frame.height, skip);
  }

  const shown = new Set(frameContentIds(doc.elements, view).filter((id) => !hidden(id)));
  const inFrame = (element: Element): boolean => {
    for (let current: Element | undefined = element; current; current = current.parentId ? doc.elements[current.parentId] : undefined) if (shown.has(current.id)) return true;
    return false;
  };
  const point = { x: view.crop.x + u * view.crop.width, y: view.crop.y + v * view.crop.height };
  const hit = hitTest(doc, point, { tolerance: tolerance * (view.crop.width / frame.width), includeLocked: true, accept: inFrame });
  if (!hit) return null;
  // The outermost shown ancestor: a stair, not one of its treads.
  let target: Element = hit;
  while (target.parentId && shown.has(target.parentId)) target = doc.elements[target.parentId]!;
  return shown.has(target.id) ? target.id : null;
}
