import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@/document/create';
import { sequentialIds } from '@/document/ids';
import {
  createDocumentFromTemplate,
  createTemplateFromDocument,
  deleteLocalTemplate,
  getLocalTemplates,
  parseTemplateFile,
  saveLocalTemplate,
  serializeTemplate,
} from './templates';

function mockPlatform() {
  const store = new Map<string, string>();
  return {
    storage: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
  } as any;
}

describe('Templates persistence & management', () => {
  const ids = sequentialIds();
  const now = () => '2026-09-19T22:00:00.000Z';

  it('creates a template from document without board elements', () => {
    const doc = createEmptyDocument({ ids, now, name: 'Sample Arch Project' });
    // Add a dummy element to document
    doc.elements['elem1'] = {
      id: 'elem1',
      kind: 'rect',
      parentId: null,
      index: 'a0',
      x: 0,
      y: 0,
      rotation: 0,
      visible: true,
      locked: false,
      width: 100,
      height: 100,
      radius: 0,
      style: { fill: '#ffffff', stroke: '#000000', strokeWidth: 1, opacity: 1 },
    };

    // Add a definition
    doc.definitions['def1'] = {
      kind: 'template',
      id: 'def1',
      name: 'Custom Symbol',
      width: 200,
      height: 200,
      origin: 'user',
      elements: {},
    };

    const template = createTemplateFromDocument(doc, 'My Custom Preset Template', 'Description of preset', ids, now);

    expect(template.name).toBe('My Custom Preset Template');
    expect(template.description).toBe('Description of preset');
    expect(template.archaiTemplate).toBe(1);
    expect(template.definitions['def1']).toBeDefined();
    // Verify template does not contain board elements
    expect((template as any).elements).toBeUndefined();
  });

  it('creates a new document from a template with empty elements', () => {
    const doc = createEmptyDocument({ ids, now, name: 'Base Doc' });
    doc.workspace.graphics = { wall: { board: { 'hidden-line': { 'body.fill': '#123456' } } } };
    doc.definitions['cai_asset_1'] = {
      kind: 'image',
      id: 'cai_asset_1',
      name: 'Asset',
      width: 10,
      height: 10,
      origin: 'catalog',
      blobId: 'blob1',
    };

    const template = createTemplateFromDocument(doc, 'Preset', undefined, ids, now);
    const newDoc = createDocumentFromTemplate(template, 'New Project from Preset', ids, now);

    expect(newDoc.meta.name).toBe('New Project from Preset');
    expect(newDoc.elements).toEqual({});
    expect(newDoc.workspace.graphics).toEqual(doc.workspace.graphics);
    expect(newDoc.definitions['cai_asset_1']).toBeDefined();
  });

  it('serializes and parses .AIT template files', () => {
    const doc = createEmptyDocument({ ids, now, name: 'Doc' });
    const template = createTemplateFromDocument(doc, 'AIT Preset', 'Test', ids, now);
    const json = serializeTemplate(template);

    const result = parseTemplateFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template.name).toBe('AIT Preset');
      expect(result.template.archaiTemplate).toBe(1);
    }

    const invalid = parseTemplateFile('{ "invalid": true }');
    expect(invalid.ok).toBe(false);
  });

  it('saves, retrieves, and deletes local templates in platform storage', async () => {
    const platform = mockPlatform();
    const doc = createEmptyDocument({ ids, now, name: 'Doc' });
    const template = createTemplateFromDocument(doc, 'Saved Local Template', undefined, ids, now);

    await saveLocalTemplate(platform, template);
    let list = await getLocalTemplates(platform);
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe('Saved Local Template');

    await deleteLocalTemplate(platform, template.id);
    list = await getLocalTemplates(platform);
    expect(list.length).toBe(0);
  });
});
