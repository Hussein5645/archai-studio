import type { AssetCatalog, CatalogAsset, CatalogFolder, FetchedImage } from './types';

/** Fails explicitly instead of silently falling back to bundled demo assets. */
export class UnconfiguredR2Catalog implements AssetCatalog {
  readonly source = 'cloudflare-r2:unconfigured';

  load(): Promise<CatalogFolder> {
    return Promise.reject(new Error('Asset storage is not connected. Configure the catalog URL and restart ArchAI.'));
  }

  fetchImage(_asset: CatalogAsset): Promise<FetchedImage> {
    return Promise.reject(new Error('Asset storage is not connected.'));
  }
}
