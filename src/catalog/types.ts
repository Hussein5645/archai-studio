/**
 * The asset catalog is external data. In production its entries are .CAI packages in R2;
 * the loose-file manifest remains available only as a lightweight local-development source.
 * Nothing about the general-asset taxonomy is hard-coded in the application.
 */
import type { SystemType } from './system-schemas';
import type { ParametricRecipe } from './parametric';

export type CatalogAssetKind = 'asset' | 'system';
export type SystemAssetType = SystemType;
export type SystemParameterValue = string | number | boolean | null | SystemParameterValue[] | { [key: string]: SystemParameterValue };

export interface CatalogPackageRef {
  /** Object key in the backing catalog, e.g. `Architecture/Doors/single-900.CAI`. */
  key: string;
  /** Fetchable URL for the complete .CAI (ZIP) package. */
  url: string;
  version: 1;
}

export interface CatalogModel {
  /** The model remains inside the .CAI package until the 3D workspace is implemented. */
  path: string;
  format: 'glb' | 'fbx';
  /** Loose-file catalogs may expose a direct URL. */
  url?: string;
}

export interface CatalogAsset {
  /** Stable id, unique within the catalog (defaults to the path). */
  id: string;
  /** Folder path such as `Furnish/Seating/sofa-2-seat`. */
  path: string;
  name: string;
  kind: CatalogAssetKind;
  /** Only `system` assets may set this. They configure the matching architecture tool output. */
  systemType?: SystemAssetType;
  /** Defaults used by the type-driven system configuration panel (validated per tool). */
  systemParameters?: Record<string, SystemParameterValue>;
  /** Parameter keys that may be overridden per placed instance. */
  instanceEditable?: string[];
  /**
   * Placed system packages expose every orthographic view; regular assets only require top.
   * Line-based types (walls, railings) carry a cross-section swatch instead.
   */
  views?: {
    top?: { url: string; path: string; mime: string };
    front?: { url: string; path: string; mime: string };
    side?: { url: string; path: string; mime: string };
    section?: { url: string; path: string; mime: string };
    preview?: { url: string; path: string; mime: string };
  };
  image: { url: string; path?: string; mime?: string };
  /** Archive paths of the views rendered in other display styles (`mapping.styles`). */
  styleViews?: Partial<Record<string, { top?: string; front?: string; side?: string }>>;
  /** Library thumbnail (the preview camera render); the board still uses `image`. */
  thumbnail?: { url: string; path: string; mime: string };
  /** Preferred model, kept for compatibility with the current future-3D handoff. */
  model?: CatalogModel;
  models?: { glb?: CatalogModel; fbx?: CatalogModel; glbLow?: CatalogModel };
  package?: CatalogPackageRef;
  /** Real-world footprint in millimetres (0 × 0 for line-based system types). */
  size: { width: number; height: number };
  tags?: string[];
  /** Recipe of an asset modeled in ArchAI with parameters (see ./parametric.ts). */
  parametric?: ParametricRecipe;
  /** Flag indicating whether asset was created or uploaded locally. */
  isLocal?: boolean;
  /** For wall presets: which preset of which package this entry is. */
  presetId?: string;
  packageId?: string;
}

export interface CatalogFolder {
  path: string;
  name: string;
  folders: CatalogFolder[];
  assets: CatalogAsset[];
  /** Invalid packages are skipped instead of taking down the whole library. */
  warnings?: string[];
}

export interface FetchedImage {
  mime: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface AssetCatalog {
  /** Identifies where the catalog comes from (recorded on placed definitions). */
  source: string;
  load(): Promise<CatalogFolder>;
  /**
   * System types for one tool: packages from the R2 `system/<tool>/` folder plus any local
   * imports. Never part of the folder tree shown in the Assets tab.
   */
  loadSystemTypes?(type: SystemAssetType): Promise<CatalogAsset[]>;
  fetchImage(asset: CatalogAsset): Promise<FetchedImage>;
  addLocalPackage?(bytes: Uint8Array): Promise<CatalogAsset>;
  deleteLocalPackage?(id: string): Promise<void>;
  exportPackageBytes?(asset: CatalogAsset): Promise<Uint8Array | null>;
  /** Raw bytes of a locally stored package by package id, if any. */
  localPackageBytes?(id: string): Promise<Uint8Array | null>;
  subscribe?(listener: () => void): () => void;
}
