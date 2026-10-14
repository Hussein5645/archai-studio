import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDocument, sequentialIds } from '@/document';
import { createAppStore } from '@/store';
import type { Platform } from '@/platform/types';
import { parseSettings, defaultSettings } from './settings';

type Message = { type: string } & Record<string, unknown>;

function fakeStudioPlatform() {
  const sent: Message[] = [];
  let listener: ((message: Message) => void) | null = null;
  const platform = {
    window: { openRender: vi.fn() },
    studio: {
      send: (message: Message) => sent.push(message),
      subscribe: (l: (message: Message) => void) => {
        listener = l;
        return () => (listener = null);
      },
    },
  } as unknown as Platform;
  return { platform, sent, receive: (message: Message) => listener?.(message) };
}

describe('board link', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('answers the studio with the document and streams edits while it is open', async () => {
    vi.useFakeTimers();
    const { startBoardLink, openRenderStudio } = await import('./link');
    const store = createAppStore();
    const { platform, sent, receive } = fakeStudioPlatform();
    startBoardLink(platform, store);

    // Nothing goes out before the studio says hello.
    store.setState({ doc: { ...store.getState().doc, meta: { ...store.getState().doc.meta, name: 'A' } } });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);

    receive({ type: 'hello' });
    expect(sent.at(-1)).toMatchObject({ type: 'scene', name: 'A' });
    expect(sent.at(-1)?.['camera']).toBeUndefined();

    // Edits are debounced into one message.
    store.setState({ doc: { ...store.getState().doc, meta: { ...store.getState().doc.meta, name: 'B' } } });
    store.setState({ doc: { ...store.getState().doc, meta: { ...store.getState().doc.meta, name: 'C' } } });
    vi.advanceTimersByTime(1000);
    expect(sent.filter((m) => m.type === 'scene')).toHaveLength(2);
    expect(sent.at(-1)).toMatchObject({ name: 'C' });

    // Sending a view while open carries its camera once.
    const camera = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50 };
    openRenderStudio(platform, camera, 'Entrance');
    expect(platform.window.openRender).toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: 'scene', camera, viewName: 'Entrance' });

    // D5 import requests one bake. Later scene updates must not restart it.
    openRenderStudio(platform, undefined, undefined, true);
    expect(sent.at(-1)).toMatchObject({ prepare: 'bake' });
    store.setState({ doc: { ...store.getState().doc, meta: { ...store.getState().doc.meta, name: 'C' } } });
    vi.advanceTimersByTime(1000);
    expect(sent.at(-1)?.['prepare']).toBeUndefined();

    receive({ type: 'bye' });
    store.setState({ doc: createEmptyDocument({ ids: sequentialIds(), now: () => '2026-01-01T00:00:00.000Z', name: 'D' }) });
    vi.advanceTimersByTime(1000);
    expect(sent.at(-1)).toMatchObject({ name: 'C' });
  });
});

describe('render settings', () => {
  it('fall back to defaults for missing or invalid data and keep valid values', () => {
    expect(parseSettings(null)).toEqual(defaultSettings());
    expect(parseSettings('not json')).toEqual(defaultSettings());
    expect(parseSettings(JSON.stringify({ time: 99 }))).toEqual(defaultSettings());
    const saved = parseSettings(JSON.stringify({ sky: 'hdri', hdri: 'belfast_sunset_puresky', entourage: [{ id: 'e1', asset: 'jacaranda_tree', position: [1, 0, 2] }] }));
    expect(saved.sky).toBe('hdri');
    expect(saved.entourage[0]).toMatchObject({ asset: 'jacaranda_tree', rotation: 0, scale: 1 });
    expect(saved.time).toBe(15);
  });
});
