/**
 * Light helpers for 3D model import UI (the converter itself, ./modelImport.ts, loads on demand).
 */

/** File names the 3D model import reads (see MODEL_FORMATS in ./modelImport.ts). */
export const MODEL_EXTENSION = /\.(glb|gltf|fbx|obj|stl|ply|dae|3mf|3ds|amf|wrl|vrml|usdz|usd|usda|usdc|lwo|vtk|vtp|kmz)$/i;

/** One-line summary of an import: what was read, in which units, and how big it came out. */
export function modelToast(result: unknown): string {
  const value = result as { unit?: string; up?: string; size?: [number, number, number]; format?: string; triangles?: number } | null;
  if (!value?.size) return '3D model imported';
  const metres = (mm: number) => (mm / 1000).toFixed(mm >= 10_000 ? 1 : 2);
  const [x, y, z] = value.size;
  return `${value.format ?? '3D'} model imported as ${value.unit}, ${value.up?.toUpperCase()} up: ${metres(x)} × ${metres(y)} × ${metres(z)} m${value.triangles ? `, ${value.triangles.toLocaleString()} triangles` : ''}. Wrong size or lying down? Change Units / Up axis in the Inspector.`;
}
