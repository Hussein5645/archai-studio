import { afterEach, expect, it, vi } from 'vitest';
import type { LiveRequestKind } from '@shared/ipc';
import { createTestApp, run } from '@/test/harness';
import { createToastStore } from '@/ui/toast-store';
import { liveBridgeControls, startLiveLink, nameFromKey } from './board';
import { PersistenceService } from '@/persistence/service';

const exporter = vi.hoisted(() => vi.fn(async () => new ArrayBuffer(0)));
const projectPicker = vi.hoisted(() => vi.fn(async (): Promise<{ project: string } | null> => null));
vi.mock('@/view3d/vrExport', () => ({ exportSceneSnapshot: exporter }));
vi.mock('@/bridge/ProjectPicker', () => ({ chooseProject: projectPicker }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  exporter.mockReset();
  projectPicker.mockClear();
});

function setup(stored = false) {
  vi.useFakeTimers();
  const app = createTestApp();
  run(app, 'new-document', { name: 'Bridge tests' });
  let request!: (kind: LiveRequestKind, payload: Record<string, unknown>) => Promise<unknown>;
  app.platform.live = {
    serve: (handler) => {
      request = handler;
      return () => {};
    },
  };
  const persistence = new PersistenceService(app.store, app.executor, app.platform);
  const openLink = startLiveLink(app.platform, app.store, app.executor, app.catalog, createToastStore(), stored ? persistence : null)!;
  return { app, request, persistence, openLink };
}

it('requires an explicit destination even when another project is open, without creating a project', async () => {
  const { app, request } = setup();
  const doc = app.store.getState().doc;
  expect(await request('status', { key: 'unlinked', protocol: 2 })).toMatchObject({ needsLink: true, document: null });
  expect(app.store.getState().doc).toBe(doc);
  expect(app.platform.storageMap.has('live:project:unlinked')).toBe(false);
  await expect(request('push', { key: 'unlinked', protocol: 2 })).rejects.toThrow('Link this model');
});

it('updates the saved project in the background and reuses its bindings after reconnecting', async () => {
  const { app, request, persistence } = setup(true);
  const first = app.store.getState().doc.id;
  const model = { archaiRevit: 1, walls: [{ id: 'wall', points: [[0, 0], [1000, 0]], base: 0, height: 3000, layers: [{ name: 'Core', role: 'core', thickness: 200 }] }] };
  run(app, 'bridge-sync', { key: 'test-background', app: 'Revit', model });
  const ids = Object.keys(app.store.getState().doc.bridge!.elements);
  await persistence.storeDocument(app.store.getState().doc);
  await app.platform.storage.set('live:project:test-background', first);
  run(app, 'new-document', { name: 'Other project' });
  const other = app.store.getState().doc;
  expect(await request('status', { key: 'test-background', project: first, protocol: 2 })).toMatchObject({ document: { id: first }, needsLink: false });
  expect(await request('push', { key: 'test-background', project: first, protocol: 2, model, changeId: 'reconnect' })).toMatchObject({ ack: 'reconnect', document: { id: first } });
  expect(app.store.getState().doc).toBe(other);
  expect(Object.keys((await persistence.loadStored(first))!.bridge!.elements)).toEqual(ids);
  const binding = await request('bind', { key: 'test-background', project: first });
  expect(binding).toMatchObject({ document: { id: first }, known: ['wall'] });
});

it('offers relinking for a missing destination and rejects a pending batch for the previous link', async () => {
  const { app, request, persistence } = setup(true);
  await app.platform.storage.set('live:project:test-missing', 'missing');
  expect(await request('status', { key: 'test-missing', project: 'missing', protocol: 2 })).toMatchObject({ needsLink: true, document: null });
  const old = app.store.getState().doc;
  await persistence.storeDocument(old);
  run(app, 'new-document', { name: 'New destination' });
  const next = app.store.getState().doc;
  await persistence.storeDocument(next);
  await request('bind', { key: 'switch', project: next.id });
  expect(await request('push', { key: 'switch', project: old.id, protocol: 2, model: { archaiRevit: 1, meshes: [] } })).toMatchObject({ refused: 'project-mismatch' });
  expect(await request('status', { key: 'switch', project: old.id, protocol: 2 })).toMatchObject({ document: { id: next.id }, needsLink: false });
  expect((await persistence.loadStored(old.id))!.bridge).toBeUndefined();
});

it('does not resurrect a removed destination from Home and can stop a missing link', async () => {
  const { app, request } = setup(true);
  const id = app.store.getState().doc.id;
  await app.platform.storage.set('live:project:removed', id);
  run(app, 'set-screen', { screen: 'home' });
  expect(await request('status', { key: 'removed', project: id, protocol: 2 })).toMatchObject({ needsLink: true, document: null });
  expect(await request('stop', { key: 'removed' })).toEqual({ ok: true });
});

it('names a project after the linked model', () => {
  expect(nameFromKey(String.raw`rhino:C:\Projects\House A.3dm`)).toBe('House A');
  expect(nameFromKey('revit:D:/jobs/Tower.rvt')).toBe('Tower');
  expect(nameFromKey('blender:unsaved')).toBe('unsaved');
  expect(nameFromKey('3dsmax:unsaved:3ds Max scene')).toBe('3ds Max scene');
  expect(nameFromKey('autocad:')).toBe('Live model');
});

it('announces direction and sync requests, refuses blocked pushes and wrong-project pulls', async () => {
  const { app, request } = setup();
  const project = app.store.getState().doc.id;
  run(app, 'bridge-sync', { key: 'test', model: { archaiRevit: 1, meshes: [] } });
  run(app, 'bridge-set-source', { key: 'test', mode: 'paused', receives: 'nothing' });
  expect(await request('status', { key: 'test', protocol: 2, project })).toMatchObject({
    mode: 'paused',
    receives: 'nothing',
    syncRequest: 0,
  });
  expect(await request('push', { key: 'test', project, protocol: 2 })).toMatchObject({
    refused: 'paused',
  });
  await expect(request('pull', { key: 'test', project: 'wrong', protocol: 2 })).rejects.toThrow(
    'another project',
  );
  liveBridgeControls.resync('test');
  expect(await request('status', { key: 'test', project })).toMatchObject({ syncRequest: 1 });
  expect(exporter).not.toHaveBeenCalled();
});

it('returns the exported snapshot revision so edits made during export are pulled next time', async () => {
  const { app, request } = setup();
  const project = app.store.getState().doc.id;
  const before = (await request('status', { key: 'receiver', project })) as { revision: number };
  exporter.mockImplementationOnce(async () => {
    run(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
    return new ArrayBuffer(0);
  });
  const pull = (await request('pull', { key: 'receiver', project, protocol: 2 })) as {
    revision: number;
  };
  const after = (await request('status', { key: 'receiver', project })) as { revision: number };
  expect(pull.revision).toBe(before.revision);
  expect(after.revision).toBeGreaterThan(pull.revision);
});

it('does not commit a pull when the user switches projects during export', async () => {
  const { app, request } = setup();
  const project = app.store.getState().doc.id;
  exporter.mockImplementationOnce(async () => {
    run(app, 'new-document', { name: 'Other project' });
    return new ArrayBuffer(0);
  });
  await expect(request('pull', { key: 'receiver', project, protocol: 2 })).rejects.toThrow(
    'project changed',
  );
});

it('opens the project picker on a cold-launch link without waiting for another plugin request', async () => {
  const { app, request, openLink } = setup();
  const doc = app.store.getState().doc;
  openLink('archai://live?key=revit%3Acold&app=Revit&name=Tower');
  await vi.waitFor(() => expect(projectPicker).toHaveBeenCalledWith('Revit', 'Tower'));
  expect(app.store.getState().doc).toBe(doc);
  // Cancellation stays dismissed while the older plugin keeps polling.
  await request('status', { key: 'revit:cold', app: 'Revit', name: 'Tower' });
  expect(projectPicker).toHaveBeenCalledTimes(1);
  await request('stop', { key: 'revit:cold' });
  await request('status', { key: 'revit:cold', app: 'Revit', name: 'Tower' });
  expect(projectPicker).toHaveBeenCalledTimes(2);
});

it('joins the picker opened by status when the plugin also asks to choose a project', async () => {
  const { app, request } = setup();
  const project = app.store.getState().doc.id;
  let resolve!: (value: { project: string }) => void;
  projectPicker.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  expect(await request('status', { key: 'joined-picker', app: 'Revit', name: 'Tower' })).toMatchObject({ needsLink: true, linkPending: true });
  const binding = request('bind', { key: 'joined-picker', app: 'Revit', name: 'Tower', choose: true });
  // The waiting picker does not block normal bridge requests.
  expect(await request('projects', {})).toMatchObject({ protocol: 2 });
  resolve({ project });
  expect(await binding).toMatchObject({ document: { id: project } });
  expect(projectPicker).toHaveBeenCalledTimes(1);
  expect(await request('status', { key: 'joined-picker', app: 'Revit' })).toMatchObject({ needsLink: false, linkPending: false });
});
