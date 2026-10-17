import type { ArchaiDocument } from './schema';
import { isEffectivelyLocked } from './query';

/** A pinned perspective rig, marker or portal fixes the view's saved position and lens. */
export function cameraNavigationLocked(doc: Pick<ArchaiDocument, 'elements'>, portalId: string | null): boolean {
  const portal = portalId ? doc.elements[portalId] : undefined;
  const value = portal?.meta?.['view3d'];
  if (!portal || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cameraId = typeof value['cameraId'] === 'string' ? value['cameraId'] : null;
  if (!value['cameraMode'] && !cameraId) return false;
  return isEffectivelyLocked(doc.elements, portal.id) || Boolean(cameraId && isEffectivelyLocked(doc.elements, cameraId));
}
