/**
 * Upload of a VR tour to the share service (workers/vr-share, a Cloudflare Worker over R2):
 * reserve or reuse a short tour id, upload the model and the tour file, and return the short
 * link a headset opens (`<service>/v/<id>`, which redirects to the SJP-VR viewer).
 * Publishing needs an ArchAI account: the session token authorises the upload and the tour is
 * listed under the account (docs/accounts-and-cloud.md).
 */
import { account } from '@/cloud/account';
import { uploadWithProgress } from '@/progress';
import { addLog } from '@/diagnostics';

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
  const response = await fetch(`${config.url}${path}`, { ...init, signal: AbortSignal.timeout(60_000), headers: { ...init.headers, Authorization: `Bearer ${config.token}` } });
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
  await uploadVrAsset(config, `/tours/${id}/${file}`, upload.panorama ?? new Blob([upload.model!]), onProgress);
  const tour = { ...upload.tour, ...(upload.panorama ? { mode: 'panorama', panorama: file, model: '' } : { model: file }) };
  upload.validate?.();
  await call(config, `/tours/${id}/tour.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tour) });
  return { id, link: `${config.url}/v/${id}` };
}

const CHUNK_BYTES = 8 * 1024 * 1024;
/** Bounded requests avoid the edge request limit; retries only resend the current part. */
export async function uploadVrAsset(config: VrShareConfig, path: string, blob: Blob, onProgress?: (fraction: number, loaded: number, total: number) => void): Promise<void> {
  if (blob.size > CHUNK_BYTES * 64) throw new Error('VR output exceeds 512 MB. Reduce textures or model detail and try again.');
  const { uploadId } = await (await call(config, `${path}?multipart=start`, { method: 'POST' })).json() as { uploadId: string };
  const query = `uploadId=${encodeURIComponent(uploadId)}`;
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const chunk = blob.slice(offset, offset + CHUNK_BYTES);
      const partNumber = parts.length + 1;
      addLog('info', `VR upload: part ${partNumber} of ${Math.ceil(blob.size / CHUNK_BYTES)}`);
      for (let attempt = 0; ; attempt++) {
        try {
          const sent = await uploadWithProgress(`${config.url}${path}?${query}&partNumber=${partNumber}`, chunk,
            { method: 'PUT', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/octet-stream' } },
            (_fraction, loaded) => onProgress?.((offset + loaded) / blob.size, offset + loaded, blob.size));
          if (sent.status < 200 || sent.status >= 300) {
            if (sent.status < 500 && sent.status !== 408 && sent.status !== 429) throw new Error(`Upload rejected (${sent.status}): ${sent.text}`);
            throw new Error(`Upload service temporarily unavailable (${sent.status})`);
          }
          const part = JSON.parse(sent.text) as { etag: string };
          if (!part.etag) throw new Error('Upload service returned no part receipt');
          parts.push({ partNumber, etag: part.etag });
          break;
        } catch (error) {
          if (attempt >= 2 || (error instanceof Error && error.message.startsWith('Upload rejected'))) throw error;
          addLog('warn', `VR upload: retrying part ${partNumber} (${error instanceof Error ? error.message : 'network error'})`);
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    }
    await call(config, `${path}?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts }) });
  } catch (error) {
    await call(config, `${path}?${query}`, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}
