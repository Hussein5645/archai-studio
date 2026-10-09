/**
 * VR stops: reference points (see ./point.ts) that also carry `meta.vrStop = { heading }`. A stop
 * is where a visitor stands in a published VR tour: its plan centre and elevation (the floor they
 * stand on), its name (the tag shown in the headset) and the direction they face on arrival.
 */
import { isPoint } from './point';
import type { Element } from './schema';

export interface VrStop {
  /** Facing on arrival: degrees clockwise from +x on the board (the document's angle convention). */
  heading: number;
}

export const VR_STOP_COLOUR = '#0ea5e9';

export function vrStopOf(element: Element | undefined): VrStop | null {
  if (!element || !isPoint(element)) return null;
  const value = element.meta?.['vrStop'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const heading = (value as Record<string, unknown>)['heading'];
  return { heading: typeof heading === 'number' && Number.isFinite(heading) ? heading : 0 };
}

/** Heading normalised to [0, 360). */
export function normaliseHeading(degrees: number): number {
  const value = degrees % 360;
  return value < 0 ? value + 360 : value;
}
