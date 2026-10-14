/**
 * Upload of a VR tour to the share service (workers/vr-share, a Cloudflare Worker over R2):
 * reserve or reuse a short tour id, upload the model and the tour file, and return the short
 * link a headset opens (`<service>/v/<id>`, which redirects to the SJP-VR viewer).
 * Publishing needs an ArchAI account: the session token authorises the upload and the tour is
 * listed under the account (docs/accounts-and-cloud.md).
 */
import { account } from '@/cloud/account';
import { uploadWithProgress } from '@/progress';

export interface VrShareConfig {
  /** Service root without a trailing slash. */
  url: string;
  /** ArchAI account session token. */
  token: string;
}

/** The deployed service; VITE_VR_SHARE_URL overrides it. */
const DEFAULT_URL = 'https://archai-vr-share.mklkoklpp.workers.dev';

export const VR_SIGN_IN_MESSAGE = 'Sign in to ArchAI to publish VR links';

/** The service and the signed-in account's token, or null signed out. */
export function vrShareConfig(): VrShareConfig | null {
  const url = (String(import.meta.env['VITE_VR_SHARE_URL'] ?? '').trim() || DEFAULT_URL).replace(/\/+$/, '');
  let token: string | null = null;
  try {
    token = account().token();
  } catch {
    token = null;
  }
  return url && token ? { url, token } : null;
}

export interface VrUpload {
  /** A tour id from an earlier publish of this document: its link keeps working and shows the new version. */
  previousId: string | null;
  model?: ArrayBuffer;
  panorama?: Blob;
  tour: Record<string, unknown> | object;
  /** Called again immediately before committing the published manifest. */
  validate?: () => void;
}

export interface VrPublished {
  id: string;
  link: string;
}

async function call(config: VrShareConfig, path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${config.url}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${config.token}` } });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`VR share service: ${response.status} ${detail || response.statusText}`.trim());
  }
  return response;
}

/** `onProgress` follows the model upload (0..1, bytes sent, bytes total). */
export async function uploadVrTour(config: VrShareConfig, upload: VrUpload, onProgress?: (fraction: number, loaded: number, total: number) => void): Promise<VrPublished> {
  if (Boolean(upload.model) === Boolean(upload.panorama)) throw new Error('Choose exactly one prepared output to publish');
  upload.validate?.();
  const reserved = await call(config, '/tours', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(upload.previousId ? { id: upload.previousId } : {}),
  });
  const { id } = (await reserved.json()) as { id: string };
  if (typeof id !== 'string' || !/^[a-z0-9]{4,16}$/.test(id)) throw new Error('VR share service returned an invalid tour id');
  // Unique assets keep the old published revision intact until its manifest is replaced.
  const revision = crypto.randomUUID().replaceAll('-', '');
  const file = upload.panorama ? `panorama-${revision}.png` : `model-${revision}.glb`;
  const sent = await uploadWithProgress(`${config.url}/tours/${id}/${file}`, upload.panorama ?? upload.model!, { method: 'PUT', headers: { 'Content-Type': upload.panorama ? 'image/png' : 'model/gltf-binary', Authorization: `Bearer ${config.token}` } }, (fraction, loaded, total) => onProgress?.(fraction, loaded, total));
  if (sent.status < 200 || sent.status >= 300) throw new Error(`VR share service: ${sent.status} ${sent.text}`.trim());
  const tour = { ...upload.tour, ...(upload.panorama ? { mode: 'panorama', panorama: file, model: '' } : { model: file }) };
  upload.validate?.();
  await call(config, `/tours/${id}/tour.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tour) });
  return { id, link: `${config.url}/v/${id}` };
}
