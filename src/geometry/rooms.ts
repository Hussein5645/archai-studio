import type { ArchaiDocument, Element, ElementTable, JsonValue, LineElement, TextElement } from '@/document';
import { worldMatrix } from './bounds';
import { enclosureArea, enclosureFaces, levelIdOf, polygonCentroid, smallestFaceContaining } from './enclosures';
import { applyToPoint, IDENTITY, invert } from './matrix';
import type { Vec2 } from './vec';
import { linePoints } from './curves';

const EPSILON = 1e-5;

function isArchType(element: Element, type: string): boolean {
  const arch = element.meta?.['arch'];
  return Boolean(arch && typeof arch === 'object' && !Array.isArray(arch) && arch['type'] === type);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON;
}

function samePoints(a: readonly [number, number][], b: readonly [number, number][]): boolean {
  return a.length === b.length && a.every((point, index) => close(point[0], b[index]![0]) && close(point[1], b[index]![1]));
}

function worldPoints(elements: ElementTable, element: LineElement): Vec2[] {
  const matrix = worldMatrix(elements, element);
  return linePoints(element, 32).map(([x, y]) => applyToPoint(matrix, { x, y }));
}

function parentInverse(elements: ElementTable, element: Element) {
  const parent = element.parentId ? elements[element.parentId] : undefined;
  return invert(parent ? worldMatrix(elements, parent) : IDENTITY);
}

function archRecord(element: Element): Record<string, JsonValue> {
  const value = element.meta?.['arch'];
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

/** Cheap mutation key used to avoid rebuilding enclosure graphs for unrelated commands. */
export function roomSyncKey(doc: ArchaiDocument): string {
  const values: unknown[] = [];
  for (const element of Object.values(doc.elements).sort((a, b) => a.id.localeCompare(b.id))) {
    if (element.kind === 'group') {
      values.push(['group', element.id, element.parentId, element.x, element.y, element.rotation]);
    } else if (element.kind === 'line' && (isArchType(element as Element, 'wall') || isArchType(element as Element, 'room-divider'))) {
      values.push(['boundary', element.id, element.parentId, element.visible, element.x, element.y, element.rotation, element.points, element.path]);
    } else if (element.kind === 'line' && isArchType(element as Element, 'room')) {
      values.push(['room', element.id, element.parentId, element.name]);
    }
  }
  return JSON.stringify(values);
}

/** Keep room faces, areas, and labels synchronized with their current wall/divider enclosure. */
export function refreshRooms(doc: ArchaiDocument): void {
  const elements = doc.elements as unknown as ElementTable;
  const rooms = Object.values(doc.elements).filter(
    (element): element is LineElement => element.kind === 'line' && element.closed && isArchType(element as Element, 'room'),
  );
  // Rooms and labels are not boundaries, so the wall/divider faces stay valid for every room;
  // built lazily (once per level) and shared, instead of once per room and seed.
  const facesByLevel = new Map<string | undefined, Vec2[][]>();
  const facesFor = (levelId: string | undefined) => {
    let faces = facesByLevel.get(levelId);
    if (!faces) facesByLevel.set(levelId, (faces = enclosureFaces(doc, 5, levelId)));
    return faces;
  };
  const labelsByRoom = new Map<string, TextElement[]>();
  for (const candidate of Object.values(doc.elements)) {
    if (candidate.kind !== 'text' || !isArchType(candidate as Element, 'room-label')) continue;
    const roomId = archRecord(candidate as Element)['roomId'];
    if (typeof roomId !== 'string') continue;
    const list = labelsByRoom.get(roomId);
    if (list) list.push(candidate as TextElement);
    else labelsByRoom.set(roomId, [candidate as TextElement]);
  }

  for (const room of rooms) {
    const previousWorld = worldPoints(elements, room);
    if (previousWorld.length < 3) continue;
    const previousCentre = polygonCentroid(previousWorld);
    const arch = archRecord(room as Element);
    const storedSeed = Array.isArray(arch['seed']) && arch['seed'].length === 2 && arch['seed'].every((value) => typeof value === 'number')
      ? { x: arch['seed'][0] as number, y: arch['seed'][1] as number }
      : null;
    const fallbackSeeds = previousWorld.map((point) => ({ x: previousCentre.x + (point.x - previousCentre.x) * 0.35, y: previousCentre.y + (point.y - previousCentre.y) * 0.35 }));
    const faces = facesFor(levelIdOf(room as Element) ?? undefined);
    const enclosure = [previousCentre, ...(storedSeed ? [storedSeed] : []), ...fallbackSeeds]
      .map((seed) => smallestFaceContaining(faces, seed))
      .find((candidate) => candidate !== null) ?? null;
    if (!enclosure) continue;

    const area = enclosureArea(enclosure);
    const centre = polygonCentroid(enclosure);
    const inverse = parentInverse(elements, room as Element);
    const parentPoints = enclosure.map((point) => applyToPoint(inverse, point));
    const minX = Math.min(...parentPoints.map((point) => point.x));
    const minY = Math.min(...parentPoints.map((point) => point.y));
    const nextPoints = parentPoints.map((point): [number, number] => [point.x - minX, point.y - minY]);

    if (!close(room.x, minX)) room.x = minX;
    if (!close(room.y, minY)) room.y = minY;
    if (!close(room.rotation, 0)) room.rotation = 0;
    if (!samePoints(room.points, nextPoints)) room.points = nextPoints;
    if (!close(typeof arch['area'] === 'number' ? arch['area'] : -1, area) || !storedSeed || !close(storedSeed.x, centre.x) || !close(storedSeed.y, centre.y)) {
      room.meta = { ...(room.meta ?? {}), arch: { ...arch, type: 'room', area, seed: [centre.x, centre.y] } };
    }

    const name = room.name?.trim() || 'Room';
    const labelWidth = Math.max(1200, Math.min(2600, Math.sqrt(area) * 0.7));
    const labelText = `${name}\n${(area / 1_000_000).toFixed(2)} m²`;
    for (const label of labelsByRoom.get(room.id) ?? []) {
      const labelCentre = applyToPoint(parentInverse(elements, label as Element), centre);
      if (!close(label.width, labelWidth)) label.width = labelWidth;
      if (!close(label.x, labelCentre.x - labelWidth / 2)) label.x = labelCentre.x - labelWidth / 2;
      if (!close(label.y, labelCentre.y - 190)) label.y = labelCentre.y - 190;
      if (label.text !== labelText) label.text = labelText;
      const labelName = `${name} label`;
      if (label.name !== labelName) label.name = labelName;
    }
  }
}
