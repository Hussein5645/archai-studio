// Generates the development asset catalog under public/catalog: simple top-down PNG symbols
// plus a manifest.json in the same nested-folder convention the production R2 bucket uses
// (<Category>/<Subcategory>/<asset>/{2d.png,3d.glb}). No image libraries: a tiny rasterizer
// and PNG encoder are enough for placeholders.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'catalog');

// ---- minimal RGBA rasterizer ---------------------------------------------------------------

class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }
  set(x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const alpha = a / 255;
    const inv = 1 - alpha;
    this.data[i] = r * alpha + this.data[i] * inv;
    this.data[i + 1] = g * alpha + this.data[i + 1] * inv;
    this.data[i + 2] = b * alpha + this.data[i + 2] * inv;
    this.data[i + 3] = Math.min(255, a + this.data[i + 3] * inv);
  }
  fillRect(x, y, w, h, color) {
    for (let yy = Math.floor(y); yy < y + h; yy++) for (let xx = Math.floor(x); xx < x + w; xx++) this.set(xx, yy, color);
  }
  strokeRect(x, y, w, h, t, color) {
    this.fillRect(x, y, w, t, color);
    this.fillRect(x, y + h - t, w, t, color);
    this.fillRect(x, y, t, h, color);
    this.fillRect(x + w - t, y, t, h, color);
  }
  fillEllipse(cx, cy, rx, ry, color) {
    for (let yy = Math.floor(cy - ry); yy <= cy + ry; yy++)
      for (let xx = Math.floor(cx - rx); xx <= cx + rx; xx++) {
        const dx = (xx + 0.5 - cx) / rx;
        const dy = (yy + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(xx, yy, color);
      }
  }
  strokeEllipse(cx, cy, rx, ry, t, color) {
    for (let yy = Math.floor(cy - ry - t); yy <= cy + ry + t; yy++)
      for (let xx = Math.floor(cx - rx - t); xx <= cx + rx + t; xx++) {
        const dx = xx + 0.5 - cx;
        const dy = yy + 0.5 - cy;
        const outer = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
        const inner = (dx * dx) / ((rx - t) * (rx - t)) + (dy * dy) / ((ry - t) * (ry - t)) <= 1;
        if (outer && !inner) this.set(xx, yy, color);
      }
  }
  line(x0, y0, x1, y1, t, color) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      this.fillEllipse(x, y, t / 2, t / 2, color);
    }
  }
}

// ---- PNG encoder ---------------------------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(raster) {
  const { width, height, data } = raster;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- symbols -------------------------------------------------------------------------------

const INK = [58, 58, 63, 255];
const SOFT = [58, 58, 63, 110];
const FILL = [255, 255, 255, 255];
const LIGHT = [232, 233, 236, 255];

const PX = 256; // longest side in pixels

function canvasFor(size) {
  const scale = PX / Math.max(size.width, size.height);
  const r = new Raster(Math.max(8, Math.round(size.width * scale)), Math.max(8, Math.round(size.height * scale)));
  return { r, s: scale, w: size.width * scale, h: size.height * scale };
}

const symbols = {
  sofa({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.fillRect(0, 0, w, h * 0.22, LIGHT);
    r.fillRect(0, 0, w * 0.1, h, LIGHT);
    r.fillRect(w * 0.9, 0, w * 0.1, h, LIGHT);
    r.line(0, h * 0.22, w, h * 0.22, 3, SOFT);
    r.line(w * 0.1, 0, w * 0.1, h, 3, SOFT);
    r.line(w * 0.9, 0, w * 0.9, h, 3, SOFT);
    r.line(w / 2, h * 0.22, w / 2, h, 3, SOFT);
    r.strokeRect(0, 0, w, h, 4, INK);
  },
  armchair({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.fillRect(0, 0, w, h * 0.25, LIGHT);
    r.fillRect(0, 0, w * 0.18, h, LIGHT);
    r.fillRect(w * 0.82, 0, w * 0.18, h, LIGHT);
    r.strokeRect(w * 0.18, h * 0.25, w * 0.64, h * 0.75, 3, SOFT);
    r.strokeRect(0, 0, w, h, 4, INK);
  },
  table({ r, w, h }, chairs) {
    const pad = Math.min(w, h) * 0.22;
    r.fillRect(pad, pad, w - pad * 2, h - pad * 2, FILL);
    r.strokeRect(pad, pad, w - pad * 2, h - pad * 2, 4, INK);
    const cw = pad * 0.8;
    const per = Math.ceil(chairs / 2);
    for (let i = 0; i < per; i++) {
      const cx = pad + ((w - pad * 2) * (i + 0.5)) / per - cw / 2;
      r.strokeRect(cx, 2, cw, pad - 6, 3, SOFT);
      if (i + per < chairs) r.strokeRect(cx, h - pad + 4, cw, pad - 6, 3, SOFT);
    }
  },
  coffeeTable({ r, w, h }) {
    r.strokeEllipse(w / 2, h / 2, w / 2 - 3, h / 2 - 3, 4, INK);
  },
  wardrobe({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    r.line(0, 0, w, h, 2, SOFT);
    r.line(0, h, w, 0, 2, SOFT);
  },
  bed({ r, w, h }, single) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    const pw = single ? w * 0.7 : w * 0.4;
    r.strokeRect(w * 0.08, h * 0.04, pw, h * 0.12, 3, SOFT);
    if (!single) r.strokeRect(w * 0.52, h * 0.04, pw, h * 0.12, 3, SOFT);
    r.line(0, h * 0.28, w, h * 0.28, 3, SOFT);
    r.line(0, h * 0.28, w * 0.25, h * 0.4, 3, SOFT);
  },
  counter({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    r.strokeRect(w * 0.55, h * 0.15, w * 0.3, h * 0.7, 3, INK);
    r.fillEllipse(w * 0.7, h * 0.5, w * 0.02, h * 0.05, INK);
    for (let i = 0; i < 4; i++) r.strokeEllipse(w * 0.12 + (i % 2) * w * 0.14, h * 0.3 + Math.floor(i / 2) * h * 0.4, h * 0.12, h * 0.12, 3, SOFT);
  },
  bathtub({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    r.strokeEllipse(w / 2, h / 2, w * 0.42, h * 0.36, 3, SOFT);
    r.fillEllipse(w * 0.85, h / 2, w * 0.02, h * 0.06, INK);
  },
  wc({ r, w, h }) {
    r.fillRect(w * 0.1, 0, w * 0.8, h * 0.3, FILL);
    r.strokeRect(w * 0.1, 0, w * 0.8, h * 0.3, 4, INK);
    r.fillEllipse(w / 2, h * 0.64, w * 0.45, h * 0.34, FILL);
    r.strokeEllipse(w / 2, h * 0.64, w * 0.45, h * 0.34, 4, INK);
  },
  basin({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    r.strokeEllipse(w / 2, h * 0.55, w * 0.35, h * 0.32, 3, SOFT);
    r.fillEllipse(w / 2, h * 0.2, w * 0.03, h * 0.05, INK);
  },
  lamp({ r, w, h }) {
    r.strokeEllipse(w / 2, h / 2, w / 2 - 3, h / 2 - 3, 4, INK);
    r.line(w * 0.25, h * 0.25, w * 0.75, h * 0.75, 3, SOFT);
    r.line(w * 0.75, h * 0.25, w * 0.25, h * 0.75, 3, SOFT);
  },
  fridge({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    r.line(0, h * 0.15, w, h * 0.15, 3, SOFT);
    r.line(w / 2, h * 0.15, w / 2, h, 3, SOFT);
  },
  panel({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    for (let i = 1; i < 6; i++) r.line((w * i) / 6, 0, (w * i) / 6, h, 2, SOFT);
  },
  person({ r, w, h }) {
    r.strokeEllipse(w / 2, h / 2, w / 2 - 3, h / 2 - 3, 3, SOFT);
    r.fillEllipse(w / 2, h / 2, w * 0.16, h * 0.24, INK);
  },
  car({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    r.strokeRect(w * 0.1, h * 0.28, w * 0.8, h * 0.44, 3, SOFT);
    r.line(w * 0.1, h * 0.28, w * 0.2, h * 0.15, 3, SOFT);
    r.line(w * 0.9, h * 0.28, w * 0.8, h * 0.15, 3, SOFT);
  },
  tree({ r, w, h }) {
    r.strokeEllipse(w / 2, h / 2, w / 2 - 3, h / 2 - 3, 4, INK);
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      r.line(w / 2, h / 2, w / 2 + Math.cos(a) * (w / 2 - 8), h / 2 + Math.sin(a) * (h / 2 - 8), 2, SOFT);
    }
    r.fillEllipse(w / 2, h / 2, w * 0.04, h * 0.04, INK);
  },
  bench({ r, w, h }) {
    r.fillRect(0, 0, w, h, FILL);
    r.strokeRect(0, 0, w, h, 4, INK);
    r.line(0, h * 0.35, w, h * 0.35, 3, SOFT);
    r.line(0, h * 0.65, w, h * 0.65, 3, SOFT);
  },
  northArrow({ r, w, h }) {
    r.line(w / 2, h * 0.98, w / 2, h * 0.1, 4, INK);
    r.line(w / 2, h * 0.05, w * 0.2, h * 0.5, 4, INK);
    r.line(w / 2, h * 0.05, w * 0.8, h * 0.5, 4, INK);
    r.line(w * 0.2, h * 0.5, w * 0.8, h * 0.5, 4, INK);
  },
  scaleBar({ r, w, h }) {
    for (let i = 0; i < 5; i++) r.fillRect((w * i) / 5, 0, w / 5, h, i % 2 === 0 ? INK : FILL);
    r.strokeRect(0, 0, w, h, 3, INK);
  },
};

const assets = [
  { path: 'Furnish/Seating/sofa-2-seat', name: 'Sofa, 2 seats', size: { width: 1800, height: 900 }, draw: symbols.sofa, tags: ['sofa', 'couch'] },
  { path: 'Furnish/Seating/armchair', name: 'Armchair', size: { width: 900, height: 900 }, draw: symbols.armchair },
  { path: 'Furnish/Tables/dining-table-6', name: 'Dining table, 6 seats', size: { width: 1800, height: 1000 }, draw: (c) => symbols.table(c, 6) },
  { path: 'Furnish/Tables/coffee-table', name: 'Coffee table', size: { width: 1200, height: 600 }, draw: symbols.coffeeTable },
  { path: 'Furnish/Storage/wardrobe', name: 'Wardrobe', size: { width: 1200, height: 600 }, draw: symbols.wardrobe },
  { path: 'Furnish/Beds/double-bed', name: 'Double bed', size: { width: 1600, height: 2000 }, draw: (c) => symbols.bed(c, false) },
  { path: 'Furnish/Beds/single-bed', name: 'Single bed', size: { width: 900, height: 2000 }, draw: (c) => symbols.bed(c, true) },
  { path: 'Furnish/Kitchen/kitchen-counter', name: 'Kitchen counter', size: { width: 2400, height: 600 }, draw: symbols.counter },
  { path: 'Furnish/Bathroom/bathtub', name: 'Bathtub', size: { width: 1700, height: 750 }, draw: symbols.bathtub },
  { path: 'Furnish/Bathroom/wc', name: 'WC', size: { width: 400, height: 700 }, draw: symbols.wc },
  { path: 'Furnish/Bathroom/washbasin', name: 'Washbasin', size: { width: 600, height: 450 }, draw: symbols.basin },
  { path: 'Furnish/Lighting/pendant-lamp', name: 'Pendant lamp', size: { width: 400, height: 400 }, draw: symbols.lamp },
  { path: 'Equip/Kitchen Equipment/fridge', name: 'Fridge', size: { width: 700, height: 700 }, draw: symbols.fridge },
  { path: 'Equip/Electrical/distribution-board', name: 'Distribution board', size: { width: 600, height: 250 }, draw: symbols.panel },
  { path: 'Populate/People/person-standing', name: 'Person, standing', size: { width: 600, height: 400 }, draw: symbols.person },
  { path: 'Populate/Vehicles/car', name: 'Car', size: { width: 1800, height: 4500 }, draw: symbols.car },
  { path: 'Populate/Plants/tree-medium', name: 'Tree, medium', size: { width: 3000, height: 3000 }, draw: symbols.tree },
  { path: 'Site/Street Furniture/bench', name: 'Bench', size: { width: 1800, height: 500 }, draw: symbols.bench },
  { path: 'Draw/North Arrows/north-arrow', name: 'North arrow', size: { width: 600, height: 900 }, draw: symbols.northArrow },
  { path: 'Draw/Scale Bars/scale-bar-5m', name: 'Scale bar, 5 m', size: { width: 5000, height: 300 }, draw: symbols.scaleBar },
];

const folders = [
  'Furnish/Seating', 'Furnish/Tables', 'Furnish/Storage', 'Furnish/Beds', 'Furnish/Kitchen', 'Furnish/Bathroom', 'Furnish/Lighting',
  'Equip/Kitchen Equipment', 'Equip/Bathroom Fixtures', 'Equip/Electrical', 'Equip/HVAC', 'Equip/Plumbing', 'Equip/Fire Safety', 'Equip/Specialty Equipment',
  'Populate/People', 'Populate/Vehicles', 'Populate/Plants', 'Populate/Animals',
  'Site/Landscape', 'Site/Roads', 'Site/Parking', 'Site/Fences & Gates', 'Site/Street Furniture', 'Site/Context Buildings',
  'Draw/Symbols', 'Draw/Hatches', 'Draw/Patterns', 'Draw/Line Types', 'Draw/Annotations', 'Draw/North Arrows', 'Draw/Scale Bars',
];

rmSync(OUT, { recursive: true, force: true });
for (const asset of assets) {
  const dir = path.join(OUT, ...asset.path.split('/'));
  mkdirSync(dir, { recursive: true });
  const canvas = canvasFor(asset.size);
  asset.draw(canvas);
  writeFileSync(path.join(dir, '2d.png'), encodePng(canvas.r));
}
const manifest = {
  version: 1,
  source: 'archai-dev-catalog',
  folders,
  // Placeholders carry no 3D model yet; production entries point at "3d.glb".
  assets: assets.map(({ path: p, name, size, tags }) => ({ path: p, name, image: '2d.png', model: null, size, ...(tags ? { tags } : {}) })),
};
writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${assets.length} assets and ${folders.length} folders to ${OUT}`);
