import { z } from 'zod';
import { childrenOf, IdSchema, type ElementTable } from '@/document';
import { normalizeSelection } from '@/selection';
import type { ToolId } from '@/store';
import { CommandError, defineMutation } from '../contract';
import { enterProfileModeForTool } from '../profileMode';
import { stickyOf } from '@/annotations/model';
import { activeGroup, inGroup, selectionScope } from '@/selection/groupScope';
import { leaveGroup } from './groups';

const ToolIdSchema = z.union([
  z.enum(['select', 'hand', 'rect', 'line', 'point', 'text', 'image', 'measure', 'catalog', 'view3d', 'section', 'camera', 'paper', 'ai-portal', 'parametric', 'analysis-sun', 'analysis-wind', 'analysis-noise', 'analysis-location', 'noise-emitter']),
  z.string().regex(/^arch:[a-z0-9-]+$/),
  z.string().regex(/^diagram:[a-z-]+$/),
  z.string().regex(/^draw:[a-z-]+$/),
  z.string().regex(/^modify:[a-z-]+$/),
  z.string().regex(/^annotate:[a-z-]+$/),
]) as z.ZodType<ToolId, string>;

export const select = defineMutation({
  id: 'select',
  label: 'Select elements',
  description: 'Replaces, extends or toggles the selection.',
  group: 'select',
  palette: false,
  history: 'none',
  input: z.object({
    ids: z.array(IdSchema),
    mode: z.enum(['replace', 'add', 'toggle', 'remove']).default('replace'),
  }),
  run: (ctx, input) => {
    const elements = ctx.doc.elements as ElementTable;
    const current = ctx.ui.selection;
    let next: string[];
    switch (input.mode) {
      case 'replace':
        next = input.ids;
        break;
      case 'add':
        next = [...current, ...input.ids];
        break;
      case 'remove':
        next = current.filter((id) => !input.ids.includes(id));
        break;
      case 'toggle':
        next = [...current.filter((id) => !input.ids.includes(id)), ...input.ids.filter((id) => !current.includes(id))];
        break;
    }
    ctx.ui.selection = normalizeSelection(elements, next.filter((id) => inGroup(elements, activeGroup(elements, ctx.ui), id)));
    ctx.ui.editingTextId = null;
    return ctx.ui.selection;
  },
});

export const selectAll = defineMutation({
  id: 'select-all',
  label: 'Select all',
  group: 'select',
  shortcuts: ['Mod+A'],
  history: 'none',
  input: z.void(),
  when: (ctx) => Object.keys(ctx.doc.elements).length > 0,
  run: (ctx) => {
    const roots = childrenOf(ctx.doc.elements as ElementTable, selectionScope(ctx.ui)).filter((e) => e.visible && !e.locked);
    ctx.ui.selection = roots.map((e) => e.id);
    ctx.ui.editingTextId = null;
    return ctx.ui.selection;
  },
});

export const clearSelection = defineMutation({
  id: 'clear-selection',
  label: 'Deselect',
  aliases: ['deselect all', 'clear selection'],
  group: 'select',
  shortcuts: ['Escape'],
  history: 'none',
  input: z.void(),
  when: (ctx) => ctx.hasSelection || ctx.ui.tool !== 'select' || Boolean(ctx.ui.groupEditId),
  run: (ctx) => {
    if (ctx.ui.groupEditId && ctx.ui.tool === 'select' && !ctx.ui.editingTextId) { leaveGroup(ctx); return; }
    ctx.ui.selection = [];
    ctx.ui.editingTextId = null;
    ctx.ui.tool = 'select';
    ctx.ui.placingAsset = null;
  },
});

export const setTool = defineMutation({
  id: 'set-tool',
  label: 'Switch tool',
  group: 'select',
  palette: false,
  history: 'none',
  input: z.object({ tool: ToolIdSchema }),
  run: (ctx, input) => {
    ctx.ui.tool = input.tool;
    enterProfileModeForTool(ctx, input.tool);
    if (input.tool !== 'select' && input.tool !== 'hand') ctx.ui.lastTool = input.tool;
    if (input.tool !== 'catalog') ctx.ui.placingAsset = null;
    ctx.ui.editingTextId = null;
  },
});

function toolCommand(id: string, label: string, tool: ToolId, shortcut: string, aliases: string[] = []) {
  return defineMutation({
    id,
    label,
    aliases,
    group: 'select',
    shortcuts: [shortcut],
    history: 'none',
    input: z.void(),
    run: (ctx) => {
      ctx.ui.tool = tool;
      if (tool !== 'select' && tool !== 'hand') ctx.ui.lastTool = tool;
      if (tool !== 'catalog') ctx.ui.placingAsset = null;
      ctx.ui.editingTextId = null;
    },
  });
}

export const toolSelect = toolCommand('tool-select', 'Select tool', 'select', 'V', ['pointer', 'move tool']);
export const toolHand = toolCommand('tool-hand', 'Hand tool', 'hand', 'H', ['pan']);
export const toolRect = toolCommand('tool-rect', 'Rectangle tool', 'rect', 'R', ['draw rectangle', 'box']);
export const toolLine = toolCommand('tool-line', 'Line tool', 'line', 'L', ['draw line', 'polyline']);
export const toolPoint = toolCommand('tool-point', 'Point tool', 'point', 'P', ['reference point', 'marker', 'point']);
export const toolText = toolCommand('tool-text', 'Text tool', 'text', 'T', ['add text', 'label']);
export const toolImage = toolCommand('tool-image', 'Image tool', 'image', 'I', ['add image', 'place image']);
export const toolModel = toolCommand('tool-model', '3D model tool', 'model', 'Shift+M', ['fbx', 'obj', 'glb', 'gltf', 'stl', 'import model', '3d file']);
export const toolMeasure = toolCommand('tool-measure', 'Measure tool', 'measure', 'M', ['dimension', 'distance']);
export const toolView3d = toolCommand('tool-view3d', '3D view tool', 'view3d', 'Shift+3', ['3d', 'perspective', 'portal']);
export const toolSection = toolCommand('tool-section', 'Section view tool', 'section', 'Shift+S', ['section', 'cut', 'elevation']);
export const toolCamera = toolCommand('tool-camera', 'Camera tool', 'camera', 'Shift+C', ['camera', 'perspective view']);
export const toolPaper = toolCommand('tool-paper', 'Paper tool', 'paper', 'Shift+P', ['sheet', 'layout', 'pdf']);
export const toolAiPortal = toolCommand('tool-ai-portal', 'AI Portal tool', 'ai-portal', 'Shift+A', ['ai', 'portal', 'chat', 'assistant']);
export const toolParametric = toolCommand('tool-parametric', 'Parametric component tool', 'parametric', 'Shift+N', ['nodes', 'visual programming', 'parametric design']);

// Drafting shapes and edit tools (src/interaction/drafting.ts). Two-letter shortcuts follow Revit.
export const toolCircle = toolCommand('tool-circle', 'Circle tool', 'draw:circle', 'C', ['draw circle', 'round']);
export const toolArc = toolCommand('tool-arc', 'Arc tool', 'draw:arc', 'A', ['draw arc', 'curve']);
export const toolPolygon = toolCommand('tool-polygon', 'Polygon tool', 'draw:polygon', 'P G', ['hexagon', 'regular polygon']);
export const toolEllipse = toolCommand('tool-ellipse', 'Ellipse tool', 'draw:ellipse', 'E L', ['oval']);
export const toolPen = toolCommand('tool-pen', 'Curve (pen) tool', 'draw:pen', 'B', ['pen', 'bezier', 'spline', 'freeform curve']);
export const toolMove = toolCommand('tool-move', 'Move by points', 'modify:move', 'M V', ['move', 'MV']);
export const toolCopy = toolCommand('tool-copy', 'Copy by points', 'modify:copy', 'C O', ['copy', 'CO', 'multiple copies']);
export const toolRotate = toolCommand('tool-rotate', 'Rotate by points', 'modify:rotate', 'R O', ['rotate', 'RO']);
export const toolMirror = toolCommand('tool-mirror', 'Mirror', 'modify:mirror', 'M M', ['mirror', 'flip', 'MM']);
export const toolScale = toolCommand('tool-scale', 'Scale by points', 'modify:scale', 'R E', ['scale', 'resize', 'RE']);
export const toolArray = toolCommand('tool-array', 'Array', 'modify:array', 'A R', ['array', 'repeat', 'AR']);
export const toolOffset = toolCommand('tool-offset', 'Offset', 'modify:offset', 'O F', ['offset', 'parallel', 'OF']);
export const toolTrim = toolCommand('tool-trim', 'Trim / extend to corner', 'modify:trim', 'T R', ['trim', 'corner', 'TR']);
export const toolExtend = toolCommand('tool-extend', 'Extend to boundary', 'modify:extend', 'E T', ['extend', 'ET']);
export const toolSplit = toolCommand('tool-split', 'Split line', 'modify:split', 'S L', ['split', 'break', 'SL']);
export const toolFillet = toolCommand('tool-fillet', 'Fillet / chamfer', 'modify:fillet', 'F L', ['fillet', 'chamfer', 'round corner']);
export const toolMatch = toolCommand('tool-match', 'Match properties', 'modify:match', 'M A', ['match', 'format painter', 'MA']);

export const beginTextEdit = defineMutation({
  id: 'begin-text-edit',
  label: 'Edit text',
  group: 'edit',
  shortcuts: ['Enter'],
  history: 'none',
  input: z.object({ id: IdSchema.optional() }).prefault({}),
  when: (ctx) => {
    const id = ctx.selection[0];
    const element = ctx.doc.elements[id!];
    return ctx.selection.length === 1 && (element?.kind === 'text' || Boolean(stickyOf(element))) && ctx.ui.editingTextId === null;
  },
  run: (ctx, input) => {
    const id = input.id ?? ctx.ui.selection[0];
    const element = id ? ctx.doc.elements[id] : undefined;
    if (!element || (element.kind !== 'text' && !stickyOf(element))) throw new CommandError('rejected', 'Select a text element to edit');
    ctx.ui.selection = [element.id];
    ctx.ui.editingTextId = element.id;
    ctx.ui.tool = 'select';
  },
});

export const endTextEdit = defineMutation({
  id: 'end-text-edit',
  label: 'Finish editing text',
  group: 'edit',
  palette: false,
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.editingTextId = null;
  },
});

export const selectCommands = [
  beginTextEdit,
  endTextEdit,
  select,
  selectAll,
  clearSelection,
  setTool,
  toolSelect,
  toolHand,
  toolRect,
  toolLine,
  toolPoint,
  toolText,
  toolImage,
  toolModel,
  toolMeasure,
  toolView3d,
  toolSection,
  toolCamera,
  toolPaper,
  toolAiPortal,
  toolCircle,
  toolArc,
  toolPolygon,
  toolEllipse,
  toolPen,
  toolMove,
  toolCopy,
  toolRotate,
  toolMirror,
  toolScale,
  toolArray,
  toolOffset,
  toolTrim,
  toolExtend,
  toolSplit,
  toolFillet,
  toolMatch,
  toolParametric,
];
