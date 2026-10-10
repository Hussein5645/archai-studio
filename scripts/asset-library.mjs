// Builds the ArchAI asset library (CC0 models from Poly Haven) as .CAI packages for the board's
// Assets tab and ArchAI Render's entourage:
//   node scripts/asset-library.mjs <work dir>
// For each model: a full model (simplified to a triangle budget), a low level of detail model, a
// top view rendered from the model (for the board when the model cannot load) and the Poly Haven
// thumbnail as preview. Writes <work dir>/out/assets/<folder>/<id>.cai, <id>.top.png and
// <id>.preview.png plus <work dir>/out/assets/index.json (the inline catalog entries, see
// docs/cai-format.md "R2 index"). Upload with scripts/asset-library-upload.mjs.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { chromium } from 'playwright';

const work = process.argv[2];
if (!work) throw new Error('usage: node scripts/asset-library.mjs <work dir>');
const out = join(work, 'out', 'assets');
const cache = join(work, 'cache');
const UA = { 'User-Agent': 'ArchAI-asset-library/1.0 (https://archai-studio-six.vercel.app)' };
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;

const TREES = 'Populate/Plants/Trees';
const SHRUBS = 'Populate/Plants/Shrubs & Grass';
const POTTED = 'Populate/Plants/Potted';
// [Poly Haven id, name, library folder]. Ids match the ArchAI Render library's entourage ids.
export const MODELS = [
  ['tree_small_02', 'Small tree', TREES],
  ['jacaranda_tree', 'Jacaranda', TREES],
  ['island_tree_01', 'Broadleaf tree', TREES],
  ['island_tree_02', 'Round broadleaf tree', TREES],
  ['island_tree_03', 'Tall broadleaf tree', TREES],
  ['fir_tree_01', 'Fir', TREES],
  ['pine_tree_01', 'Pine', TREES],
  ['searsia_lucida', 'Searsia shrub tree', TREES],
  ['quiver_tree_02', 'Quiver tree', TREES],
  ['fir_sapling_medium', 'Young fir', TREES],
  ['pine_sapling_medium', 'Young pine', TREES],
  ['shrub_01', 'Shrub', SHRUBS],
  ['shrub_04', 'Low shrub', SHRUBS],
  ['shrub_sorrel_01', 'Sorrel shrub', SHRUBS],
  ['fern_02', 'Fern', SHRUBS],
  ['grass_medium_01', 'Grass clump', SHRUBS],
  ['grass_medium_02', 'Grass tuft', SHRUBS],
  ['grass_bermuda_01', 'Bermuda grass', SHRUBS],
  ['calathea_orbifolia_01', 'Calathea', SHRUBS],
  ['anthurium_botany_01', 'Anthurium', SHRUBS],
  ['pachira_aquatica_01', 'Money tree', SHRUBS],
  ['potted_plant_01', 'Small potted plant', POTTED],
  ['potted_plant_02', 'Potted plant', POTTED],
  ['potted_plant_04', 'Tall potted plant', POTTED],
  ['planter_box_01', 'Planter box', POTTED],
  ['planter_box_02', 'Long planter box', POTTED],
  ['planter_box_03', 'Square planter', POTTED],
  ['sofa_02', 'Sofa', 'Furnish/Seating'],
  ['sofa_03', 'Corner sofa', 'Furnish/Seating'],
  ['Sofa_01', 'Classic sofa', 'Furnish/Seating'],
  ['modern_arm_chair_01', 'Armchair', 'Furnish/Seating'],
  ['GreenChair_01', 'Green armchair', 'Furnish/Seating'],
  ['ArmChair_01', 'Club armchair', 'Furnish/Seating'],
  ['mid_century_lounge_chair', 'Lounge chair', 'Furnish/Seating'],
  ['Ottoman_01', 'Ottoman', 'Furnish/Seating'],
  ['dining_chair_02', 'Dining chair', 'Furnish/Seating'],
  ['WoodenChair_01', 'Wooden chair', 'Furnish/Seating'],
  ['painted_wooden_chair_01', 'Painted chair', 'Furnish/Seating'],
  ['bar_chair_round_01', 'Bar stool', 'Furnish/Seating'],
  ['wooden_stool_02', 'Wooden stool', 'Furnish/Seating'],
  ['chinese_armchair', 'Carved armchair', 'Furnish/Seating'],
  ['wooden_table_02', 'Dining table', 'Furnish/Tables'],
  ['round_wooden_table_01', 'Round table', 'Furnish/Tables'],
  ['dining_table', 'Long dining table', 'Furnish/Tables'],
  ['coffee_table_round_01', 'Coffee table', 'Furnish/Tables'],
  ['CoffeeTable_01', 'Low coffee table', 'Furnish/Tables'],
  ['modern_coffee_table_01', 'Modern coffee table', 'Furnish/Tables'],
  ['modern_coffee_table_02', 'Glass coffee table', 'Furnish/Tables'],
  ['side_table_01', 'Side table', 'Furnish/Tables'],
  ['side_table_tall_01', 'Tall side table', 'Furnish/Tables'],
  ['ClassicConsole_01', 'Console table', 'Furnish/Tables'],
  ['small_wooden_table_01', 'Small table', 'Furnish/Tables'],
  ['metal_office_desk', 'Office desk', 'Furnish/Tables'],
  ['GothicCabinet_01', 'Tall cabinet', 'Furnish/Storage'],
  ['GothicCommode_01', 'Commode', 'Furnish/Storage'],
  ['vintage_cabinet_01', 'Glass cabinet', 'Furnish/Storage'],
  ['modern_wooden_cabinet', 'Sideboard', 'Furnish/Storage'],
  ['wooden_display_shelves_01', 'Display shelves', 'Furnish/Storage'],
  ['steel_frame_shelves_01', 'Steel shelves', 'Furnish/Storage'],
  ['Shelf_01', 'Wall shelf', 'Furnish/Storage'],
  ['drawer_cabinet', 'Drawer cabinet', 'Furnish/Storage'],
  ['ClassicNightstand_01', 'Nightstand', 'Furnish/Storage'],
  ['GothicBed_01', 'Double bed', 'Furnish/Beds'],
  ['vintage_day_bed', 'Day bed', 'Furnish/Beds'],
  ['modern_ceiling_lamp_01', 'Pendant lamp', 'Furnish/Lighting'],
  ['Chandelier_01', 'Chandelier', 'Furnish/Lighting'],
  ['Chandelier_03', 'Crystal chandelier', 'Furnish/Lighting'],
  ['hanging_industrial_lamp', 'Industrial pendant', 'Furnish/Lighting'],
  ['industrial_wall_lamp', 'Wall lamp', 'Furnish/Lighting'],
  ['desk_lamp_arm_01', 'Desk lamp', 'Furnish/Lighting'],
  ['ceramic_vase_01', 'Ceramic vase', 'Furnish/Decor'],
  ['brass_vase_03', 'Brass vase', 'Furnish/Decor'],
  ['marble_bust_01', 'Marble bust', 'Furnish/Decor'],
  ['decorative_book_set_01', 'Book set', 'Furnish/Decor'],
  ['throw_pillows_01', 'Throw pillows', 'Furnish/Decor'],
  ['fancy_picture_frame_01', 'Picture frame', 'Furnish/Decor'],
  ['ornate_mirror_01', 'Mirror', 'Furnish/Decor'],
  ['Television_01', 'Television', 'Furnish/Decor'],
  ['electric_stove', 'Electric stove', 'Equip/Kitchen Equipment'],
  ['CoffeeCart_01', 'Coffee cart', 'Equip/Kitchen Equipment'],
  ['exterior_aircon_unit', 'Outdoor AC unit', 'Equip/HVAC'],
  ['ceiling_fan', 'Ceiling fan', 'Equip/HVAC'],
  ['street_lamp_01', 'Street lamp', 'Site/Street Furniture'],
  ['street_lamp_02', 'Double street lamp', 'Site/Street Furniture'],
  ['modular_street_seating', 'Street seating', 'Site/Street Furniture'],
  ['wooden_picnic_table', 'Picnic table', 'Site/Street Furniture'],
  ['outdoor_table_chair_set_01', 'Café set', 'Site/Street Furniture'],
  ['fire_hydrant', 'Fire hydrant', 'Site/Street Furniture'],
  ['concrete_road_barrier', 'Road barrier', 'Site/Street Furniture'],
  ['utility_box_02', 'Utility box', 'Site/Street Furniture'],
  ['stone_fire_pit', 'Fire pit', 'Site/Landscape'],
];

/** Triangle budgets: full model and low level of detail. Photoscanned trees have millions. */
const budget = (folder) => (folder === TREES ? [150_000, 12_000] : folder.startsWith('Populate/Plants') ? [60_000, 6_000] : [50_000, 5_000]);

async function get(url, file) {
  if (file && existsSync(file)) return readFileSync(file);
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: UA });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (file) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
      return bytes;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}
const json = async (url) => JSON.parse((await get(url)).toString('utf8'));
const triangles = (document) => document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** One GLB at a triangle budget (positions stay plain floats so every reader can use them). */
async function build(main, target) {
  const document = await io.read(main);
  const before = triangles(document);
  const ratio = Math.min(1, target / before);
  await document.transform(dedup(), weld(), ...(ratio < 1 ? [simplify({ simplifier: MeshoptSimplifier, ratio, error: ratio < 0.05 ? 0.02 : 0.004, lockBorder: false })] : []), prune());
  return { document, glb: await io.writeBinary(document), before, after: triangles(document) };
}

// A local page with three.js renders the top views (transparent background, like the app's).
const root = resolve('.');
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  if (path === '/render.html') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.outputColorSpace = THREE.SRGBColorSpace;
window.renderTop = async (base64, size) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0aa, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(3, 10, 2);
  scene.add(sun, gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const c = box.getCenter(new THREE.Vector3());
  const e = box.getSize(new THREE.Vector3());
  const hw = Math.max(e.x / 2, 1e-3), hh = Math.max(e.z / 2, 1e-3);
  const cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.01, e.y + 20);
  cam.up.set(0, 0, -1);
  cam.position.set(c.x, box.max.y + 5, c.z);
  cam.lookAt(c.x, c.y, c.z);
  cam.updateProjectionMatrix();
  const w = hw >= hh ? size : Math.max(1, Math.round(size * hw / hh));
  const h = hw >= hh ? Math.max(1, Math.round(size * hh / hw)) : size;
  gl.setSize(w, h, false);
  gl.setClearColor(0x000000, 0);
  gl.render(scene, cam);
  return gl.domElement.toDataURL('image/png');
};
window.ready = true;
</script>`);
    return;
  }
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/render.html`);
await page.waitForFunction(() => window.ready === true);

const index = [];
const failed = [];
for (const [id, name, folder] of MODELS) {
  if (only && !only.has(id)) continue;
  try {
    const files = await json(`https://api.polyhaven.com/files/${id}`);
    const gltf = files.gltf?.['1k']?.gltf ?? files.gltf?.['2k']?.gltf;
    if (!gltf) throw new Error('no glTF download');
    const dir = join(cache, 'models', id);
    const main = join(dir, gltf.url.split('/').pop());
    await get(gltf.url, main);
    for (const [relative, include] of Object.entries(gltf.include ?? {})) await get(include.url, join(dir, relative));
    const [high, low] = budget(folder);
    const full = await build(main, high);
    const lod = await build(main, low);
    // Real-world size from the full model (Poly Haven models are in metres, y up).
    const bounds = getBounds(full.document.getRoot().listScenes()[0]);
    const mm = (v) => Math.max(10, Math.round(v * 1000));
    const size = { width: mm(bounds.max[0] - bounds.min[0]), height: mm(bounds.max[2] - bounds.min[2]) };
    const modelHeight = mm(bounds.max[1] - bounds.min[1]);
    const topUrl = await page.evaluate(([data, px]) => window.renderTop(data, px), [Buffer.from(lod.glb).toString('base64'), 512]);
    const top = Buffer.from(topUrl.split(',')[1], 'base64');
    const preview = await get(`https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`, join(cache, 'thumbs', `${id}.png`));
    const metadata = {
      caiVersion: 1,
      id,
      name,
      category: folder,
      kind: 'asset',
      size,
      modelHeight,
      lod: { low: true },
      tags: [...new Set([folder.split('/').at(-1).toLowerCase(), ...(files.tags ?? [])])].slice(0, 12),
      source: `https://polyhaven.com/a/${id}`,
      license: 'CC0 (Poly Haven)',
    };
    const mapping = { version: 1, views: { top: 'views/top.png', preview: 'views/preview.png' }, models: { glb: 'models/model.glb', glbLow: 'models/model-low.glb' } };
    const cai = zipSync({
      'metadata.json': Buffer.from(JSON.stringify(metadata, null, 2)),
      'mapping.json': Buffer.from(JSON.stringify(mapping, null, 2)),
      'views/top.png': top,
      'views/preview.png': preview,
      'models/model.glb': full.glb,
      'models/model-low.glb': lod.glb,
    }, { level: 6 });
    const key = `${folder}/${id}.cai`;
    mkdirSync(join(out, folder), { recursive: true });
    writeFileSync(join(out, key), cai);
    writeFileSync(join(out, folder, `${id}.top.png`), top);
    writeFileSync(join(out, folder, `${id}.preview.png`), preview);
    index.push({ key, metadata, mapping, top: `${folder}/${id}.top.png`, preview: `${folder}/${id}.preview.png` });
    console.log(id.padEnd(28), `${(cai.byteLength / 1048576).toFixed(1)} MB`, `${size.width}x${size.height}x${modelHeight} mm`, `${Math.round(full.before)} -> ${Math.round(full.after)} / ${Math.round(lod.after)} tris`);
  } catch (error) {
    failed.push(id);
    console.warn('SKIPPED', id, error instanceof Error ? error.message : error);
  }
}
await browser.close();
server.close();
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2));
console.log(`${index.length} packages, ${failed.length} skipped${failed.length ? `: ${failed.join(', ')}` : ''}`);
