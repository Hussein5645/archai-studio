import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from './create';
import { checkInvariants, type InvariantViolation } from './invariants';
import { sequentialIds } from './ids';
import type { ArchaiDocument, GroupElement, ImageElement, InstanceElement, RectElement, TemplateDefinition } from './schema';

function baseDoc(): ArchaiDocument {
  return createEmptyDocument({ ids: sequentialIds(), now: () => '2026-01-01T00:00:00.000Z' });
}

function rect(id: string, overrides: Partial<RectElement> = {}): RectElement {
  return {
    kind: 'rect',
    id,
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
    ...overrides,
  };
}

function group(id: string, overrides: Partial<GroupElement> = {}): GroupElement {
  return { kind: 'group', id, parentId: null, index: 'a0', x: 0, y: 0, rotation: 0, visible: true, locked: false, ...overrides };
}

function instance(id: string, definitionId: string, overrides: Partial<InstanceElement> = {}): InstanceElement {
  return { kind: 'instance', id, parentId: null, index: 'a0', x: 0, y: 0, rotation: 0, visible: true, locked: false, definitionId, width: 100, height: 100, ...overrides };
}

function image(id: string, blobId: string, overrides: Partial<ImageElement> = {}): ImageElement {
  return { kind: 'image', id, parentId: null, index: 'a0', x: 0, y: 0, rotation: 0, visible: true, locked: false, width: 100, height: 100, blobId, opacity: 1, ...overrides };
}

function template(id: string, elements: TemplateDefinition['elements']): TemplateDefinition {
  return { kind: 'template', id, name: id, width: 100, height: 100, origin: 'user', elements };
}

function codesOf(doc: ArchaiDocument): InvariantViolation['code'][] {
  return checkInvariants(doc).map((v) => v.code);
}

describe('checkInvariants', () => {
  it('is clean for an empty document', () => {
    expect(checkInvariants(baseDoc())).toEqual([]);
  });

  it('is clean for a simple valid hierarchy', () => {
    const doc = baseDoc();
    const g = group('el_g');
    const r = rect('el_r', { parentId: 'el_g' });
    doc.elements = { [g.id]: g, [r.id]: r };
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('flags an element whose parentId points nowhere', () => {
    const doc = baseDoc();
    const r = rect('el_r', { parentId: 'ghost' });
    doc.elements = { [r.id]: r };
    expect(codesOf(doc)).toContain('missing-parent');
  });

  it('flags a parent cycle', () => {
    const doc = baseDoc();
    const a = rect('el_a', { parentId: 'el_b' });
    const b = rect('el_b', { parentId: 'el_a' });
    doc.elements = { [a.id]: a, [b.id]: b };
    expect(codesOf(doc)).toContain('parent-cycle');
  });

  it('flags an instance referencing a missing definition', () => {
    const doc = baseDoc();
    const inst = instance('el_i', 'def_missing');
    doc.elements = { [inst.id]: inst };
    expect(codesOf(doc)).toContain('missing-definition');
  });

  it('flags a board image element referencing a missing blob', () => {
    const doc = baseDoc();
    const img = image('el_img', 'blob_missing');
    doc.elements = { [img.id]: img };
    expect(codesOf(doc)).toContain('missing-blob');
  });

  it('flags an image definition referencing a missing blob', () => {
    const doc = baseDoc();
    doc.definitions = {
      def_a: { kind: 'image', id: 'def_a', name: 'A', width: 100, height: 100, origin: 'user', blobId: 'blob_missing' },
    };
    expect(codesOf(doc)).toContain('missing-blob');
  });

  it('flags a template definition that transitively instantiates itself', () => {
    const doc = baseDoc();
    const instOfB = instance('el_ib', 'def_b');
    const instOfA = instance('el_ia', 'def_a');
    doc.definitions = {
      def_a: template('def_a', { [instOfB.id]: instOfB }),
      def_b: template('def_b', { [instOfA.id]: instOfA }),
    };
    expect(codesOf(doc)).toContain('definition-cycle');
  });

  it('does not flag a template that merely reuses another definition without a cycle', () => {
    const doc = baseDoc();
    const instOfB = instance('el_ib', 'def_b');
    doc.definitions = {
      def_a: template('def_a', { [instOfB.id]: instOfB }),
      def_b: template('def_b', {}),
    };
    expect(codesOf(doc)).not.toContain('definition-cycle');
  });

  it('flags a table key that does not match the id of the element it holds', () => {
    const doc = baseDoc();
    const r = rect('el_r');
    doc.elements = { wrong_key: r };
    expect(codesOf(doc)).toContain('id-mismatch');
  });

  it('flags a definitions-table key that does not match the id of the definition it holds', () => {
    const doc = baseDoc();
    doc.definitions = { wrong_key: template('def_a', {}) };
    expect(codesOf(doc)).toContain('id-mismatch');
  });
});
