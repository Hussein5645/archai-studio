import type { SavedAsset } from './persistence';

/** Older packaging saved an editable alias with the same ownership as its workspace. */
export function linkedModels(assets: SavedAsset[], projectId: string): SavedAsset[] {
  const owned = assets.filter(asset => asset.project?.id === projectId);
  const aliasIds = new Set(owned.filter(asset => asset.id !== asset.metadata.id).map(asset => asset.metadata.id));
  return owned.filter(asset => !(asset.id === asset.metadata.id && aliasIds.has(asset.id)));
}
