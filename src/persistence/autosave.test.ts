import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { PersistenceService } from './service';
import { documentKey } from './session';
import { preferences } from '@/ui/preferences';

afterEach(() => preferences.reset());

describe('autosave preference', () => {
  it('does not write local edits on flush when disabled, and allows an explicit save', async () => {
    preferences.set({ autosave: false });
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    persistence.start();
    try {
      run(app, 'new-document', { name: 'Manual saving' });
      const key = documentKey(app.store.getState().doc.id);
      expect(persistence.getSaveStatus()).toBe('unsaved');
      await persistence.flush();
      expect(await app.platform.storage.get(key)).toBeNull();
      await persistence.saveNow();
      expect(await app.platform.storage.get(key)).toBeTruthy();
      expect(persistence.getSaveStatus()).toBe('saved');
      run(app, 'create-rect', { x: 0, y: 0 });
      expect(persistence.getSaveStatus()).toBe('unsaved');
    } finally { persistence.stop(); }
  });

  it('always saves online projects even when the local preference is off', async () => {
    preferences.set({ autosave: false });
    const app = createTestApp();
    run(app, 'new-document', { name: 'Online' });
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    await persistence.storeDocument(app.store.getState().doc, { cloud: { version: 1, role: 'owner' } });
    persistence.start();
    try {
      run(app, 'rename-document', { name: 'Online changed' });
      await persistence.flush();
      expect((await persistence.loadStored(app.store.getState().doc.id))?.meta.name).toBe('Online changed');
      expect(persistence.getSaveStatus()).toBe('saved');
    } finally { persistence.stop(); }
  });

  it('keeps a save error visible and retries the same document', async () => {
    preferences.set({ autosave: false });
    const app = createTestApp();
    const persistence = new PersistenceService(app.store, app.executor, app.platform);
    persistence.start();
    try {
      run(app, 'new-document', { name: 'Retry' });
      const set = vi.spyOn(app.platform.storage, 'set').mockRejectedValueOnce(new Error('Disk full'));
      await expect(persistence.saveNow()).rejects.toThrow('Could not save');
      expect(persistence.getSaveStatus()).toBe('error');
      set.mockRestore();
      await persistence.saveNow();
      expect(persistence.getSaveStatus()).toBe('saved');
    } finally { persistence.stop(); }
  });
});
