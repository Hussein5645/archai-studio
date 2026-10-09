import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDocument, sequentialIds } from '@/document';
import { createTestApp } from '@/test/harness';
import { EXAMPLE_PROJECT_ID } from './example-project';
import { PersistenceService } from './service';
import { serializeDocument } from './serialize';
import { documentKey } from './session';

function exampleDocText(name = 'Meridian Tower'): string {
  const doc = createEmptyDocument({ ids: sequentialIds(), now: () => '2026-01-01T00:00:00.000Z', name });
  return serializeDocument({ ...doc, id: EXAMPLE_PROJECT_ID });
}

describe('PersistenceService: built-in example project', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(exampleDocText(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('seeds the example project into Recent Projects on first boot', async () => {
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    const record = await persistence.restoreSession();
    expect(record.recent.find((r) => r.id === EXAMPLE_PROJECT_ID)).toMatchObject({ builtin: true, name: 'Meridian Tower' });
    expect(await app.platform.storage.get(documentKey(EXAMPLE_PROJECT_ID))).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch on a later boot once already stored and listed', async () => {
    const app = createTestApp();
    await new PersistenceService(app.store, app.executor, app.platform).restoreSession();
    fetchMock.mockClear();
    const record = await new PersistenceService(app.store, app.executor, app.platform).restoreSession();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(record.recent.filter((r) => r.id === EXAMPLE_PROJECT_ID)).toHaveLength(1);
  });

  it('re-seeds if its storage was cleared but the recent entry survived', async () => {
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    await persistence.restoreSession();
    await app.platform.storage.delete(documentKey(EXAMPLE_PROJECT_ID));
    fetchMock.mockClear();
    await persistence.restoreSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await app.platform.storage.get(documentKey(EXAMPLE_PROJECT_ID))).not.toBeNull();
  });

  it('cannot be removed via forget()', async () => {
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    await persistence.restoreSession();
    await persistence.forget(EXAMPLE_PROJECT_ID);
    expect(persistence.recent().some((r) => r.id === EXAMPLE_PROJECT_ID)).toBe(true);
    expect(await app.platform.storage.get(documentKey(EXAMPLE_PROJECT_ID))).not.toBeNull();
  });

  it('resetExampleProject overwrites an edited working copy with the pristine version', async () => {
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    await persistence.restoreSession();
    // Simulate the user having edited and autosaved a working copy under the same key.
    await app.platform.storage.set(documentKey(EXAMPLE_PROJECT_ID), exampleDocText('Edited by user'));
    await persistence.resetExampleProject();
    const stored = await app.platform.storage.get(documentKey(EXAMPLE_PROJECT_ID));
    expect(stored && JSON.parse(stored).meta.name).toBe('Meridian Tower');
    expect(persistence.recent().find((r) => r.id === EXAMPLE_PROJECT_ID)).toMatchObject({ builtin: true, name: 'Meridian Tower' });
  });

  it('stays flagged builtin through open and autosave round trips', async () => {
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    await persistence.restoreSession();

    await persistence.openStored(EXAMPLE_PROJECT_ID);
    expect(persistence.recent().find((r) => r.id === EXAMPLE_PROJECT_ID)).toMatchObject({ builtin: true });

    app.store.setState((state) => ({ doc: { ...state.doc, meta: { ...state.doc.meta, name: 'Renamed while editing' } } }));
    await persistence.flush();
    const entry = persistence.recent().find((r) => r.id === EXAMPLE_PROJECT_ID);
    expect(entry).toMatchObject({ builtin: true, name: 'Renamed while editing' });
  });

  it('saves a new project at once, keeps a linked id, and does not fork it', async () => {
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    await persistence.restoreSession();
    persistence.start();
    app.executor.dispatchSync('new-document', { name: 'Tower', id: 'doc_linkedid' });
    expect(app.store.getState().doc.id).toBe('doc_linkedid');
    // Written without waiting for the autosave debounce.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.platform.storage.get(documentKey('doc_linkedid'))).toBeTruthy();
    expect(persistence.recent().filter((entry) => entry.name === 'Tower')).toHaveLength(1);
    persistence.stop();
  });

  it('never lists the Home screen placeholder document as a project', async () => {
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    await persistence.restoreSession();
    app.store.setState((state) => ({ ui: { ...state.ui, screen: 'home' } }));
    const before = persistence.recent().length;
    app.store.setState((state) => ({ doc: { ...state.doc, meta: { ...state.doc.meta, name: 'Placeholder' } } }));
    await persistence.flush();
    expect(persistence.recent()).toHaveLength(before);
  });
});
