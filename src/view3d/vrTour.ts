/**
 * A published VR tour: the stops of the document converted to the tour format of the SJP-VR
 * viewer (metres, y up, plan positions as [x, z]; see docs/vr-tours.md). Pure, so it is tested
 * without three.js or the network.
 */
import type { ArchaiDocument } from '@/document';
import { applyToPoint, worldMatrix } from '@/geometry';
import { vrStopOf } from '@/document/vrStop';
import { instanceElevationOf } from './geometry';

export interface VrStopPlacement {
  id: string;
  name: string;
  /** Plan centre in mm. */
  x: number;
  y: number;
  /** Floor the visitor stands on, mm. */
  elevation: number;
  heading: number;
}

export interface VrTourSpace {
  id: string;
  name: string;
  center: [number, number];
  look: [number, number];
  floor: number;
}

export interface VrTourJson {
  format: 'archai-vr';
  version: 1;
  name: string;
  /** Relative to the tour file. */
  model: string;
  lighting: 'live';
  exposure: number;
  credit: string;
  start: string;
  spaces: VrTourSpace[];
}

/** How far ahead of a stop its look point lies, in metres. */
const LOOK_DISTANCE = 3;

export function vrStopsOf(doc: ArchaiDocument): VrStopPlacement[] {
  const stops: VrStopPlacement[] = [];
  for (const element of Object.values(doc.elements)) {
    const stop = vrStopOf(element);
    if (!stop || !element.visible || element.kind !== 'rect') continue;
    const centre = applyToPoint(worldMatrix(doc.elements, element), { x: element.width / 2, y: element.height / 2 });
    stops.push({ id: element.id, name: element.name?.trim() || `Stop ${stops.length + 1}`, x: centre.x, y: centre.y, elevation: instanceElevationOf(element, doc.elements), heading: stop.heading });
  }
  return stops;
}

const metres = (mm: number) => Math.round(mm) / 1000;

export function vrTourJson(doc: ArchaiDocument, stops: readonly VrStopPlacement[] = vrStopsOf(doc), model = 'model.glb'): VrTourJson {
  const spaces = stops.map((stop, index): VrTourSpace => {
    const r = (stop.heading * Math.PI) / 180;
    const center: [number, number] = [metres(stop.x), metres(stop.y)];
    // Board +y runs down the screen and is the scene's +z, so a board angle maps straight across.
    const look: [number, number] = [Math.round((center[0] + Math.cos(r) * LOOK_DISTANCE) * 1000) / 1000, Math.round((center[1] + Math.sin(r) * LOOK_DISTANCE) * 1000) / 1000];
    return { id: `s${index + 1}`, name: stop.name, center, look, floor: metres(stop.elevation) };
  });
  return {
    format: 'archai-vr',
    version: 1,
    name: doc.meta.name.trim() || 'ArchAI project',
    model,
    lighting: 'live',
    exposure: 1.1,
    credit: 'ArchAI',
    start: spaces[0]?.id ?? '',
    spaces,
  };
}
