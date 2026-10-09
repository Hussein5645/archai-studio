// Renders the ArchAI plugin icon set (one design for every host app) to PNG and ICO files.
//   node plugins/icons/make-icons.mjs
// Each icon: the dark ArchAI tile with the white arch mark, plus a blue action badge
// (send to ArchAI, open .AIR, open in VR, open ArchAI on the web). `logo` is the tile alone.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'png');
mkdirSync(out, { recursive: true });
const mark = 'data:image/png;base64,' + readFileSync(join(here, '..', '..', 'public', 'brand', 'archai-mark.png')).toString('base64');

const INK = '#1F2126';
const ACCENT = '#2F6FED';
const stroke = 'fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"';
// Glyphs drawn in a 16-unit box centred on the badge.
const GLYPHS = {
  export: `<path d="M5 11 L11 5 M6.5 5 H11 V9.5" ${stroke}/>`,
  import: `<path d="M11 5 L5 11 M5 6.5 V11 H9.5" ${stroke}/>`,
  vr: `<rect x="3.2" y="5.2" width="9.6" height="6" rx="2" fill="#fff"/><circle cx="6" cy="8.2" r="1.25" fill="${ACCENT}"/><circle cx="10" cy="8.2" r="1.25" fill="${ACCENT}"/><circle cx="8" cy="11.4" r="1" fill="${ACCENT}"/>`,
  web: `<circle cx="8" cy="8" r="4.6" ${stroke} stroke-width="1.6"/><path d="M3.6 8 H12.4 M8 3.4 C5.6 6 5.6 10 8 12.6 M8 3.4 C10.4 6 10.4 10 8 12.6" ${stroke} stroke-width="1.3"/>`,
  sync: `<path d="M4.5 7 A3.6 3.6 0 0 1 11 5.6 M11.5 9 A3.6 3.6 0 0 1 5 10.4 M11 3.6 V5.8 H8.8 M5 12.4 V10.2 H7.2" ${stroke} stroke-width="1.7"/>`,
};

function svg(name) {
  const tile = `<rect x="1" y="1" width="30" height="30" rx="7.5" fill="${INK}"/>`;
  if (name === 'logo') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${tile}<image href="${mark}" x="5" y="5" width="22" height="22" style="filter:invert(1)"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${tile}
    <image href="${mark}" x="2.5" y="2" width="19" height="19" style="filter:invert(1)"/>
    <circle cx="23" cy="23" r="8.2" fill="${ACCENT}" stroke="${INK}" stroke-width="1.6"/>
    <g transform="translate(15 15)">${GLYPHS[name]}</g></svg>`;
}

const NAMES = ['logo', ...Object.keys(GLYPHS)];
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const rendered = {};
for (const name of NAMES) {
  rendered[name] = {};
  for (const size of SIZES) {
    await page.setContent(`<html><body style="margin:0;background:transparent"><div id="i" style="width:${size}px;height:${size}px">${svg(name).replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete) && [...document.querySelectorAll('image')].length >= 0);
    await page.waitForTimeout(30);
    const png = await page.locator('#i').screenshot({ omitBackground: true });
    rendered[name][size] = png;
    writeFileSync(join(out, `${name}-${size}.png`), png);
  }
  writeFileSync(join(out, `${name}.svg`), svg(name));
}
await browser.close();

// Windows icons (Rhino panels, installers): PNG-compressed ICO entries.
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, png], i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(([, png]) => png)]);
}
for (const name of NAMES) writeFileSync(join(out, `${name}.ico`), ico([16, 24, 32, 48, 256].map((s) => [s, rendered[name][s]])));
console.log(`Wrote ${NAMES.length} icons x ${SIZES.length} sizes to ${out}`);
