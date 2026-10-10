// Builds the ArchAI Render library (sky HDRIs and entourage models, all CC0 from Poly Haven):
//   node scripts/render-library.mjs <work dir>
// Downloads each asset, packs models into single binary glTF files (1k textures), and writes
// <work dir>/out/render/{library.json, hdri/*.hdr, models/*.glb, thumbs/*.png} ready to upload to
// the archai-assets bucket (see docs/render-studio.md).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const work = process.argv[2];
if (!work) throw new Error('usage: node scripts/render-library.mjs <work dir>');
const out = join(work, 'out', 'render');
const cache = join(work, 'cache');
const UA = { 'User-Agent': 'ArchAI-render-library/1.0 (https://archai-studio-six.vercel.app)' };

const HDRIS = [
  ['kloofendal_48d_partly_cloudy_puresky', 'Clear day'],
  ['autumn_field_puresky', 'Bright sky'],
  ['belfast_sunset_puresky', 'Sunset'],
  ['kiara_1_dawn', 'Dawn'],
  ['overcast_soil_puresky', 'Overcast'],
  ['canary_wharf', 'City'],
  ['moonless_golf', 'Night'],
  ['brown_photostudio_02', 'Studio'],
];
const MODELS = [
  ['tree_small_02', 'Small tree', 'Trees'],
  ['jacaranda_tree', 'Jacaranda', 'Trees'],
  ['island_tree_02', 'Broadleaf tree', 'Trees'],
  ['fir_tree_01', 'Fir', 'Trees'],
  ['pine_tree_01', 'Pine', 'Trees'],
  ['shrub_01', 'Shrub', 'Shrubs & grass'],
  ['shrub_sorrel_01', 'Sorrel shrub', 'Shrubs & grass'],
  ['fern_02', 'Fern', 'Shrubs & grass'],
  ['grass_medium_02', 'Grass tuft', 'Shrubs & grass'],
  ['potted_plant_02', 'Potted plant', 'Potted plants'],
  ['potted_plant_04', 'Tall potted plant', 'Potted plants'],
  ['potted_plant_01', 'Small potted plant', 'Potted plants'],
  ['planter_box_01', 'Planter box', 'Potted plants'],
  ['street_lamp_01', 'Street lamp', 'Outdoor'],
  ['outdoor_table_chair_set_01', 'Café set', 'Outdoor'],
  ['modular_street_seating', 'Street seating', 'Outdoor'],
  ['wooden_picnic_table', 'Picnic table', 'Outdoor'],
  ['sofa_02', 'Sofa', 'Interior'],
  ['modern_arm_chair_01', 'Armchair', 'Interior'],
  ['coffee_table_round_01', 'Coffee table', 'Interior'],
];

async function get(url, file) {
  if (file && existsSync(file)) return readFileSync(file);
  const response = await fetch(url, { headers: UA });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return bytes;
}
const json = async (url) => JSON.parse((await get(url)).toString('utf8'));

for (const dir of ['hdri', 'models', 'thumbs']) mkdirSync(join(out, dir), { recursive: true });
const library = { version: 1, credit: 'Poly Haven (CC0)', hdris: [], entourage: [] };

for (const [id, name] of HDRIS) {
  const files = await json(`https://api.polyhaven.com/files/${id}`);
  const hdr = files.hdri['2k'].hdr;
  writeFileSync(join(out, 'hdri', `${id}.hdr`), await get(hdr.url, join(cache, 'hdri', `${id}.hdr`)));
  writeFileSync(join(out, 'thumbs', `${id}.png`), await get(`https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=128`, join(cache, 'thumbs', `${id}.png`)));
  library.hdris.push({ id, name, url: `hdri/${id}.hdr`, thumb: `thumbs/${id}.png`, source: `https://polyhaven.com/a/${id}` });
  console.log('hdri', id, (hdr.size / 1048576).toFixed(1), 'MB');
}

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
// Triangle budgets: photoscanned trees come with millions of triangles, too many for a live view.
const budget = (category) => (category === 'Trees' ? 400_000 : 80_000);
const triangles = (document) => document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);
for (const [id, name, category] of MODELS) {
  const files = await json(`https://api.polyhaven.com/files/${id}`);
  const gltf = files.gltf['1k'].gltf;
  const folder = join(cache, 'models', id);
  const main = join(folder, `${id}.gltf`);
  await get(gltf.url, main);
  for (const [relative, include] of Object.entries(gltf.include ?? {})) await get(include.url, join(folder, relative));
  const document = await io.read(main);
  // Real-world height (measured before quantisation) for placement previews (Poly Haven models are in metres).
  const bounds = document.getRoot().listScenes()[0];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of bounds.listChildren()) {
    node.traverse((n) => {
      const mesh = n.getMesh();
      if (!mesh) return;
      const world = n.getWorldMatrix();
      for (const primitive of mesh.listPrimitives()) {
        const position = primitive.getAttribute('POSITION');
        if (!position) continue;
        const min = position.getMin([]);
        const max = position.getMax([]);
        // Bounding box corners through the node's world matrix (good enough for a height).
        for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
          const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
          minY = Math.min(minY, wy);
          maxY = Math.max(maxY, wy);
        }
      }
    });
  }
  const before = triangles(document);
  const ratio = Math.min(1, budget(category) / before);
  await document.transform(dedup(), weld(), ...(ratio < 1 ? [simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002, lockBorder: false })] : []), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const glb = await io.writeBinary(document);
  writeFileSync(join(out, 'models', `${id}.glb`), glb);
  writeFileSync(join(out, 'thumbs', `${id}.png`), await get(`https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`, join(cache, 'thumbs', `${id}.png`)));
  library.entourage.push({ id, name, category, url: `models/${id}.glb`, thumb: `thumbs/${id}.png`, height: Math.round((maxY - minY) * 100) / 100, source: `https://polyhaven.com/a/${id}` });
  console.log('model', id, (glb.byteLength / 1048576).toFixed(1), 'MB', `${library.entourage.at(-1).height} m`, `${Math.round(before)} -> ${Math.round(triangles(document))} triangles`);
}

writeFileSync(join(out, 'library.json'), JSON.stringify(library, null, 2));
console.log('wrote', join(out, 'library.json'));
