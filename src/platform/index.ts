import { createElectronPlatform, getElectronBridge } from './electron';
import { createNativePlatform, getNativeTransport } from './native';
import type { Platform } from './types';
import { createWebPlatform } from './web';

export type { Platform, ImageFile, OpenedDocumentFile } from './types';

export function createPlatform(): Platform {
  const bridge = getElectronBridge();
  if (bridge) return createElectronPlatform(bridge);
  const transport = getNativeTransport();
  return transport ? createNativePlatform(transport) : createWebPlatform();
}
