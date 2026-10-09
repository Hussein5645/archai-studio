import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTestApp, run, runAsync } from '@/test/harness';
import { serializeDocument, parseDocument } from '@/persistence/serialize';
import { Shape } from '@/render/shapes';
import { doorTemplate } from '@/assets/system-geometry';
import { parseSystemParameters } from '@/catalog';
import type { AssetDefinition, Element } from '@/document';
import { BUILTIN_GRAPHICS_PRESETS, GRAPHIC_TYPES, graphicsResolver, newElementStyle, readGraphicsPresetFile, sanitizeOverrides, graphicsPresetFile } from './index';

describe('graphics registry', () => {
  it('has unique parameter ids per type and consistent style lists', () => {
    for (const type of GRAPHIC_TYPES) {
      const ids = type.parameters.map((parameter) => parameter.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const parameter of type.parameters) {
        expect(parameter.views.length).toBeGreaterThan(0);
        if (parameter.styles) expect(parameter.views).toContain('board');
      }
    }
  });
});

describe('graphics resolver', () => {
  it('applies current and legacy overrides only to Hidden line', () => {
    const g = graphicsResolver({ wall: { board: { '*': { 'layer.stroke': '#111111' }, 'hidden-line': { 'layer.stroke': '#222222' } } } });
    expect(g.color('wall', 'board', 'realistic', 'layer.stroke')).toBe('#ffffff');
    expect(g.color('wall', 'board', 'hidden-line', 'layer.stroke')).toBe('#222222');
    expect(graphicsResolver({ wall: { board: { '*': { 'layer.stroke': '#111111' } } } }).color('wall', 'board', 'hidden-line', 'layer.stroke')).toBe('#111111');
    expect(graphicsResolver({}).color('wall', 'board', 'shaded', 'body.fill')).toBe('#8e9099');
    expect(graphicsResolver(undefined).color('wall', 'board', 'realistic', 'body.fill')).toBe('#3a3a3f');
  });

  it('ignores invalid overrides and never overrides locked parameters', () => {
    const g = graphicsResolver({ wall: { board: { '*': { 'body.fill': 'red', 'outline.stroke': '#ff0000', 'layer.width': -3 } } } });
    expect(g.color('wall', 'board', 'realistic', 'body.fill')).toBe('#3a3a3f');
    expect(g.color('wall', 'board', 'hidden-line', 'outline.stroke')).toBe('#1f1f24');
    expect(g.number('wall', 'board', 'realistic', 'layer.width')).toBe(4);
  });

  it('gives new drawing elements the type defaults', () => {
    expect(newElementStyle({}, 'rect')).toEqual({ fill: '#ffffff', stroke: '#3a3a3f', strokeWidth: 12, opacity: 1 });
    expect(newElementStyle({ line: { board: { 'hidden-line': { stroke: '#123456', strokeWidth: 30 } } } }, 'line')).toMatchObject({ stroke: '#3a3a3f', strokeWidth: 12 });
  });
});

describe('graphics commands', () => {
  it('set-graphic writes undoable Hidden line overrides without baking them into new elements', () => {
    const app = createTestApp();
    run(app, 'set-graphic', { type: 'rect', view: 'board', id: 'fill', value: '#ff00ff' });
    run(app, 'set-graphic', { type: 'wall', view: 'board', id: 'layer.stroke', value: '#101010' });
    expect(app.store.getState().doc.workspace.graphics).toEqual({ rect: { board: { 'hidden-line': { fill: '#ff00ff' } } }, wall: { board: { 'hidden-line': { 'layer.stroke': '#101010' } } } });
    const id = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    const rect = app.store.getState().doc.elements[id];
    expect(rect?.kind === 'rect' && rect.style.fill).toBe('#ffffff');
    run(app, 'set-graphic', { type: 'rect', view: 'board', id: 'fill', reset: true });
    expect(app.store.getState().doc.workspace.graphics['rect']).toBeUndefined();
    expect(app.executor.undo()).toBe(true);
    expect(app.store.getState().doc.workspace.graphics['rect']).toEqual({ board: { 'hidden-line': { fill: '#ff00ff' } } });
  });

  it('rejects locked parameters, unknown parameters and wrong views', () => {
    const app = createTestApp();
    expect(app.executor.dispatchSync('set-graphic', { type: 'wall', view: 'board', id: 'outline.stroke', value: '#000000' }).ok).toBe(false);
    expect(app.executor.dispatchSync('set-graphic', { type: 'wall', view: 'board', id: 'nope', value: 1 }).ok).toBe(false);
    expect(app.executor.dispatchSync('set-graphic', { type: 'wall', view: '3d', id: 'body.fill', value: '#000000' }).ok).toBe(false);
    expect(app.executor.dispatchSync('set-graphic', { type: 'wall', view: 'board', id: 'body.fill', value: '#000000' }).ok).toBe(true);
    expect(app.executor.dispatchSync('set-graphic', { type: 'wall', view: 'board', id: 'body.opacity', value: 0.5 }).ok).toBe(true);
    expect(app.executor.dispatchSync('set-graphic', { type: 'wall', view: 'board', id: 'layer.width', value: 'wide' }).ok).toBe(false);
  });

  it('opens the dialog on a type and survives a save/load round trip', () => {
    const app = createTestApp();
    run(app, 'open-graphics', { type: 'stair' });
    expect(app.store.getState().ui.graphicsDialog).toEqual({ open: true, type: 'stair', elementId: null });
    run(app, 'close-graphics');
    expect(app.store.getState().ui.graphicsDialog.open).toBe(false);
    run(app, 'set-graphic', { type: 'stair', view: '3d', id: 'material.tread', value: '#abcdef' });
    const text = serializeDocument(app.store.getState().doc);
    const parsed = parseDocument(text);
    expect(parsed.ok && parsed.document.workspace.graphics).toEqual({ stair: { '3d': { 'hidden-line': { 'material.tread': '#abcdef' } } } });
  });

  it('new documents start from the defaults, not the previous document overrides', () => {
    const app = createTestApp();
    run(app, 'set-graphic', { type: 'door', view: 'board', id: 'ink', value: '#ff0000' });
    run(app, 'new-document', { name: 'Fresh' });
    expect(app.store.getState().doc.workspace.graphics).toEqual({});
  });

  it('renders Hidden line overrides on both existing and subsequently created elements only', () => {
    const app = createTestApp();
    const existingId = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100, style: { fill: '#ff0000' } });
    run(app, 'set-graphic', { type: 'rect', view: 'board', id: 'fill', value: '#ff00ff' });
    const newId = run<string>(app, 'create-rect', { x: 200, y: 0, width: 100, height: 100 });
    const doc = app.store.getState().doc;
    const markup = (id: string, viewStyle: typeof doc.workspace.viewStyle) =>
      renderToStaticMarkup(createElement(Shape, { element: doc.elements[id]!, context: { definitions: doc.definitions, blobs: doc.blobs, elements: doc.elements, workspace: { ...doc.workspace, viewStyle } } }));

    expect(markup(existingId, 'hidden-line')).toContain('fill="#ff00ff"');
    expect(markup(newId, 'hidden-line')).toContain('fill="#ff00ff"');
    expect(markup(existingId, 'realistic')).toContain('fill="#ff0000"');
    expect(markup(newId, 'realistic')).toContain('fill="#ffffff"');
  });

  it('renders wall fill colour, opacity, and overlapping square joins', () => {
    const app = createTestApp();
    const [id] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [2000, 0]] });
    run(app, 'set-graphic', { type: 'wall', view: 'board', id: 'body.fill', value: '#abcdef' });
    run(app, 'set-graphic', { type: 'wall', view: 'board', id: 'body.opacity', value: 0.4 });
    const doc = app.store.getState().doc;
    const markup = renderToStaticMarkup(createElement(Shape, { element: doc.elements[id!]!, context: { definitions: doc.definitions, blobs: doc.blobs, elements: doc.elements, workspace: { ...doc.workspace, viewStyle: 'hidden-line' } } }));
    expect(markup).toContain('fill="#abcdef"');
    expect(markup).toContain('opacity="0.4"');
    expect(markup).toContain('stroke-linecap="square"');
  });

  it('renders selectable section arrows and level opacity', () => {
    const app = createTestApp();
    const sectionId = run<string>(app, 'create-section-view', { a: [0, 0], b: [3000, 0] });
    const markerId = (app.store.getState().doc.elements[sectionId]!.meta?.['view3d'] as { sectionLineId: string }).sectionLineId;
    run(app, 'set-graphic', { type: 'section-marker', view: 'board', id: 'symbol.arrowShape', value: 'chevron' });
    expect(app.executor.dispatchSync('set-graphic', { type: 'section-marker', view: 'board', id: 'symbol.arrowShape', value: 'kite' }).ok).toBe(false);

    const levelId = run<string>(app, 'create-level', { x: 0, y: 0, width: 5000, height: 3000, elevation: 3000 });
    run(app, 'set-graphic', { type: 'level', view: 'board', id: 'fill', value: '#abcdef' });
    run(app, 'set-graphic', { type: 'level', view: 'board', id: 'opacity', value: 0.4 });
    const doc = app.store.getState().doc;
    const markup = (id: string) => renderToStaticMarkup(createElement(Shape, { element: doc.elements[id]!, context: { definitions: doc.definitions, blobs: doc.blobs, elements: doc.elements, workspace: { ...doc.workspace, viewStyle: 'hidden-line' } } }));

    expect(markup(markerId)).toContain('data-section-arrow="chevron"');
    expect(markup(levelId)).toContain('fill="#abcdef"');
    expect(markup(levelId)).toContain('opacity="0.4"');
  });

  it('maps room names to fill colours and falls back to the default room colour', () => {
    const app = createTestApp();
    const lobby = run<string>(app, 'create-line', { points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], closed: true, name: 'Lobby', meta: { arch: { type: 'room' } } });
    const office = run<string>(app, 'create-line', { points: [[1200, 0], [2200, 0], [2200, 1000], [1200, 1000]], closed: true, name: 'Office', meta: { arch: { type: 'room' } } });
    run(app, 'set-graphic', { type: 'room', view: 'board', id: 'fill', value: '#eeeeee' });
    run(app, 'set-graphic', { type: 'room', view: 'board', id: 'name.colors', value: [{ text: ' lobby ', color: '#ff0000' }] });
    const doc = app.store.getState().doc;
    const markup = (id: string) => renderToStaticMarkup(createElement(Shape, { element: doc.elements[id]!, context: { definitions: doc.definitions, blobs: doc.blobs, elements: doc.elements, workspace: { ...doc.workspace, viewStyle: 'hidden-line' } } }));

    expect(graphicsResolver(doc.workspace.graphics).colorMap('room', 'board', 'hidden-line', 'name.colors')).toEqual([{ text: ' lobby ', color: '#ff0000' }]);
    expect(markup(lobby)).toContain('fill="#ff0000"');
    expect(markup(office)).toContain('fill="#eeeeee"');
    expect(app.executor.dispatchSync('set-graphic', { type: 'room', view: 'board', id: 'name.colors', value: [{ text: 'Office', color: 'red' }] }).ok).toBe(false);
  });

  it('applies Hidden line ink and swing overrides to door template geometry', () => {
    const template = doorTemplate(parseSystemParameters('door', {}));
    const definition: AssetDefinition = { id: 'door_definition', name: 'Door', kind: 'template', width: template.width, height: template.height, origin: 'builtin', elements: Object.fromEntries(template.elements.map((element) => [element.id, element])) };
    const door: Element = { id: 'door', parentId: null, index: 'a0', x: 0, y: 0, rotation: 0, visible: true, locked: false, kind: 'instance', definitionId: definition.id, width: template.width, height: template.height, meta: { arch: { type: 'door' } } };
    const workspace = createTestApp().store.getState().doc.workspace;
    workspace.viewStyle = 'hidden-line';
    workspace.graphics = { door: { board: { 'hidden-line': { ink: '#ff0000', light: '#006eff' } } } };
    const markup = renderToStaticMarkup(createElement(Shape, { element: door, context: { definitions: { [definition.id]: definition }, blobs: {}, elements: { [door.id]: door }, workspace } }));

    expect(markup).toContain('stroke="#ff0000"');
    expect(markup).toContain('stroke="#006eff"');
  });
});

describe('graphics presets', () => {
  it('saves, applies, exports and imports presets through a portable file', async () => {
    const app = createTestApp();
    run(app, 'set-graphic', { type: 'wall', view: 'section', id: 'cut.coreHatch', value: 'cross' });
    run(app, 'set-graphic', { type: 'column', view: 'board', id: 'fill.steel', value: '#00ff00' });
    expect(await runAsync(app, 'save-graphics-preset', { name: 'Office look' })).toBe('office-look');
    const stored = await app.platform.storage.get('graphics-presets');
    const presets = readGraphicsPresetFile(stored!);
    expect(presets.map((preset) => preset.name)).toEqual(['Office look']);
    expect(presets[0]!.graphics).toEqual({ wall: { section: { 'hidden-line': { 'cut.coreHatch': 'cross' } } }, column: { board: { 'hidden-line': { 'fill.steel': '#00ff00' } } } });

    await runAsync(app, 'apply-graphics-preset', { presetId: 'default' });
    expect(app.store.getState().doc.workspace.graphics).toEqual({});
    await runAsync(app, 'apply-graphics-preset', { presetId: 'office-look' });
    expect(app.store.getState().doc.workspace.graphics['column']).toEqual({ board: { 'hidden-line': { 'fill.steel': '#00ff00' } } });
    await runAsync(app, 'apply-graphics-preset', { presetId: 'ink' });
    expect(graphicsResolver(app.store.getState().doc.workspace.graphics).color('wall', 'board', 'hidden-line', 'layer.stroke')).toBe('#111111');

    // A file from another machine: unknown types/parameters and locked or invalid values are dropped.
    const file = graphicsPresetFile([{ id: 'shared', name: 'Shared', graphics: { wall: { board: { '*': { 'layer.stroke': '#123123', 'outline.stroke': '#ffffff', bogus: 1 } } }, spaceship: { board: { '*': { hull: '#000' } } } } }]);
    expect(await runAsync(app, 'import-graphics-presets', { text: file })).toEqual(['shared']);
    const afterImport = readGraphicsPresetFile((await app.platform.storage.get('graphics-presets'))!);
    expect(afterImport.map((preset) => preset.id).sort()).toEqual(['office-look', 'shared']);
    expect(afterImport.find((preset) => preset.id === 'shared')!.graphics).toEqual({ wall: { board: { 'hidden-line': { 'layer.stroke': '#123123' } } } });
    expect(await runAsync(app, 'delete-graphics-preset', { presetId: 'office-look' })).toBe(1);
    expect((await app.executor.dispatch('save-graphics-preset', { name: 'Default' })).ok).toBe(false);
    expect((await app.executor.dispatch('import-graphics-presets', { text: '{"nope":true}' })).ok).toBe(false);
  });

  it('built-in presets only contain valid overrides', () => {
    for (const preset of BUILTIN_GRAPHICS_PRESETS) expect(sanitizeOverrides(preset.graphics)).toEqual(preset.graphics);
  });
});
