/**
 * The PBR material preset library (docs/modeling-tools.md §7.4). Presets are copied into the
 * asset's own `materials` record so packages stay self-contained; the asset can then edit or
 * add materials without touching this list.
 */
import type { PbrMaterial } from './types';

export const MATERIAL_PRESETS: Record<string, PbrMaterial> = {
  oak: { name: 'Oak', color: '#c9a877', roughness: 0.7, metalness: 0, opacity: 1 },
  walnut: { name: 'Walnut', color: '#5b3d2a', roughness: 0.65, metalness: 0, opacity: 1 },
  birch: { name: 'Birch', color: '#e6d3b0', roughness: 0.7, metalness: 0, opacity: 1 },
  'painted-white': { name: 'Painted white', color: '#f4f4f1', roughness: 0.45, metalness: 0, opacity: 1 },
  'painted-black': { name: 'Painted black', color: '#1f1f22', roughness: 0.45, metalness: 0, opacity: 1 },
  'matte-grey': { name: 'Matte grey', color: '#8d9096', roughness: 0.85, metalness: 0, opacity: 1 },
  'brushed-steel': { name: 'Brushed steel', color: '#b9bcc2', roughness: 0.45, metalness: 1, opacity: 1 },
  chrome: { name: 'Chrome', color: '#e2e4e8', roughness: 0.12, metalness: 1, opacity: 1 },
  brass: { name: 'Brass', color: '#c9a648', roughness: 0.35, metalness: 1, opacity: 1 },
  'fabric-grey': { name: 'Fabric grey', color: '#7c7f86', roughness: 0.95, metalness: 0, opacity: 1 },
  'fabric-beige': { name: 'Fabric beige', color: '#cbbba0', roughness: 0.95, metalness: 0, opacity: 1 },
  'leather-brown': { name: 'Leather brown', color: '#6f4a2e', roughness: 0.55, metalness: 0, opacity: 1 },
  glass: { name: 'Glass', color: '#dbe9f0', roughness: 0.05, metalness: 0, opacity: 0.3 },
  'frosted-glass': { name: 'Frosted glass', color: '#e8eef2', roughness: 0.6, metalness: 0, opacity: 0.55 },
  concrete: { name: 'Concrete', color: '#a5a5a1', roughness: 0.9, metalness: 0, opacity: 1 },
  'ceramic-white': { name: 'Ceramic white', color: '#f7f7f5', roughness: 0.2, metalness: 0, opacity: 1 },
};

export const DEFAULT_MATERIAL = 'matte-grey';

/** A fresh copy of the presets for a new asset. */
export function presetMaterials(): Record<string, PbrMaterial> {
  return Object.fromEntries(Object.entries(MATERIAL_PRESETS).map(([id, material]) => [id, { ...material }]));
}
