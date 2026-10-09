// Synthetic AIR fixture using the same schema as src/document/schema.ts.
import { writeFileSync } from 'node:fs';
const elements = {};
let index = 0;
const style = { fill: null, stroke: '#333333', strokeWidth: 20, opacity: 1 };
const add = (id, kind, fields) => elements[id] = {
  id, kind, parentId: null, index: `a${String(index++).padStart(2, '0')}`,
  x: 0, y: 0, rotation: 0, visible: true, locked: false, ...fields,
};
const rect = (id, fields) => add(id, 'rect', { width: 500, height: 500, radius: 0, style, ...fields });
const line = (id, fields) => add(id, 'line', { points: [[0, 0], [1000, 0]], closed: false, style, ...fields });
const arch = (type, parameters = {}, extra = {}) => ({ arch: { type, parameters, ...extra } });
const linked = (type, parameters, elevation) => ({
  ...arch(type, parameters), instanceElevation: elevation,
  levelConstraint: { levelId: 'ground', offset: elevation },
});
rect('ground', { name: 'Ground', width: 11000, height: 6500, meta: { level: { elevation: 0 } } });
rect('upper', { name: 'Upper', width: 11000, height: 6500, meta: { level: { elevation: 3150 } } });
line('walls', { name: 'Room enclosure', points: [[0, 0], [6000, 0], [6000, 5000], [0, 5000]], closed: true,
  meta: linked('wall', { height: 3000, elevation: 0, locationLine: 'centre', layers: [{ name: 'Core', role: 'core', thickness: 200 }] }, 0) });
line('floor', { name: 'Ground slab', points: [[-100, -100], [6100, -100], [6100, 5100], [-100, 5100]], closed: true,
  meta: { ...linked('floor', { thickness: 200, elevation: -200, material: 'concrete' }, -200), solid: { height: 200, elevation: -200 } } });
line('ceiling', { name: 'Ceiling', points: [[100, 100], [5900, 100], [5900, 4900], [100, 4900]], closed: true,
  meta: { ...linked('ceiling', { thickness: 100, elevation: 2700 }, 2700), solid: { height: 100, elevation: 2700 } } });
const definitions = {};
for (const [id, type, width, height] of [['door-def', 'door', 900, 900], ['window-def', 'window', 1200, 150]]) {
  definitions[id] = { id, name: type, kind: 'template', origin: 'builtin', width, height, elements: {} };
}
add('door', 'instance', { name: 'Entrance', definitionId: 'door-def', width: 900, height: 900, x: 1000,
  meta: { ...arch('door', { width: 900, height: 2100, operation: 'swing', handing: 'left', openingSide: 'inside', threshold: 0 },
    { wallMountOffset: 0, opening: { wallId: 'walls', segment: 0, start: 1000, end: 1900 } }), host: 'walls' } });
add('window', 'instance', { name: 'East window', definitionId: 'window-def', width: 1200, height: 150, x: 6075, y: 1500, rotation: 90,
  meta: { ...arch('window', { width: 1200, height: 1200, sill: 900, mechanism: 'fixed' },
    { wallMountOffset: 75, opening: { wallId: 'walls', segment: 1, start: 1500, end: 2700 } }), host: 'walls' } });
rect('column', { name: 'Rectangular column', x: 600, y: 3500, meta: linked('column', { shape: 'rectangle', width: 500, depth: 500, height: 3000, elevation: 0 }, 0) });
rect('round-column', { name: 'Circular column', x: 4500, y: 3500, meta: linked('column', { shape: 'circle', diameter: 500, height: 3000, elevation: 0 }, 0) });
line('room', { name: 'Living room', points: [[100, 100], [5900, 100], [5900, 4900], [100, 4900]], closed: true, meta: linked('room', {}, 0) });
add('stairs', 'group', { name: 'Straight stair', x: 7500, y: 0,
  meta: arch('stair', { width: 1000, riserHeight: 175, treadDepth: 280, totalRise: 3150, landingDepth: 1000, elevation: 0, treadStyle: 'closed-riser', nosing: 0 },
    { flights: [{ kind: 'run', x: 0, y: 0, angle: 90, treads: 18 }] }) });
line('stair-railing', { name: 'Right stair railing', parentId: 'stairs', points: [[-500, 0], [-500, 5040]],
  meta: { ...arch('railing', { height: 1100, thickness: 80, elevation: 0 }), stairAttached: true, stairSide: 'right' } });
rect('solid', { name: 'Explicit solid family', x: 9500, y: 1000, width: 800, height: 600, rotation: 30, meta: { solid: { height: 700, elevation: 0 } } });
const doc = {
  schemaVersion: 1, id: 'revit-native-smoke', meta: { name: 'Revit native import smoke test', createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' },
  workspace: { unit: 'mm', precision: 0, background: '#ffffff', grid: { visible: true, size: 100 }, snap: { enabled: true }, viewStyle: 'hidden-line', lod: 'low', graphics: {} },
  elements, definitions, blobs: {},
};
writeFileSync(new URL('./native-smoke.AIR', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
console.log(`Wrote ${Object.keys(elements).length} source objects.`);
