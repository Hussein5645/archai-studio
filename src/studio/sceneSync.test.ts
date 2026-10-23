import { describe, expect, it } from 'vitest';
import { createEmptyDocument, MaterialSchema, sequentialIds } from '@/document';
import { SceneReceiver, SceneSender } from './sceneSync';

const document = () => createEmptyDocument({ ids: sequentialIds(), now: () => '2026-10-20T00:00:00Z' });

describe('render synchronization', () => {
  it('reconstructs edits and resource deletions without replacing visualization state', () => {
    const source = document();
    const sender = new SceneSender();
    const receiver = new SceneReceiver();
    receiver.accept(sender.next(source));
    const updated = { ...source, meta: { ...source.meta, name: 'Changed' } };
    const frame = sender.next(updated);
    expect(frame.kind).toBe('delta');
    expect(receiver.accept(frame)).toEqual(updated);
    if (frame.kind === 'delta') expect(frame.changes.blobs.upsert).toEqual({});
    const material = MaterialSchema.parse({ id: 'stone', name: 'Stone', color: '#998877' });
    const withMaterial = { ...updated, materials: { stone: material } };
    expect(receiver.accept(sender.next(withMaterial)).materials['stone']).toEqual(material);
    const removal = sender.next(updated);
    if (removal.kind === 'delta') expect(removal.changes.materials.remove).toEqual(['stone']);
    expect(receiver.accept(removal).materials).toEqual({});
  });

  it('rejects missed updates and recovers with a fresh snapshot', () => {
    const sender = new SceneSender();
    const receiver = new SceneReceiver();
    const source = document();
    receiver.accept(sender.next(source));
    sender.next({ ...source, meta: { ...source.meta, name: 'Lost' } });
    expect(() => receiver.accept(sender.next(source))).toThrow('revision gap');
    expect(receiver.accept(sender.next(source, true))).toEqual(source);
  });

  it('cannot apply another project or connection delta', () => {
    const source = document();
    const sender = new SceneSender();
    const receiver = new SceneReceiver();
    receiver.accept(sender.next(source));
    const delta = sender.next(source);
    expect(() => receiver.accept({ ...delta, projectId: 'other' })).toThrow();
    expect(() => receiver.accept({ ...delta, stream: 'other' })).toThrow();
    expect(receiver.accept(delta)).toEqual(source);
    expect(() => receiver.accept(delta)).toThrow();
  });

  it('sends a new snapshot on project switches and validates before committing', () => {
    const sender = new SceneSender();
    const receiver = new SceneReceiver();
    const source = document();
    receiver.accept(sender.next(source));
    const invalid = sender.next(source);
    if (invalid.kind === 'delta') invalid.changes.elements.upsert['bad'] = { kind: 'invalid' };
    expect(() => receiver.accept(invalid)).toThrow();
    expect(receiver.accept(sender.next(source, true))).toEqual(source);
    const other = { ...source, id: 'another-project' };
    expect(receiver.accept(sender.next(other))).toEqual(other);
  });
});
