import { z } from 'zod';
import type { ElementTable } from '@/document';
import { boundsOfIds, clampZoom, fitBounds, rootBounds, zoomAt } from '@/geometry';
import { defineMutation, type MutationContext } from '../contract';
import { steppedBoardElevation, STOREY_STEP } from '../boardLevel';

export const toggleGrid = defineMutation({
  id: 'toggle-grid',
  label: 'Toggle grid',
  aliases: ['show grid', 'hide grid'],
  group: 'view',
  shortcuts: ['Mod+Quote'],
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.doc.workspace.grid.visible = !ctx.doc.workspace.grid.visible;
    return ctx.doc.workspace.grid.visible;
  },
});

export const toggleSnap = defineMutation({
  id: 'toggle-snap',
  label: 'Toggle snapping',
  aliases: ['snap to grid'],
  group: 'view',
  shortcuts: ['Mod+Shift+Quote'],
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.doc.workspace.snap.enabled = !ctx.doc.workspace.snap.enabled;
    return ctx.doc.workspace.snap.enabled;
  },
});

function zoomAboutCenter(ctx: MutationContext, factor: number): void {
  const { width, height } = ctx.ui.canvasSize;
  const next = zoomAt(ctx.ui.viewport, { x: width / 2, y: height / 2 }, factor);
  ctx.ui.viewport = { x: next.x, y: next.y, zoom: next.zoom };
}

export const zoomIn = defineMutation({
  id: 'zoom-in',
  label: 'Zoom in',
  group: 'view',
  shortcuts: ['Mod+Equal', 'Mod+Plus'],
  history: 'none',
  input: z.void(),
  run: (ctx) => zoomAboutCenter(ctx, 1.25),
});

export const zoomOut = defineMutation({
  id: 'zoom-out',
  label: 'Zoom out',
  group: 'view',
  shortcuts: ['Mod+Minus'],
  history: 'none',
  input: z.void(),
  run: (ctx) => zoomAboutCenter(ctx, 1 / 1.25),
});

export const zoomToFit = defineMutation({
  id: 'zoom-to-fit',
  label: 'Zoom to fit',
  aliases: ['fit all', 'show everything'],
  group: 'view',
  shortcuts: ['Shift+1'],
  history: 'none',
  input: z.void(),
  when: (ctx) => Object.keys(ctx.doc.elements).length > 0,
  run: (ctx) => {
    const bounds = rootBounds(ctx.doc.elements as ElementTable);
    if (!bounds) return;
    const next = fitBounds(bounds, ctx.ui.canvasSize);
    ctx.ui.viewport = { x: next.x, y: next.y, zoom: next.zoom };
  },
});

export const zoomToSelection = defineMutation({
  id: 'zoom-to-selection',
  label: 'Zoom to selection',
  aliases: ['fit selection'],
  group: 'view',
  shortcuts: ['Shift+2'],
  history: 'none',
  input: z.void(),
  when: (ctx) => ctx.hasSelection,
  run: (ctx) => {
    const bounds = boundsOfIds(ctx.doc.elements as ElementTable, ctx.ui.selection);
    if (!bounds) return;
    const next = fitBounds(bounds, ctx.ui.canvasSize, 96);
    ctx.ui.viewport = { x: next.x, y: next.y, zoom: next.zoom };
  },
});

export const zoomReset = defineMutation({
  id: 'zoom-reset',
  label: 'Zoom to 1 m = 100 px',
  aliases: ['reset zoom', 'zoom 100%'],
  group: 'view',
  shortcuts: ['Mod+0'],
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    const { width, height } = ctx.ui.canvasSize;
    const target = 0.1;
    const next = zoomAt(ctx.ui.viewport, { x: width / 2, y: height / 2 }, target / ctx.ui.viewport.zoom);
    ctx.ui.viewport = { x: next.x, y: next.y, zoom: next.zoom };
  },
});

export const setViewport = defineMutation({
  id: 'set-viewport',
  label: 'Set viewport',
  group: 'view',
  palette: false,
  history: 'none',
  input: z.object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    zoom: z.number().positive().optional(),
  }),
  run: (ctx, input) => {
    ctx.ui.viewport = {
      x: input.x ?? ctx.ui.viewport.x,
      y: input.y ?? ctx.ui.viewport.y,
      zoom: input.zoom !== undefined ? clampZoom(input.zoom) : ctx.ui.viewport.zoom,
    };
  },
});

const stepBoardLevel = (direction: 'up' | 'down') =>
  defineMutation({
    id: `board-level-${direction}`,
    label: direction === 'up' ? 'Board level up' : 'Board level down',
    description: `Moves the board level (the elevation new elements start at) ${direction} to the next level, or one storey (${STOREY_STEP} mm) when there is none. Returns the new elevation.`,
    aliases: ['work plane', 'storey', 'floor', 'elevation'],
    group: 'view',
    shortcuts: [direction === 'up' ? 'Alt+PageUp' : 'Alt+PageDown'],
    history: 'record',
    input: z.void(),
    run: (ctx) => {
      ctx.doc.workspace.boardElevation = steppedBoardElevation(ctx.doc, direction);
      return ctx.doc.workspace.boardElevation;
    },
  });

export const boardLevelUp = stepBoardLevel('up');
export const boardLevelDown = stepBoardLevel('down');

export const viewCommands = [toggleGrid, toggleSnap, zoomIn, zoomOut, zoomToFit, zoomToSelection, zoomReset, setViewport, boardLevelUp, boardLevelDown];
