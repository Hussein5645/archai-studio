/**
 * Writes one example system type per tool into <r2 folder>/system/<tool>/. They are starting
 * points for real packages: SVG placeholder views and, where a model is required, an empty
 * (but valid) glTF binary. Usage: node scripts/make-sample-system-types.mjs [r2/r2-upload-folder]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

const root = path.resolve(process.argv[2] ?? 'r2/r2-upload-folder');

/** Minimal valid GLB: a glTF 2.0 asset with no scenes. */
function emptyGlb() {
  const json = strToU8(JSON.stringify({ asset: { version: '2.0' } }));
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
  padded.set(json);
  const header = new DataView(new ArrayBuffer(12 + 8));
  header.setUint32(0, 0x46546c67, true); // 'glTF'
  header.setUint32(4, 2, true);
  header.setUint32(8, 20 + padded.length, true);
  header.setUint32(12, padded.length, true);
  header.setUint32(16, 0x4e4f534a, true); // 'JSON'
  const out = new Uint8Array(20 + padded.length);
  out.set(new Uint8Array(header.buffer));
  out.set(padded, 20);
  return out;
}

const svg = (width, height, body) => strToU8(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${body}</svg>`);

/** Section swatch for a layered wall/railing: one band per layer, outside at the top. */
function sectionSwatch(layers) {
  const total = layers.reduce((sum, layer) => sum + layer.thickness, 0);
  let y = 0;
  const bands = layers
    .map((layer) => {
      const h = (layer.thickness / total) * 200;
      const band = `<rect x="0" y="${y}" width="300" height="${h}" fill="${layer.role === 'core' ? '#6b6b72' : '#d9dbe0'}" stroke="#3a3a3f" stroke-width="2"/><text x="8" y="${y + h / 2 + 4}" font-size="12" font-family="sans-serif" fill="${layer.role === 'core' ? '#fff' : '#3a3a3f'}">${layer.name} ${layer.thickness}</text>`;
      y += h;
      return band;
    })
    .join('');
  return svg(300, 200, bands);
}

const placeholder = (label, w, h) => svg(w, h, `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="#fff" stroke="#3a3a3f" stroke-width="2"/><text x="${w / 2}" y="${h / 2 + 5}" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#6b6b72">${label}</text>`);

const samples = [
  {
    tool: 'wall',
    id: 'wall-presets-masonry',
    name: 'Masonry walls',
    // A wall package is a set of named layer presets; each becomes one wall type in the app.
    presets: [
      {
        id: 'brick-cavity',
        name: 'Brick cavity wall',
        layers: [
          { name: 'Brick', role: 'core', thickness: 102 },
          { name: 'Cavity', role: 'core', thickness: 50 },
          { name: 'Block', role: 'core', thickness: 100 },
          { name: 'Plaster', role: 'finish', thickness: 13 },
        ],
        locationLine: 'outside',
        height: 3000,
        elevation: 0,
      },
      {
        id: 'stud-partition',
        name: 'Stud partition',
        layers: [
          { name: 'Board', role: 'finish', thickness: 13 },
          { name: 'Stud', role: 'core', thickness: 90 },
          { name: 'Board', role: 'finish', thickness: 13 },
        ],
        locationLine: 'centre',
        height: 2700,
        elevation: 0,
      },
    ],
    tags: ['masonry', 'partition'],
    files: (p, sample) => ({ 'views/section.svg': sectionSwatch(sample.presets[0].layers) }),
    mapping: { views: { section: 'views/section.svg' }, models: {} },
  },
  {
    tool: 'column',
    id: 'column-steel-i-section',
    name: 'Steel I-section 300',
    parameters: { shape: 'rectangle', width: 300, depth: 300, height: 3000, material: 'steel' },
    size: { width: 300, height: 300 },
    files: () => ({
      'views/top.svg': svg(300, 300, '<path d="M20 20h260v40H180v180h100v40H20v-40h100V60H20z" fill="#c9ccd3" stroke="#3a3a3f" stroke-width="4"/>'),
      'views/front.svg': placeholder('front', 300, 600),
      'views/side.svg': placeholder('side', 300, 600),
      'models/model.glb': emptyGlb(),
    }),
    mapping: { views: { top: 'views/top.svg', front: 'views/front.svg', side: 'views/side.svg' }, models: { glb: 'models/model.glb' } },
  },
  {
    tool: 'door',
    id: 'door-double-swing-1800',
    name: 'Double swing 1800',
    parameters: { operation: 'double-swing', width: 1800, handing: 'left', openingSide: 'inside', threshold: 0 },
    size: { width: 1800, height: 900 },
    files: () => ({
      'views/top.svg': svg(1800, 900, '<path d="M0 0v900M1800 0v900" stroke="#3a3a3f" stroke-width="40"/><path d="M0 0a900 900 0 0 1 900 900M1800 0a900 900 0 0 0 -900 900" fill="none" stroke="#6b6b72" stroke-width="8"/>'),
      'views/front.svg': placeholder('front', 1800, 2100),
      'views/side.svg': placeholder('side', 200, 2100),
      'models/model.glb': emptyGlb(),
    }),
    mapping: { views: { top: 'views/top.svg', front: 'views/front.svg', side: 'views/side.svg' }, models: { glb: 'models/model.glb' } },
  },
  {
    tool: 'window',
    id: 'window-casement-1200',
    name: 'Casement 1200',
    parameters: { mechanism: 'casement', width: 1200, height: 1200, sill: 900, openingDirection: 'outward' },
    size: { width: 1200, height: 150 },
    files: () => ({
      'views/top.svg': svg(1200, 150, '<rect x="8" y="8" width="1184" height="134" fill="#fff" stroke="#3a3a3f" stroke-width="16"/><path d="M0 75h1200" stroke="#3a3a3f" stroke-width="10"/>'),
      'views/front.svg': placeholder('front', 1200, 1200),
      'views/side.svg': placeholder('side', 150, 1200),
      'models/model.glb': emptyGlb(),
    }),
    mapping: { views: { top: 'views/top.svg', front: 'views/front.svg', side: 'views/side.svg' }, models: { glb: 'models/model.glb' } },
  },
  {
    tool: 'stair',
    id: 'stair-closed-riser',
    name: 'Closed riser 1200',
    parameters: { width: 1200, riserHeight: 170, treadDepth: 290, totalRise: 3000, landingDepth: 1200, treadStyle: 'closed-riser', nosing: 25 },
    size: { width: 1200, height: 290 },
    files: () => ({
      'views/top.svg': svg(1200, 290, '<rect x="0" y="0" width="1200" height="290" fill="#fff" stroke="#3a3a3f" stroke-width="12"/><path d="M0 145h1200" stroke="#6b6b72" stroke-width="8"/>'),
      'views/front.svg': placeholder('front', 1200, 400),
      'views/side.svg': placeholder('side', 290, 170),
      'models/model.glb': emptyGlb(),
    }),
    mapping: { views: { top: 'views/top.svg', front: 'views/front.svg', side: 'views/side.svg' }, models: { glb: 'models/model.glb' } },
  },
  {
    tool: 'railing',
    id: 'railing-glass-panel',
    name: 'Glass panel railing',
    parameters: { thickness: 60, height: 1100, balusterSpacing: 0, pattern: 'glass-panel' },
    files: () => ({ 'views/section.svg': svg(300, 200, '<rect x="130" y="10" width="40" height="180" fill="#9cc5e8" stroke="#3a3a3f" stroke-width="3"/><rect x="110" y="0" width="80" height="24" fill="#6b6b72"/>') }),
    mapping: { views: { section: 'views/section.svg' }, models: {} },
  },
];

for (const sample of samples) {
  const metadata = {
    caiVersion: 1,
    id: sample.id,
    name: sample.name,
    kind: 'system',
    system: { type: sample.tool, parameters: sample.parameters ?? {}, ...(sample.presets ? { presets: sample.presets } : {}) },
    ...(sample.size ? { size: sample.size } : {}),
    ...(sample.tags ? { tags: sample.tags } : {}),
  };
  const files = {
    'metadata.json': strToU8(JSON.stringify(metadata, null, 2)),
    'mapping.json': strToU8(JSON.stringify({ version: 1, ...sample.mapping }, null, 2)),
    ...sample.files(sample.parameters, sample),
  };
  const directory = path.join(root, 'system', sample.tool);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${sample.id}.cai`);
  await writeFile(target, zipSync(files));
  process.stdout.write(`wrote ${path.relative(process.cwd(), target)}\n`);
}
