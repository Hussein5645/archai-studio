import type { AnyCommand } from '../contract';
import { arrangeCommands } from './arrange';
import { assetCommands } from './assets';
import { presetCommands } from './presets';
import { graphicsCommands } from './graphics';
import { setWallJoints } from './wallJoints';
import { view3dCommands } from './view3d';
import { paperViewCommands } from './views';
import { exportCommands } from './export';
import { sheetCommands } from './sheets';
import { sheetViewCommands } from './sheetViews';
import { diagramCommands } from './diagrams';
import { annotationCommands } from './annotations';
import { analysisDataCommands } from './analysisData';
import { clipboardCommands } from './clipboard';
import { createAssetInstance, createImage, createImageDefinition, createLine, createRect, createText } from './create';
import { documentCommands } from './document';
import { editCommands } from './edit';
import { historyCommands } from './history';
import { selectCommands } from './select';
import { shellCommands } from './shell';
import { transformCommands } from './transform';
import { viewCommands } from './view';
import { aiPortalCommands } from './aiPortal';
import { parametricCommands } from './parametric';
import { syncParametricGraphs } from './parametric-runtime';
import { levelCommands } from './levels';
import { analysisCommands } from './analysis';
import { pointCommands } from './points';
import { vrCommands } from './vr';
import { renderCommands } from './render';
import { materialCommands } from './materials';
import { modelCommands } from './models';
import { importRevitExchange } from '@/revit/importRevit';
import { bridgeCommands } from '@/bridge/commands';
import { caiParameterCommands } from './caiParameters';
import { draftingCommands } from './drafting';
import { sheetLayoutCommands } from './sheetLayout';
import { profileEditCommands } from './profileEdit';

export const builtinCommands: AnyCommand[] = [
  createRect,
  createLine,
  createText,
  createImage,
  createAssetInstance,
  createImageDefinition,
  ...selectCommands,
  ...transformCommands,
  ...editCommands,
  ...arrangeCommands,
  ...draftingCommands,
  ...sheetLayoutCommands,
  ...profileEditCommands,
  ...clipboardCommands,
  ...viewCommands,
  ...historyCommands,
  ...documentCommands,
  ...shellCommands,
  ...assetCommands,
  ...presetCommands,
  setWallJoints,
  ...view3dCommands,
  ...paperViewCommands,
  ...exportCommands,
  ...sheetCommands,
  ...sheetViewCommands,
  ...diagramCommands,
  ...annotationCommands,
  ...analysisDataCommands,
  ...graphicsCommands,
  ...aiPortalCommands,
  ...parametricCommands,
  syncParametricGraphs,
  ...levelCommands,
  ...analysisCommands,
  ...pointCommands,
  ...vrCommands,
  ...renderCommands,
  ...materialCommands,
  ...modelCommands,
  importRevitExchange,
  ...bridgeCommands,
  ...caiParameterCommands,
];

export * from './create';
export * from './select';
export * from './transform';
export * from './edit';
export * from './arrange';
export * from './clipboard';
export * from './view';
export * from './history';
export * from './document';
export * from './shell';
export * from './assets';
export * from './graphics';
export * from './aiPortal';
export * from './parametric';
export * from './levels';
export * from './annotations';
