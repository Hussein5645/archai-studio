import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const input = path.resolve(process.argv[2] ?? 'r2');
const output = path.resolve(process.argv[3] ?? path.join(input, 'catalog.json'));
const defaultFolders = [
  'Architecture/Openings/Doors',
  'Architecture/Openings/Windows',
  'Architecture/Structure/Columns',
  'Architecture/Structure/Walls',
  'Architecture/Structure/Stairs',
  'Architecture/Circulation/Stairs',
  'Architecture/Circulation/Ramps',
  'Architecture/Circulation/Railings',
  'Architecture/Envelope/Curtain Walls',
  'Architecture/Envelope/Screens',
  'Architecture/Envelope/Facade Elements',
  'Furnish/Seating',
  'Furnish/Tables',
  'Furnish/Storage',
  'Furnish/Beds',
  'Furnish/Kitchen',
  'Furnish/Bathroom',
  'Furnish/Lighting',
  'Equip/Kitchen Equipment',
  'Equip/Bathroom Fixtures',
  'Equip/Electrical',
  'Equip/HVAC',
  'Equip/Plumbing',
  'Equip/Fire Safety',
  'Equip/Specialty Equipment',
  'Populate/People',
  'Populate/Vehicles',
  'Populate/Plants',
  'Populate/Animals',
  'Site/Landscape',
  'Site/Roads',
  'Site/Parking',
  'Site/Fences & Gates',
  'Site/Street Furniture',
  'Site/Context Buildings',
  'Draw/Symbols',
  'Draw/Hatches',
  'Draw/Patterns',
  'Draw/Line Types',
  'Draw/Annotations',
  'Draw/North Arrows',
  'Draw/Scale Bars',
  'Personal/Favorites',
  'Personal/My Assets',
  'Personal/Imported',
  'Personal/Generated',
];

const SYSTEM_TYPES = ['wall', 'window', 'door', 'column', 'stair', 'railing', 'curtain-wall', 'facade-element', 'floor', 'ceiling'];
const SYSTEM_TOOL_FOLDERS = ['wall', 'column', 'door', 'window', 'stair', 'railing'];
const LINE_SYSTEM_TYPES = ['wall', 'railing', 'curtain-wall'];

/**
 * Per-tool parameter rules for `system.parameters`. Mirrors src/catalog/system-schemas.ts:
 * every provided key must be valid; missing keys take the app defaults.
 */
const oneOf = (values) => (value) => values.includes(value) || `expected one of ${values.join(', ')}`;
const positive = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0) || 'expected a positive number';
const nonNegative = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0) || 'expected a non-negative number';
const profile = (value) => (Array.isArray(value) && value.length >= 3 && value.every((point) => Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === 'number' && n >= 0 && n <= 1))) || 'expected at least three normalized [x,y] profile points';
const layers = (value) => {
  if (!Array.isArray(value) || value.length === 0) return 'expected a non-empty array of layers';
  for (const layer of value) {
    if (!layer || typeof layer !== 'object') return 'each layer must be an object';
    if (typeof layer.name !== 'string' || !layer.name.trim()) return 'each layer needs a name';
    if (!['finish', 'core'].includes(layer.role)) return 'layer.role must be finish or core';
    if (positive(layer.thickness) !== true) return 'layer.thickness must be a positive number';
  }
  if (!value.some((layer) => layer.role === 'core')) return 'walls need at least one core layer';
  return true;
};
const PARAMETER_RULES = {
  wall: { layers, locationLine: oneOf(['centre', 'inside', 'outside']), height: positive, elevation: nonNegative },
  column: { shape: oneOf(['rectangle', 'circle', 'custom']), width: positive, depth: positive, diameter: positive, height: positive, elevation: nonNegative, material: oneOf(['concrete', 'steel', 'timber']), profile },
  door: { operation: oneOf(['swing', 'double-swing', 'sliding', 'folding', 'revolving']), width: positive, handing: oneOf(['left', 'right']), openingSide: oneOf(['inside', 'outside']), threshold: nonNegative, height: positive },
  window: { mechanism: oneOf(['fixed', 'casement', 'sliding', 'awning', 'tilt-turn']), width: positive, height: positive, sill: nonNegative, openingDirection: oneOf(['inward', 'outward', 'none']) },
  stair: { width: positive, riserHeight: positive, treadDepth: positive, totalRise: positive, landingDepth: positive, treadStyle: oneOf(['open', 'closed-riser']), nosing: nonNegative, elevation: nonNegative, treadProfile: profile, riserProfile: profile },
  railing: { thickness: positive, height: positive, balusterSpacing: nonNegative, pattern: oneOf(['baluster', 'glass-panel', 'cable', 'solid']), elevation: nonNegative },
  'curtain-wall': { mullionSpacing: positive, panelSpacing: positive, panelType: oneOf(['glazed', 'opaque', 'mixed']), panelMaterial: oneOf(['glass', 'metal', 'stone', 'timber']), panelProfile: profile },
  'facade-element': { width: positive, height: positive, depth: positive, alignment: oneOf(['inside', 'middle', 'outside']), profile },
  floor: { thickness: positive, elevation: nonNegative, material: oneOf(['concrete', 'timber', 'tile', 'generic']) },
  ceiling: { thickness: positive, elevation: nonNegative, material: oneOf(['concrete', 'timber', 'tile', 'generic']) },
};

function validateParameters(type, parameters) {
  if (parameters === undefined) return;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('system.parameters must be an object');
  const rules = PARAMETER_RULES[type];
  for (const [key, value] of Object.entries(parameters)) {
    const rule = rules[key];
    if (!rule) throw new Error(`system.parameters.${key} is not a ${type} parameter (allowed: ${Object.keys(rules).join(', ')})`);
    const result = rule(value);
    if (result !== true) throw new Error(`system.parameters.${key}: ${result}`);
  }
}

function normalized(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return normalized(value);
}

function findFile(files, wanted) {
  const key = normalized(wanted).toLowerCase();
  const match = Object.entries(files).find(([name]) => normalized(name).toLowerCase() === key);
  if (!match) throw new Error(`Missing ${wanted}`);
  return match[1];
}

function readJson(files, name) {
  try {
    return JSON.parse(strFromU8(findFile(files, name)));
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(absolute);
      return entry.isFile() && entry.name.toLowerCase().endsWith('.cai') ? [absolute] : [];
    }),
  );
  return files.flat();
}

/**
 * Validates one package. `expectedTool` is set for files under `system/<tool>/`: the package
 * must then be a system package of that type. Regular packages need top + a model; placed system
 * types also need front and side; line-based system types (wall, railing, curtain wall) need a
 * section swatch and nothing else.
 */
function validatePackage(bytes, label, expectedTool = null) {
  const files = unzipSync(bytes);
  const metadata = readJson(files, 'metadata.json');
  const mapping = readJson(files, 'mapping.json');
  if (metadata?.caiVersion !== 1) throw new Error('metadata.json caiVersion must be 1');
  requiredString(metadata.id, 'metadata.id');
  requiredString(metadata.name, 'metadata.name');
  const systemType = metadata.system?.type ?? metadata.systemType;
  const isSystem = metadata.kind === 'system';
  if (isSystem && !SYSTEM_TYPES.includes(systemType)) {
    throw new Error(`System packages require metadata.system.type: ${SYSTEM_TYPES.join(', ')}`);
  }
  if (!isSystem && (metadata.system || metadata.systemType)) throw new Error('Regular assets cannot set system metadata');
  if (expectedTool && (!isSystem || systemType !== expectedTool)) {
    throw new Error(`Packages under system/${expectedTool}/ must be "${expectedTool}" system packages`);
  }
  if (isSystem && !expectedTool && SYSTEM_TOOL_FOLDERS.includes(systemType)) {
    process.stderr.write(`WARN ${label}: ${systemType} types belong in system/${systemType}/ (kept in the regular index for compatibility)\n`);
  }
  if (isSystem) validateParameters(systemType, metadata.system?.parameters);
  const presetPackage = Array.isArray(metadata.system?.presets) && metadata.system.presets.length > 0;
  if (metadata.system?.presets !== undefined) {
    // Any system package may carry named presets; each one is a selectable type for its tool.
    if (!Array.isArray(metadata.system.presets)) throw new Error('system.presets must be an array');
    const ids = new Set();
    for (const preset of metadata.system.presets) {
      requiredString(preset?.id, 'preset.id');
      requiredString(preset?.name, 'preset.name');
      if (ids.has(preset.id)) throw new Error(`duplicate preset id "${preset.id}"`);
      ids.add(preset.id);
      const { id, ...parameters } = preset;
      delete parameters.name;
      validateParameters(systemType, parameters);
      if (systemType === 'wall' && !parameters.layers) throw new Error(`preset "${id}" needs layers`);
    }
  }
  const category = isSystem && !metadata.category ? `system/${systemType}` : requiredString(metadata.category, 'metadata.category');
  const lineBased = isSystem && LINE_SYSTEM_TYPES.includes(systemType);
  if (!lineBased && !presetPackage && (!(metadata.size?.width > 0) || !(metadata.size?.height > 0))) {
    throw new Error('metadata.size must contain positive width and height');
  }
  if (mapping?.version !== 1) throw new Error('mapping.json version must be 1');
  const views = mapping?.views ?? {};
  for (const key of ['top', 'front', 'side', 'section']) {
    if (views[key] !== undefined) findFile(files, requiredString(views[key], `mapping.views.${key}`));
  }
  const glb = mapping?.models?.glb;
  const fbx = mapping?.models?.fbx;
  if (glb) findFile(files, requiredString(glb, 'mapping.models.glb'));
  if (fbx) findFile(files, requiredString(fbx, 'mapping.models.fbx'));
  // Preset packages describe parameters only; the tool draws them with its built-in geometry.
  if (presetPackage) return { category, label, systemType };
  if (lineBased) {
    if (!views.section && !views.top) throw new Error(`${systemType} packages require mapping.views.section (a cross-section swatch)`);
    return { category, label, systemType };
  }
  if (!views.top) throw new Error('mapping.views.top is required');
  if (!glb && !fbx) throw new Error('mapping.models requires a glb or fbx path');
  if (isSystem && (!views.front || !views.side)) throw new Error('System packages require top, front, and side orthographic views');
  return { category, label, systemType };
}

const packageFiles = await walk(input);
const packages = [];
const system = [];
const folders = new Set(defaultFolders);
let failed = false;

for (const filename of packageFiles.sort()) {
  const key = normalized(path.relative(input, filename));
  const segments = key.split('/');
  // system/<tool>/<type>.cai is a system type for that tool, never a library entry.
  const systemTool = segments[0]?.toLowerCase() === 'system' && segments.length === 3 ? segments[1] : null;
  try {
    if (segments[0]?.toLowerCase() === 'system' && !SYSTEM_TOOL_FOLDERS.includes(systemTool ?? '')) {
      throw new Error(`system/ packages must live in system/<tool>/ where tool is one of ${SYSTEM_TOOL_FOLDERS.join(', ')}`);
    }
    const result = validatePackage(new Uint8Array(await readFile(filename)), key, systemTool);
    if (systemTool) {
      system.push({ tool: systemTool, key });
    } else {
      packages.push({ key });
      folders.add(result.category);
    }
    process.stdout.write(`OK  ${key}${systemTool ? ` (system type for ${systemTool})` : ''}\n`);
  } catch (error) {
    failed = true;
    process.stderr.write(`ERR ${key}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

if (failed) {
  process.stderr.write('catalog.json was not changed because one or more packages are invalid.\n');
  process.exitCode = 1;
} else {
  const catalog = {
    version: 1,
    source: 'cloudflare-r2:archai-assets',
    folders: [...folders].sort(),
    packages,
    system,
  };
  await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${output} with ${packages.length} package(s) and ${system.length} system type(s).\n`);
}
