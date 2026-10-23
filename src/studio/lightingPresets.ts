import type { RenderSettings } from './settings';
export const lightingPresets: Record<string, { label: string; settings: Partial<RenderSettings> }> = {
  daylight: { label: 'Daylight', settings: { exposure: 0, sunEnabled: true, sunIntensity: 3, skyIntensity: 1, bloom: 0.05, ambientOcclusion: 1 } },
  soft: { label: 'Soft daylight', settings: { exposure: 0.5, sunEnabled: true, sunIntensity: 1.5, skyIntensity: 1.5, bloom: 0.03, ambientOcclusion: 1 } },
  interior: { label: 'Interior', settings: { exposure: 2, sunEnabled: true, sunIntensity: 3, skyIntensity: 1, bloom: 0.05, ambientOcclusion: 1 } },
};
export function lightingPresetOf(settings: RenderSettings) {
  return Object.entries(lightingPresets).find(([, preset]) => Object.entries(preset.settings).every(([key, value]) => settings[key as keyof RenderSettings] === value))?.[0] ?? 'custom';
}
