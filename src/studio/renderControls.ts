import { useSyncExternalStore } from 'react';

let host: HTMLDivElement | null = null;
const listeners = new Set<() => void>();
export const showRenderControlsEvent = 'archai:show-render-controls';
export function setRenderControlsHost(value: HTMLDivElement | null) {
  host = value;
  listeners.forEach((listener) => listener());
}
export function useRenderControlsHost() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => host,
  );
}
