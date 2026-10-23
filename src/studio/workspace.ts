import type { CameraState } from '@/view3d/SceneView';

let snapshot: { open: boolean; camera?: CameraState } = { open: false };
const listeners = new Set<() => void>();
export const renderWorkspace = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => snapshot,
  open(camera?: CameraState) { snapshot = { open: true, camera }; listeners.forEach((listener) => listener()); },
  close() { snapshot = { open: false }; listeners.forEach((listener) => listener()); },
};
