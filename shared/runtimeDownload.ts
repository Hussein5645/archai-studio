/** Versioned optional pack. Never included in the base desktop installer. */
export const UNREAL_PACK_VERSION = '0.3.0.12';
export const ACCOUNT_CLOUD_URL = 'https://archai-cloud.mklkoklpp.workers.dev';
export type RuntimeDownloadState = {
  state: 'missing' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error';
  received: number; total: number; error?: string;
};
export function guestFolderAllowed(options: { delivery: string; sourceRenderer: string; lighting: string } | undefined) {
  return options?.delivery === 'webxr' && options.sourceRenderer === 'default' && options.lighting === 'realtime';
}
