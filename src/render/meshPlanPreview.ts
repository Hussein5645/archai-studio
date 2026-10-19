import { useEffect, useState } from 'react';
import { segmentsPath, type MeshPlan } from './meshPlan';

interface Preview { href: string; x: number; y: number; width: number; height: number }
const previews = new WeakMap<MeshPlan, Map<string, Preview>>();

/** Dense low-detail plans become cached transparent images while source/export stays vector. */
export function rasterMeshPlan(plan: MeshPlan, width: number, height: number, ink: string): Preview | null {
  if (!(width > 0 && height > 0)) return null;
  const key = `${width}:${height}:${ink}`;
  const cached = previews.get(plan)?.get(key);
  if (cached) return cached;
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale)) + 4;
  canvas.height = Math.max(1, Math.ceil(height * scale)) + 4;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.translate(2, 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.8 / scale;
  ctx.globalAlpha = 0.7;
  ctx.stroke(new Path2D(segmentsPath(plan.edges)));
  ctx.lineWidth = 1.8 / scale;
  ctx.globalAlpha = 1;
  ctx.stroke(new Path2D(segmentsPath(plan.cut)));
  const preview = { href: canvas.toDataURL('image/png'), x: -2 / scale, y: -2 / scale, width: canvas.width / scale, height: canvas.height / scale };
  const cache = previews.get(plan) ?? new Map<string, Preview>();
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(key, preview);
  previews.set(plan, cache);
  return preview;
}

export function useMeshPlanPreview(plan: MeshPlan | null | undefined, width: number, height: number, ink: string, enabled: boolean): Preview | null {
  const key = `${width}:${height}:${ink}`;
  const [rendered, setRendered] = useState<{ plan: MeshPlan; key: string; image: Preview } | null>(null);
  useEffect(() => {
    if (!enabled || !plan || (plan.edges.length + plan.cut.length) / 4 < 2000) return;
    const timer = setTimeout(() => {
      const image = rasterMeshPlan(plan, width, height, ink);
      if (image) setRendered({ plan, key, image });
    }, 0);
    return () => clearTimeout(timer);
  }, [enabled, plan, width, height, ink, key]);
  return enabled && rendered && rendered.plan === plan && rendered.key === key ? rendered.image : null;
}
