import { expect, test } from '@playwright/test';
import type { ArchaiBridge } from '../shared/ipc';

/** Small Z-up wall fixture: native folder selection is mocked, conversion and bake are real. */
function fixture() {
  const uint = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    return b;
  };
  const string = (value: string) =>
    Buffer.concat([uint(value.length), Buffer.from(value, 'utf16le')]);
  const values = (array: number[], integer = false) => {
    const b = Buffer.alloc(array.length * 4);
    array.forEach((v, i) => (integer ? b.writeUInt32LE(v, i * 4) : b.writeFloatLE(v, i * 4)));
    return Buffer.concat([uint(array.length), b]);
  };
  const matrix = values([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).subarray(4);
  const mesh = Buffer.concat([
    uint(11),
    string('{"upVector":2}'),
    uint(1),
    string('White'),
    string('<Material><DiffuseColor>#FFFFFF</DiffuseColor></Material>'),
    uint(1),
    string('Wall'),
    string('White'),
    matrix,
    uint(1),
    string('Wall'),
    values([0, 0, 0, 200, 0, 0, 200, 0, 300, 0, 0, 300]),
    values([]),
    values([]),
    values([]),
    values([0, 1, 2, 0, 2, 3], true),
  ]);
  return {
    name: 'D5 test room',
    files: [
      {
        name: 'asset/1.save',
        bytes: Array.from(
          Buffer.from(
            JSON.stringify({
              furnitureDatas: [{ productData: { id: 'wall', title: 'Wall' } }],
              landscape: { isLandscapeEnabled: true },
            }),
          ),
        ),
      },
      { name: 'asset/d5a/wall/1.d5mesh', bytes: Array.from(mesh) },
    ],
  };
}

test('D5 folder import reports omissions, inserts the scene, and automatically bakes VR', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async (data) => {
    const app = window.__archai!;
    await app.executor.dispatch('new-document', { name: 'D5 workflow test' });
    const id = app.store.getState().doc.id;
    await app.platform.storage.set(
      `vr-preparation:${id}`,
      JSON.stringify({ quality: 'fast', output: 'panorama' }),
    );
    await app.platform.storage.set(`render:${id}`, JSON.stringify({ ground: 'none', sky: 'sun' }));
    (window as Window & { archai?: ArchaiBridge }).archai = {
      platform: 'electron',
      onCommand: () => () => {},
      invoke: async <T>(channel: string, payload?: unknown): Promise<T> =>
        (channel === 'archai:files:openD5Folder'
          ? {
              ...data,
              sessionId: '30d6aa3b-91b0-43c4-bd53-18f1405b7762',
              files: data.files
                .filter((file) => file.name === 'asset/1.save')
                .map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) })),
            }
          : channel === 'archai:files:readD5Resources'
            ? data.files
                .filter((file) => (payload as { names: string[] }).names.includes(file.name))
                .slice(0, 1)
                .map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) }))
            : null) as T,
    };
    const opened = await app.executor.dispatch('import-d5-folder');
    if (!opened.ok) throw new Error(opened.error.message);
  }, fixture());
  const dialog = page.getByTestId('d5-import-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Choose D5 folder', exact: true }).click();
  await expect(page.getByTestId('d5-omissions')).toContainText('D5 terrain');
  await expect(dialog).toContainText('2 triangles');
  await page.screenshot({ path: testInfo.outputPath('d5-import-report.png') });
  const opened = context.waitForEvent('page');
  await dialog
    .getByRole('button', { name: 'Import partial scene and bake VR', exact: true })
    .click();
  const studio = await opened;
  await studio.waitForLoadState();
  await expect(dialog).toHaveCount(0);
  await expect(studio.getByRole('button', { name: 'Publish VR link', exact: true })).toBeEnabled({
    timeout: 90_000,
  });
  await expect(studio.getByText('Prepared output is ready to preview and publish.')).toBeVisible();
  const count = await page.evaluate(() => {
    const elements = Object.values(window.__archai!.store.getState().doc.elements) as {
      meta?: Record<string, unknown>;
    }[];
    return {
      meshes: elements.filter((element) => element.meta?.['mesh']).length,
      stops: elements.filter((element) => element.meta?.['vrStop']).length,
    };
  });
  expect(count).toEqual({ meshes: 1, stops: 1 });
  await studio.screenshot({ path: testInfo.outputPath('d5-baked-preview.png') });
});
