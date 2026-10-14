/**
 * The signed-in account's published VR tours (Home → VR Links), from the VR share Worker
 * (workers/vr-share: GET /tours, DELETE /tours/<id>). Tours are listed under the account that
 * published them, from the app or a plugin's Open in VR.
 */
import { vrShareConfig, VR_SIGN_IN_MESSAGE } from '@/view3d/vrShare';

export interface VrTour {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** The short link a headset opens. */
  link: string;
  modelBytes: number | null;
  mode?: 'raw' | 'baked' | 'panorama';
  stops: number | null;
  /** False when the tour was reserved but never finished uploading. */
  available: boolean;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const config = vrShareConfig();
  if (!config) throw new Error(VR_SIGN_IN_MESSAGE);
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${config.token}` } });
  } catch {
    throw new Error('Could not reach the VR service: check the internet connection');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `VR service: ${response.status}`);
  }
  return response;
}

export async function listVrTours(): Promise<VrTour[]> {
  const { tours } = (await (await call('/tours')).json()) as { tours: VrTour[] };
  return tours;
}

/** Deletes a tour: its link stops working for everyone. */
export async function deleteVrTour(id: string): Promise<void> {
  await call(`/tours/${id}`, { method: 'DELETE' });
}
