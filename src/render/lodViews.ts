/**
 * High level of detail on the 2D board: an asset's plan symbol is rendered from its 3D model
 * (top view, in the board's display style) instead of the package image. Renders are cached per
 * definition and style and produced lazily once the model is loaded.
 */
import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import type { ArchaiDocument, AssetDefinition, BoardViewStyle, Element } from '@/document';
import { footprintOfBounds, instanceOverrides, parametricInstanceOf, rebuildKey, recipeOf, type Footprint, type ParametricRecipe } from '@/catalog/parametric';
import { composeRebuilt, onParametricRebuilt, rebuiltModel, requestRebuild } from '@/view3d/parametricModels';
import type { AssetCatalog } from '@/catalog/types';
import { modelStore } from '@/view3d/assets';
import { renderStill } from '@/view3d/offscreen';

class TopViewStore {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly missing = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** The definition's model could not be loaded or rendered (the board then uses the package image). */
  failed(definitionId: string): boolean {
    return this.missing.has(definitionId);
  }

  private fail(definitionId: string): void {
    if (this.missing.has(definitionId)) return;
    this.missing.add(definitionId);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** The rendered top view, or null while it is not available yet (a render is scheduled). */
  get(doc: ArchaiDocument, catalog: AssetCatalog, definitionId: string, style: BoardViewStyle): string | null {
    const key = `${definitionId}|${style}`;
    const url = this.urls.get(key);
    if (url) return url;
    if (this.missing.has(definitionId)) return null;
    if (this.pending.has(key)) return null;
    modelStore.configure(catalog);
    const definition = doc.definitions[definitionId];
    const job = modelStore.prepare({ ...doc, definitions: definition ? { [definitionId]: definition } : {} }).then(async () => {
      const model = modelStore.models.get(definitionId);
      if (!model) return this.fail(definitionId); // no model: the package image stays
      // Let the loading screen and other input paint between GPU thumbnail renders.
      const { paint } = await import('@/progress');
      await paint();
      try {
        const canvas = renderStill({ objects: [model.clone(true)], view: 'top', style: style === 'consistent' ? 'color' : style, size: 512, background: null });
        this.urls.set(key, canvas.toDataURL('image/png'));
        this.version += 1;
        for (const listener of this.listeners) listener();
      } catch (error) {
        console.warn('Top view render failed', error);
        this.fail(definitionId);
      }
    }, () => this.fail(definitionId)).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return null;
  }

  async prepare(doc: ArchaiDocument, catalog: AssetCatalog): Promise<void> {
    const ids = new Set(Object.values(doc.elements).flatMap((element) => element.visible && element.kind === 'instance' ? [element.definitionId] : []));
    for (const id of ids) {
      const definition = doc.definitions[id];
      if (definition?.kind !== 'image' || !(definition.catalog?.modelPaths?.glb || definition.catalog?.modelPaths?.fbx || definition.catalog?.modelUrl)) continue;
      this.get(doc, catalog, id, doc.workspace.viewStyle);
      await this.pending.get(`${id}|${doc.workspace.viewStyle}`);
    }
  }
}

export const topViewStore = new TopViewStore();

/** Package images rendered in other styles (`views/<style>/top.png`), loaded on demand. */
class StyleViewStore {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  get(catalog: AssetCatalog, definition: Extract<AssetDefinition, { kind: 'image' }>, style: BoardViewStyle): string | null {
    const path = definition.catalog?.styleViews?.[style]?.top;
    if (!path) return null;
    const key = `${definition.id}|${style}`;
    const url = this.urls.get(key);
    if (url) return url;
    if (this.pending.has(key)) return null;
    this.pending.add(key);
    modelStore.configure(catalog);
    void modelStore.packageFile(definition, path).then((bytes) => {
      if (!bytes) return;
      const lower = path.toLowerCase();
      const mime = lower.endsWith('.svg') ? 'image/svg+xml' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : 'image/png';
      this.urls.set(key, URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })));
      this.version += 1;
      for (const listener of this.listeners) listener();
    });
    return null;
  }
}

export const styleViewStore = new StyleViewStore();

/** The package's own rendering of the top view in `style` (low LOD), or null → filter the plain image. */
export function usePackageStyleView(catalog: AssetCatalog | null, definition: Extract<AssetDefinition, { kind: 'image' }>, style: BoardViewStyle, enabled: boolean): string | null {
  useSyncExternalStore(styleViewStore.subscribe, styleViewStore.getVersion, styleViewStore.getVersion);
  if (!enabled || !catalog || style === 'realistic') return null;
  return styleViewStore.get(catalog, definition, style);
}

/** Top view of a catalog asset rendered from its model; null → use the package image. */
export function useModelTopView(doc: ArchaiDocument | null, catalog: AssetCatalog | null, definitionId: string | null, style: BoardViewStyle, enabled: boolean): string | null {
  useSyncExternalStore(topViewStore.subscribe, topViewStore.getVersion, topViewStore.getVersion);
  if (!enabled || !definitionId || !doc || !catalog) return null;
  return topViewStore.get(doc, catalog, definitionId, style);
}

/**
 * Plan symbols of parametric copies with their own values: a top view of the rebuilt model,
 * framed on the copy's recorded footprint so it fills the copy's box exactly.
 */
class ParametricViewStore {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor() {
    onParametricRebuilt(() => this.bump());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  get(doc: ArchaiDocument, catalog: AssetCatalog, definition: AssetDefinition, recipe: ParametricRecipe, overrides: Record<string, number>, footprint: Footprint, style: BoardViewStyle): string | null {
    const key = `${rebuildKey(definition.id, overrides)}|${style}|${[footprint.minX, footprint.maxX, footprint.minZ, footprint.maxZ].map((value) => Math.round(value)).join(',')}`;
    const url = this.urls.get(key);
    if (url) return url;
    const entry = rebuiltModel(definition.id, overrides);
    if (!entry) {
      void requestRebuild(definition, recipe, overrides);
      return null;
    }
    if (entry.status === 'error' || this.pending.has(key)) return null;
    this.pending.add(key);
    modelStore.configure(catalog);
    void modelStore.prepare(doc).then(() => {
      try {
        const object = composeRebuilt(modelStore.models.get(definition.id), entry.model);
        const bounds = new THREE.Box3(new THREE.Vector3(footprint.minX, entry.model.bounds.min.y, footprint.minZ), new THREE.Vector3(footprint.maxX, entry.model.bounds.max.y, footprint.maxZ));
        const canvas = renderStill({ objects: [object], view: 'top', style: style === 'consistent' ? 'color' : style, size: 512, background: null, bounds });
        this.urls.set(key, canvas.toDataURL('image/png'));
        this.bump();
      } catch (error) {
        console.warn('Parametric top view render failed', error);
      } finally {
        this.pending.delete(key);
      }
    });
    return null;
  }
}

export const parametricViewStore = new ParametricViewStore();

/** The plan symbol of a parametric copy with its own values; null while it is being built. */
export function useParametricTopView(doc: ArchaiDocument | null, catalog: AssetCatalog | null, element: Element, definition: AssetDefinition, style: BoardViewStyle): string | null {
  useSyncExternalStore(parametricViewStore.subscribe, parametricViewStore.getVersion, parametricViewStore.getVersion);
  const recipe = recipeOf(definition);
  if (!recipe || !doc || !catalog) return null;
  const instance = parametricInstanceOf(element);
  const overrides = instanceOverrides(recipe, instance);
  if (Object.keys(overrides).length === 0) return null;
  return parametricViewStore.get(doc, catalog, definition, recipe, overrides, instance.footprint ?? footprintOfBounds(recipe.bounds), style);
}
