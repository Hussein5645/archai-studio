// Builds ArchAI's default material library (CC0 scanned PBR materials from Poly Haven) for the
// Materials panel and ArchAI Render:
//   node scripts/material-library.mjs <work dir> [id,id...]
// Each material becomes a material pack (.cai, kind "materials", docs/materials.md) with its 1k
// colour, normal, roughness, AO and metal maps and its real-world tile size. Writes
// <work dir>/out/materials/{library.json, packs/<id>.cai, thumbs/<id>.png}; upload the folder to
// archai-assets/materials/ (scripts/r2-upload.mjs).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zipSync } from 'fflate';

const work = process.argv[2];
if (!work) throw new Error('usage: node scripts/material-library.mjs <work dir> [ids]');
const out = join(work, 'out', 'materials');
const cache = join(work, 'cache', 'materials');
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const UA = { 'User-Agent': 'ArchAI-material-library/1.0 (https://archai-studio-six.vercel.app)' };

// [Poly Haven id, name, ArchAI category, library group]
const MATERIALS = [
  ['red_brick', 'Red brick', 'masonry', 'Brick'],
  ['red_brick_03', 'Clean red brick', 'masonry', 'Brick'],
  ['brick_wall_001', 'Brown brick', 'masonry', 'Brick'],
  ['large_red_bricks', 'Large red brick', 'masonry', 'Brick'],
  ['factory_brick', 'Factory brick', 'masonry', 'Brick'],
  ['brick_wall_006', 'Weathered brick', 'masonry', 'Brick'],
  ['red_bricks_04', 'Rustic red brick', 'masonry', 'Brick'],
  ['sandstone_blocks_05', 'Sandstone blocks', 'masonry', 'Brick'],
  ['concrete_brick_wall_001', 'Concrete blocks', 'masonry', 'Brick'],
  ['plaster_brick_pattern', 'Painted brick', 'masonry', 'Brick'],
  ['medieval_blocks_03', 'Stone blocks', 'masonry', 'Brick'],
  ['concrete_floor_02', 'Concrete', 'concrete', 'Concrete'],
  ['concrete_floor_01', 'Smooth concrete', 'concrete', 'Concrete'],
  ['concrete_wall_003', 'Concrete wall', 'concrete', 'Concrete'],
  ['concrete', 'Raw concrete', 'concrete', 'Concrete'],
  ['concrete_wall_007', 'Formwork concrete', 'concrete', 'Concrete'],
  ['brushed_concrete', 'Brushed concrete', 'concrete', 'Concrete'],
  ['painted_concrete', 'Painted concrete floor', 'concrete', 'Concrete'],
  ['gravel_embedded_concrete', 'Exposed aggregate', 'concrete', 'Concrete'],
  ['concrete_floor_worn_001', 'Worn concrete floor', 'concrete', 'Concrete'],
  ['granular_concrete', 'Polished concrete', 'concrete', 'Concrete'],
  ['hexagonal_concrete_paving', 'Hexagonal paving', 'concrete', 'Concrete'],
  ['laminate_floor_02', 'Oak floor', 'wood', 'Wood'],
  ['laminate_floor_03', 'Light wood floor', 'wood', 'Wood'],
  ['wood_floor', 'Walnut floor', 'wood', 'Wood'],
  ['oak_veneer_01', 'Oak veneer', 'wood', 'Wood'],
  ['dark_wood', 'Dark wood', 'wood', 'Wood'],
  ['kitchen_wood', 'Kitchen wood', 'wood', 'Wood'],
  ['plywood', 'Plywood', 'wood', 'Wood'],
  ['wood_floor_deck', 'Wood decking', 'wood', 'Wood'],
  ['brown_planks_03', 'Wood cladding', 'wood', 'Wood'],
  ['weathered_planks', 'Weathered planks', 'wood', 'Wood'],
  ['rosewood_veneer1', 'Rosewood veneer', 'wood', 'Wood'],
  ['fine_grained_wood', 'Fine grained wood', 'wood', 'Wood'],
  ['wood_table_001', 'Wood tabletop', 'wood', 'Wood'],
  ['synthetic_wood', 'Composite cladding', 'wood', 'Wood'],
  ['beige_wall_001', 'Beige render', 'finish', 'Plaster'],
  ['white_plaster_02', 'White plaster', 'finish', 'Plaster'],
  ['grey_plaster', 'Grey plaster', 'finish', 'Plaster'],
  ['plastered_wall', 'Plastered wall', 'finish', 'Plaster'],
  ['white_stucco', 'White stucco', 'finish', 'Plaster'],
  ['plastered_wall_02', 'Rough render', 'finish', 'Plaster'],
  ['red_plaster_weathered', 'Terracotta plaster', 'finish', 'Plaster'],
  ['marble_01', 'White marble', 'stone', 'Stone'],
  ['granite_tile', 'Granite', 'stone', 'Stone'],
  ['stone_tiles_02', 'Stone tiles', 'stone', 'Stone'],
  ['castle_wall_slates', 'Slate wall', 'stone', 'Stone'],
  ['rustic_stone_wall_02', 'Rustic stone wall', 'stone', 'Stone'],
  ['japanese_stone_wall', 'Fieldstone wall', 'stone', 'Stone'],
  ['sandstone_cracks', 'Sandstone', 'stone', 'Stone'],
  ['stone_wall', 'Stone wall', 'stone', 'Stone'],
  ['floor_tiles_06', 'Square floor tiles', 'tile', 'Tiles'],
  ['floor_tiles_02', 'Patterned floor tiles', 'tile', 'Tiles'],
  ['tiled_floor_001', 'Grey floor tiles', 'tile', 'Tiles'],
  ['large_floor_tiles_02', 'Large floor tiles', 'tile', 'Tiles'],
  ['square_floor', 'Checker tiles', 'tile', 'Tiles'],
  ['floor_tiles_08', 'Ceramic tiles', 'tile', 'Tiles'],
  ['terrazzo_tiles', 'Terrazzo', 'tile', 'Tiles'],
  ['terracotta_floor_tiles', 'Terracotta tiles', 'tile', 'Tiles'],
  ['rectangular_facade_tiles', 'Facade tiles', 'tile', 'Tiles'],
  ['large_grey_tiles', 'Outdoor tiles', 'tile', 'Tiles'],
  ['rubber_tiles', 'Rubber flooring', 'tile', 'Tiles'],
  ['metal_plate', 'Checker plate', 'metal', 'Metal'],
  ['corrugated_iron', 'Corrugated metal', 'metal', 'Metal'],
  ['blue_metal_plate', 'Painted metal', 'metal', 'Metal'],
  ['metal_plate_02', 'Metal plate', 'metal', 'Metal'],
  ['rusty_metal_02', 'Rusty metal', 'metal', 'Metal'],
  ['rust_coarse_01', 'Corten steel', 'metal', 'Metal'],
  ['painted_metal_shutter', 'Metal shutter', 'metal', 'Metal'],
  ['box_profile_metal_sheet', 'Box profile cladding', 'metal', 'Metal'],
  ['fabric_pattern_07', 'Patterned fabric', 'fabric', 'Fabric'],
  ['leather_white', 'White leather', 'fabric', 'Fabric'],
  ['brown_leather', 'Brown leather', 'fabric', 'Fabric'],
  ['velour_velvet', 'Velvet', 'fabric', 'Fabric'],
  ['rough_linen', 'Linen', 'fabric', 'Fabric'],
  ['poly_wool_herringbone', 'Wool herringbone', 'fabric', 'Fabric'],
  ['dirty_carpet', 'Carpet', 'fabric', 'Fabric'],
  ['ribbed_corduroy', 'Corduroy', 'fabric', 'Fabric'],
  ['roof_slates_03', 'Roof slates', 'other', 'Roofing'],
  ['clay_roof_tiles_02', 'Clay roof tiles', 'other', 'Roofing'],
  ['grey_roof_tiles_02', 'Grey roof tiles', 'other', 'Roofing'],
  ['ceramic_roof_01', 'Ceramic roof', 'other', 'Roofing'],
  ['roof_tiles_14', 'Concrete roof tiles', 'other', 'Roofing'],
  ['asphalt_02', 'Asphalt', 'other', 'Ground'],
  ['asphalt_track', 'Smooth asphalt', 'other', 'Ground'],
  ['pavement_03', 'Brick pavers', 'other', 'Ground'],
  ['t_brick_floor_002', 'Herringbone pavers', 'other', 'Ground'],
  ['leafy_grass', 'Grass', 'other', 'Ground'],
  ['grass_path_2', 'Grass path', 'other', 'Ground'],
  ['sand_01', 'Sand', 'other', 'Ground'],
  ['forrest_ground_01', 'Forest floor', 'other', 'Ground'],
  ['gravelly_sand', 'Gravel', 'other', 'Ground'],
  ['rocky_trail', 'Rocky path', 'other', 'Ground'],
  ['snow_02', 'Snow', 'other', 'Ground'],
];

const CHANNELS = [['Diffuse', 'map'], ['nor_gl', 'normalMap'], ['Rough', 'roughnessMap'], ['AO', 'aoMap'], ['Metal', 'metalnessMap']];

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

/** Pixel size of a JPEG (its SOF marker). */
function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return { width: 0, height: 0 };
    const marker = bytes[i + 1];
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    i += 2 + length;
  }
  return { width: 0, height: 0 };
}

mkdirSync(join(out, 'packs'), { recursive: true });
mkdirSync(join(out, 'thumbs'), { recursive: true });
const assets = JSON.parse((await get('https://api.polyhaven.com/assets?t=textures', join(cache, 'assets.json'))).toString('utf8'));
const library = { version: 1, credit: 'Poly Haven (CC0)', groups: [...new Set(MATERIALS.map((m) => m[3]))], materials: [] };
for (const [id, name, category, group] of MATERIALS) {
  if (only && !only.has(id)) continue;
  try {
    const info = assets[id];
    if (!info) throw new Error('not in the library');
    const files = JSON.parse((await get(`https://api.polyhaven.com/files/${id}`, join(cache, id, 'files.json'))).toString('utf8'));
    const textures = {};
    const zip = {};
    const material = { id: `lib-${id}`.slice(0, 64), name, category, color: '#ffffff', roughness: 1, metalness: 0, source: `library:${id}` };
    for (const [key, channel] of CHANNELS) {
      const entry = Object.entries(files).find(([n]) => n.toLowerCase() === key.toLowerCase())?.[1];
      const file = entry?.['1k']?.jpg;
      if (!file) continue;
      const data = await get(file.url, join(cache, id, `${channel}.jpg`));
      const blobId = `${id}-${channel}`.slice(0, 64);
      const path = `textures/${blobId}.jpg`;
      zip[path] = data;
      textures[blobId] = { path, mime: 'image/jpeg', ...jpegSize(data) };
      material[channel] = { blobId };
    }
    if (!material.map) throw new Error('no colour map');
    if (material.metalnessMap) material.metalness = 1;
    const [w, h] = Array.isArray(info.dimensions) && info.dimensions[0] > 1 ? info.dimensions : [1000, 1000];
    material.tileWidth = Math.max(10, Math.round(w));
    material.tileHeight = Math.max(10, Math.round(h > 1 ? h : w));
    const metadata = { caiVersion: 1, kind: 'materials', id: `library-${id}`, name, materials: [material], textures };
    zip['metadata.json'] = Buffer.from(JSON.stringify(metadata, null, 2));
    const pack = zipSync(zip, { level: 0 });
    writeFileSync(join(out, 'packs', `${id}.cai`), pack);
    writeFileSync(join(out, 'thumbs', `${id}.png`), await get(`https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=160&height=160`, join(cache, id, 'thumb.png')));
    library.materials.push({ id, name, category, group, tags: (info.tags ?? []).slice(0, 10), size: [material.tileWidth, material.tileHeight], pack: `packs/${id}.cai`, thumb: `thumbs/${id}.png`, bytes: pack.byteLength, source: `https://polyhaven.com/a/${id}` });
    console.log(id.padEnd(28), (pack.byteLength / 1048576).toFixed(1), 'MB', `${material.tileWidth}x${material.tileHeight} mm`, Object.keys(textures).length, 'maps');
  } catch (error) {
    console.warn('SKIPPED', id, error instanceof Error ? error.message : error);
  }
}
writeFileSync(join(out, 'library.json'), JSON.stringify(library, null, 2));
console.log(library.materials.length, 'materials');
