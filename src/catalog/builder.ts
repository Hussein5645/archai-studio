import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { recipeFromFiles, type ParametricRecipe } from './parametric';
import { CaiMappingSchema, CaiMetadataSchema, checkPackageContents, type CaiMapping, type CaiMetadata, type ViewStyleName } from './cai';

export interface CaiPackageFile {
  name: string;
  bytes: Uint8Array;
}

export interface CreateCaiPackageInput {
  metadata: CaiMetadata;
  /** Plan symbol / footprint. Optional only for line-based system types that ship a section swatch. */
  topView?: CaiPackageFile;
  frontView?: CaiPackageFile;
  sideView?: CaiPackageFile;
  /** Cross-section swatch for wall / railing / curtain-wall types. */
  sectionView?: CaiPackageFile;
  /** Thumbnail: hidden-line perspective from the preview camera. */
  previewView?: CaiPackageFile;
  modelGlb?: CaiPackageFile;
  modelFbx?: CaiPackageFile;
  /** Low level of detail model. */
  modelGlbLow?: CaiPackageFile;
  /** Parametric recipe (`recipe.json`) of an asset modeled with parameters. */
  recipe?: CaiPackageFile;
  /** Extra renderings of the views per display style, stored under `views/<style>/`. */
  styleViews?: Partial<Record<ViewStyleName, { top?: CaiPackageFile; front?: CaiPackageFile; side?: CaiPackageFile }>>;
}

export interface ExtractedCaiPackage {
  metadata: CaiMetadata;
  mapping: CaiMapping;
  files: Record<string, Uint8Array>;
  /** The image the 2D board uses: the top view, or the section swatch for line-based types. */
  top: {
    bytes: Uint8Array;
    mime: string;
    path: string;
    url: string;
  };
  views: {
    top?: { bytes: Uint8Array; mime: string; path: string; url: string };
    front?: { bytes: Uint8Array; mime: string; path: string; url: string };
    side?: { bytes: Uint8Array; mime: string; path: string; url: string };
    section?: { bytes: Uint8Array; mime: string; path: string; url: string };
    preview?: { bytes: Uint8Array; mime: string; path: string; url: string };
  };
  models: {
    glb?: { bytes: Uint8Array; path: string };
    fbx?: { bytes: Uint8Array; path: string };
  };
  /** The parametric recipe, when the package has a valid one. */
  recipe?: ParametricRecipe;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function mimeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}

function extensionOf(name: string, fallback: string): string {
  const parts = name.split('.');
  return parts.length > 1 ? `.${parts.pop()!.toLowerCase()}` : fallback;
}

function findFileInArchive(files: Record<string, Uint8Array>, wanted: string, label: string): Uint8Array {
  const target = normalizePath(wanted).toLowerCase();
  const match = Object.entries(files).find(([path]) => normalizePath(path).toLowerCase() === target);
  if (!match) throw new Error(`${label} points to missing file "${wanted}"`);
  return match[1];
}

/**
 * Creates a valid .CAI ZIP package buffer from metadata, 2D views, and 3D models.
 */
export function createCaiPackage(input: CreateCaiPackageInput): Uint8Array {
  // 1. Validate metadata
  const metadata = CaiMetadataSchema.parse(input.metadata);

  // 2. Determine file paths for mapping
  const topPath = input.topView ? `views/top${extensionOf(input.topView.name, '.png')}` : undefined;
  const sectionPath = input.sectionView ? `views/section${extensionOf(input.sectionView.name, '.png')}` : undefined;
  const previewPath = input.previewView ? `views/preview${extensionOf(input.previewView.name, '.png')}` : undefined;

  let frontPath: string | undefined;
  if (input.frontView) {
    const frontExt = extensionOf(input.frontView.name, '.png');
    frontPath = `views/front${frontExt}`;
  }

  let sidePath: string | undefined;
  if (input.sideView) {
    const sideExt = extensionOf(input.sideView.name, '.png');
    sidePath = `views/side${sideExt}`;
  }

  let glbPath: string | undefined;
  if (input.modelGlb) {
    glbPath = 'models/model.glb';
  }

  let fbxPath: string | undefined;
  if (input.modelFbx) {
    fbxPath = 'models/model.fbx';
  }
  const glbLowPath = input.modelGlbLow ? 'models/model-low.glb' : undefined;

  const styleFiles: Record<string, Uint8Array> = {};
  const styles: NonNullable<CaiMapping['styles']> = {};
  for (const [style, views] of Object.entries(input.styleViews ?? {}) as [ViewStyleName, NonNullable<CreateCaiPackageInput['styleViews']>[ViewStyleName]][]) {
    if (!views) continue;
    const set: { top?: string; front?: string; side?: string } = {};
    for (const view of ['top', 'front', 'side'] as const) {
      const file = views[view];
      if (!file) continue;
      const path = `views/${style}/${view}${extensionOf(file.name, '.png')}`;
      set[view] = path;
      styleFiles[path] = file.bytes;
    }
    styles[style] = set;
  }

  const mappingRaw: CaiMapping = {
    version: 1,
    views: {
      ...(topPath ? { top: topPath } : {}),
      ...(frontPath ? { front: frontPath } : {}),
      ...(sidePath ? { side: sidePath } : {}),
      ...(sectionPath ? { section: sectionPath } : {}),
      ...(previewPath ? { preview: previewPath } : {}),
    },
    ...(Object.keys(styles).length > 0 ? { styles } : {}),
    ...(input.recipe ? { recipe: 'models/recipe.json' } : {}),
    models: {
      ...(glbPath ? { glb: glbPath } : {}),
      ...(fbxPath ? { fbx: fbxPath } : {}),
      ...(glbLowPath ? { glbLow: glbLowPath } : {}),
    },
  };

  // 3. Validate mapping
  const mapping = CaiMappingSchema.parse(mappingRaw);
  const problem = checkPackageContents(metadata, mapping);
  if (problem) throw new Error(problem);

  // 4. Construct ZIP archive entries
  const zipFiles: Record<string, Uint8Array> = {
    'metadata.json': strToU8(JSON.stringify(metadata, null, 2)),
    'mapping.json': strToU8(JSON.stringify(mapping, null, 2)),
  };
  if (topPath && input.topView) {
    zipFiles[topPath] = input.topView.bytes;
  }
  if (sectionPath && input.sectionView) {
    zipFiles[sectionPath] = input.sectionView.bytes;
  }
  if (previewPath && input.previewView) zipFiles[previewPath] = input.previewView.bytes;

  if (frontPath && input.frontView) {
    zipFiles[frontPath] = input.frontView.bytes;
  }
  if (sidePath && input.sideView) {
    zipFiles[sidePath] = input.sideView.bytes;
  }
  if (glbPath && input.modelGlb) {
    zipFiles[glbPath] = input.modelGlb.bytes;
  }
  if (fbxPath && input.modelFbx) {
    zipFiles[fbxPath] = input.modelFbx.bytes;
  }
  if (glbLowPath && input.modelGlbLow) zipFiles[glbLowPath] = input.modelGlbLow.bytes;
  if (input.recipe) zipFiles['models/recipe.json'] = input.recipe.bytes;
  Object.assign(zipFiles, styleFiles);

  return zipSync(zipFiles);
}

/**
 * Extracts, parses, and validates a .CAI archive buffer.
 */
export function extractCaiPackage(bytes: Uint8Array): ExtractedCaiPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    throw new Error('File is not a valid ZIP / .CAI package archive', { cause: err });
  }

  const metaBytes = findFileInArchive(files, 'metadata.json', 'metadata.json');
  let metaJson: unknown;
  try {
    metaJson = JSON.parse(strFromU8(metaBytes));
  } catch (err) {
    throw new Error('metadata.json is not valid JSON', { cause: err });
  }
  const metadata = CaiMetadataSchema.parse(metaJson);

  const mapBytes = findFileInArchive(files, 'mapping.json', 'mapping.json');
  let mapJson: unknown;
  try {
    mapJson = JSON.parse(strFromU8(mapBytes));
  } catch (err) {
    throw new Error('mapping.json is not valid JSON', { cause: err });
  }
  const mapping = CaiMappingSchema.parse(mapJson);
  const problem = checkPackageContents(metadata, mapping);
  if (problem) throw new Error(problem);

  const view = (path: string | undefined, label: string) => {
    if (!path) return undefined;
    const bytes = findFileInArchive(files, path, label);
    const mime = mimeFor(path);
    const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
      : '';
    return { bytes, mime, path, url };
  };
  const views = {
    top: view(mapping.views.top, 'mapping.views.top'),
    front: view(mapping.views.front, 'mapping.views.front'),
    side: view(mapping.views.side, 'mapping.views.side'),
    section: view(mapping.views.section, 'mapping.views.section'),
    preview: view(mapping.views.preview, 'mapping.views.preview'),
  };
  const top = views.top ?? views.section!;

  const models: ExtractedCaiPackage['models'] = {};
  if (mapping.models.glb) {
    const glbBytes = findFileInArchive(files, mapping.models.glb, 'mapping.models.glb');
    models.glb = { bytes: glbBytes, path: mapping.models.glb };
  }
  if (mapping.models.fbx) {
    const fbxBytes = findFileInArchive(files, mapping.models.fbx, 'mapping.models.fbx');
    models.fbx = { bytes: fbxBytes, path: mapping.models.fbx };
  }

  const recipe = recipeFromFiles(files, mapping);
  return {
    metadata,
    mapping,
    files,
    ...(recipe ? { recipe } : {}),
    top,
    views: {
      ...(views.top ? { top: views.top } : {}),
      ...(views.front ? { front: views.front } : {}),
      ...(views.side ? { side: views.side } : {}),
      ...(views.section ? { section: views.section } : {}),
      ...(views.preview ? { preview: views.preview } : {}),
    },
    models,
  };
}

/**
 * Triggers a download of a .CAI package file in the browser or electron environment.
 */
export function downloadCaiFile(bytes: Uint8Array, suggestedName: string): void {
  const safeName = suggestedName.toLowerCase().endsWith('.cai') ? suggestedName : `${suggestedName}.cai`;
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
