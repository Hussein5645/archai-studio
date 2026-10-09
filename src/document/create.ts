import type { IdSource } from './ids';
import { SCHEMA_VERSION, type ArchaiDocument, type Style, type Workspace } from './schema';

export const DEFAULT_WORKSPACE: Workspace = {
  unit: 'm',
  precision: 2,
  background: '#ebedef',
  grid: { visible: true, size: 500 },
  snap: { enabled: true },
  viewStyle: 'hidden-line',
  lod: 'low',
  boardElevation: 0,
  graphics: {},
  diagramTheme: 'technical',
};

export const DEFAULT_RECT_STYLE: Style = {
  fill: '#ffffff',
  stroke: '#3a3a3f',
  strokeWidth: 12,
  opacity: 1,
};

export const DEFAULT_LINE_STYLE: Style = {
  fill: null,
  stroke: '#3a3a3f',
  strokeWidth: 12,
  opacity: 1,
};

export const DEFAULT_TEXT_COLOR = '#2a2a2e';
export const DEFAULT_FONT_SIZE = 200;

export interface CreateDocumentOptions {
  ids: IdSource;
  now: () => string;
  name?: string;
}

export function createEmptyDocument({ ids, now, name = 'Untitled' }: CreateDocumentOptions): ArchaiDocument {
  const timestamp = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: ids.next('doc'),
    meta: { name, createdAt: timestamp, updatedAt: timestamp },
    workspace: { ...DEFAULT_WORKSPACE, grid: { ...DEFAULT_WORKSPACE.grid }, snap: { ...DEFAULT_WORKSPACE.snap }, graphics: {} },
    elements: {},
    definitions: {},
    blobs: {},
    materials: {},
  };
}
