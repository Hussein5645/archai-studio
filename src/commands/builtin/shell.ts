import { z } from 'zod';
import { defineMutation } from '../contract';

export const openCommandPalette = defineMutation({
  id: 'open-command-palette',
  label: 'Command palette',
  aliases: ['search commands', 'actions'],
  group: 'shell',
  shortcuts: ['Mod+K', 'Mod+P'],
  palette: false,
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.paletteOpen = true;
  },
});

export const closeCommandPalette = defineMutation({
  id: 'close-command-palette',
  label: 'Close command palette',
  group: 'shell',
  palette: false,
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.paletteOpen = false;
  },
});

export const toggleLeftPanel = defineMutation({
  id: 'toggle-left-panel',
  label: 'Toggle layers & assets panel',
  aliases: ['hide sidebar', 'show sidebar'],
  group: 'shell',
  shortcuts: ['Mod+Backslash'],
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.panels.left = !ctx.ui.panels.left;
  },
});

export const toggleInspector = defineMutation({
  id: 'toggle-inspector',
  label: 'Toggle inspector',
  aliases: ['properties panel'],
  group: 'shell',
  shortcuts: ['Mod+Shift+Backslash'],
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.panels.inspector = !ctx.ui.panels.inspector;
  },
});

export const showLayers = defineMutation({
  id: 'show-layers',
  label: 'Show layers',
  aliases: ['document structure', 'outline'],
  group: 'shell',
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.panels.left = true;
    ctx.ui.panels.leftTab = 'layers';
  },
});

export const showAssets = defineMutation({
  id: 'show-assets',
  label: 'Show asset library',
  aliases: ['catalog', 'library', 'furniture'],
  group: 'shell',
  shortcuts: ['Mod+Shift+A'],
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.panels.left = true;
    ctx.ui.panels.leftTab = 'assets';
  },
});

export const showMaterials = defineMutation({
  id: 'show-materials',
  label: 'Show materials',
  aliases: ['material library', 'textures', 'finishes'],
  group: 'shell',
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.panels.left = true;
    ctx.ui.panels.leftTab = 'materials';
  },
});

export const shellCommands = [
  showMaterials,
  openCommandPalette,
  closeCommandPalette,
  toggleLeftPanel,
  toggleInspector,
  showLayers,
  showAssets,
];
