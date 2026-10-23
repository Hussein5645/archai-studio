import { useEffect, useState } from 'react';
import { useApp } from '@/app/context';
import type { Platform } from '@/platform/types';

const previews = new Map<string, string>();
const key = (doc: string, view: string) => `view-preview:${doc}:${view}`;
export async function saveViewPreview(
  platform: Platform,
  doc: string,
  view: string,
  image: string,
) {
  previews.set(key(doc, view), image);
  await platform.storage.set(key(doc, view), image);
  window.dispatchEvent(new Event('archai:view-preview'));
}
export function useViewPreview(doc: string, view: string | null) {
  const { platform } = useApp();
  const storageKey = view ? key(doc, view) : '';
  const [preview, setPreview] = useState(previews.get(storageKey) ?? '');
  useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (alive) setPreview(previews.get(storageKey) ?? '');
    });
    if (storageKey)
      void platform.storage
        .get(storageKey)
        .then((value) => {
          if (alive && value) {
            previews.set(storageKey, value);
            setPreview(value);
          }
        })
        .catch(() => undefined);
    const update = () => setPreview(previews.get(storageKey) ?? '');
    window.addEventListener('archai:view-preview', update);
    return () => {
      alive = false;
      window.removeEventListener('archai:view-preview', update);
    };
  }, [platform, storageKey]);
  return preview;
}
