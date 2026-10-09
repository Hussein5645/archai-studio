import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@/document';
import { createTestApp, run } from '@/test/harness';
import { applyMigrations, readSchemaVersion, type Migration } from './migrations';
import { parseDocument, serializeDocument } from './serialize';

describe('serialize / parse', () => {
  it('round-trips a document with elements, definitions and blobs', () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    run(app, 'create-text', { x: 0, y: 2000, text: 'Kitchen' });
    run(app, 'select-all');
    run(app, 'create-asset-definition', { name: 'Room' });
    run(app, 'create-arch-element', { tool: 'door', x: 100, y: 100 });
    const doc = app.store.getState().doc;
    const text = serializeDocument(doc);
    const parsed = parseDocument(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(doc);
      expect(parsed.migratedFrom).toBeNull();
    }
  });

  it('handles and normalizes legacy "transparent" stroke/fill to null', () => {
    const app = createTestApp();
    run(app, 'create-rect', { x: 0, y: 0 });
    const doc = app.store.getState().doc;
    const json = JSON.parse(serializeDocument(doc));
    const firstId = Object.keys(json.elements)[0]!;
    json.elements[firstId].style.stroke = 'transparent';
    const parsed = parseDocument(JSON.stringify(json));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.document.elements[firstId] as { style: { stroke: unknown } }).style.stroke).toBeNull();
    }
  });

  it('rejects invalid JSON, non-documents, newer versions and broken shapes', () => {
    expect(parseDocument('{').ok).toBe(false);
    const notDoc = parseDocument('{"hello":1}');
    expect(notDoc.ok).toBe(false);
    if (!notDoc.ok) expect(notDoc.error.code).toBe('not-a-document');

    const future = parseDocument(JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }));
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.code).toBe('unsupported-version');

    const broken = parseDocument(JSON.stringify({ schemaVersion: SCHEMA_VERSION, id: 'x' }));
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.error.code).toBe('invalid-shape');
      expect(broken.error.details!.length).toBeGreaterThan(0);
    }
  });

  it('rejects documents whose references are broken', () => {
    const app = createTestApp();
    run(app, 'create-arch-element', { tool: 'door', x: 0, y: 0 });
    const doc = structuredClone(app.store.getState().doc);
    doc.definitions = {};
    const result = parseDocument(serializeDocument(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariants');
      expect(result.error.details![0]).toContain('missing definition');
    }
  });
});

describe('migrations', () => {
  it('runs migration steps in order and stamps the version', () => {
    const migrations: Migration[] = [
      { from: 1, migrate: (raw) => ({ ...raw, a: 1 }) },
      { from: 2, migrate: (raw) => ({ ...raw, b: 2 }) },
    ];
    const result = applyMigrations({ schemaVersion: 1 }, 1, 3, migrations);
    expect(result).toEqual({ schemaVersion: 3, a: 1, b: 2 });
    expect(() => applyMigrations({ schemaVersion: 1 }, 1, 4, migrations)).toThrow(/No migration/);
  });

  it('readSchemaVersion reads an integer schemaVersion and rejects everything else', () => {
    expect(readSchemaVersion({ schemaVersion: 1 })).toBe(1);
    expect(readSchemaVersion({ schemaVersion: 3.5 })).toBeNull();
    expect(readSchemaVersion({ schemaVersion: '1' })).toBeNull();
    expect(readSchemaVersion({})).toBeNull();
    expect(readSchemaVersion(null)).toBeNull();
    expect(readSchemaVersion('not an object')).toBeNull();
    expect(readSchemaVersion([1, 2])).toBeNull();
  });
});
