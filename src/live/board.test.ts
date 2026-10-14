import { afterEach, expect, it, vi } from 'vitest';
import type { LiveRequestKind } from '@shared/ipc';
import { createTestApp, run } from '@/test/harness';
import { createToastStore } from '@/ui/toast-store';
import { liveBridgeControls, startLiveLink, nameFromKey } from './board';

const exporter = vi.hoisted(() => vi.fn(async () => new ArrayBuffer(0)));
vi.mock('@/view3d/vrExport', () => ({ exportSceneSnapshot: exporter }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  exporter.mockReset();
});

function setup() {
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
  startLiveLink(app.platform, app.store, app.executor, app.catalog, createToastStore());
  return { app, request };
}

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
