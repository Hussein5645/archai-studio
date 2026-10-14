import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('VR menu opens preparation, produces a baked GLB, and invalidates it after a board edit', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__archai));
  await page.evaluate(async () => {
    const { executor } = window.__archai!;
    await executor.dispatch('new-document');
    await executor.dispatch('create-arch-element', { tool: 'column', x: 0, y: 0 });
    await executor.dispatch('create-vr-stop', { x: 3000, y: 3000 });
    await executor.dispatch('open-view3d', {});
  });
  await page.locator('summary').filter({ hasText: 'VR' }).click();
  await expect(page.getByRole('button', { name: 'Export Raw VR Link', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Render', exact: true })).toHaveCount(0);
  const opened = context.waitForEvent('page');
  await page.getByTestId('open-render-studio').click();
  const studio = await opened;
  await studio.waitForLoadState();
  await expect(studio.getByRole('button', { name: 'Bake scene', exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await studio.getByLabel('Quality', { exact: true }).selectOption('fast');
  await studio.getByRole('button', { name: 'none', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'Bake scene', exact: true })).toBeEnabled();
  await studio.getByRole('button', { name: 'Bake scene', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'Publish VR link', exact: true })).toBeEnabled({
    timeout: 90_000,
  });
  await expect(studio.getByText('Prepared output is ready to preview and publish.')).toBeVisible();
  await expect(studio.getByRole('button', { name: 'Paint', exact: true })).toHaveCount(0);
  // The output is a glTF unlit scene with genuinely sampled colour attributes.
  const exportCheck = await studio.evaluate(async () => {
    const instance = (
      window as unknown as {
        __studio: {
          bakeVr(
            quality: string,
            signal: AbortSignal,
            progress: (value: number) => void,
          ): Promise<{ model: ArrayBuffer }>;
        };
      }
    ).__studio;
    const result = await instance.bakeVr('fast', new AbortController().signal, () => undefined);
    const bytes = new DataView(result.model);
    const length = bytes.getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(result.model, 20, length)));
    return {
      model: Array.from(new Uint8Array(result.model)),
      magic: bytes.getUint32(0, true),
      unlit: gltf.extensionsUsed.includes('KHR_materials_unlit'),
      color: gltf.meshes.some((mesh: { primitives: { attributes: Record<string, number> }[] }) =>
        mesh.primitives.some((primitive) => primitive.attributes.COLOR_0 !== undefined),
      ),
    };
  });
  expect(exportCheck).toMatchObject({ magic: 0x46546c67, unlit: true, color: true });
  await writeFile(testInfo.outputPath('baked.glb'), new Uint8Array(exportCheck.model));
  const panorama = await studio.evaluate(async () => {
    const moduleUrl = '/src/studio/vrPreparation.ts';
    const { VR_QUALITY } = await import(moduleUrl);
    const preset = VR_QUALITY.fast;
    const saved = { width: preset.panoramaWidth, samples: preset.panoramaSamples };
    // Small real GPU capture for integration; production presets remain unchanged.
    preset.panoramaWidth = 256;
    preset.panoramaSamples = 2;
    const instance = (
      window as unknown as {
        __studio: {
          getCamera(): unknown;
          renderPanorama(
            quality: string,
            signal: AbortSignal,
            progress: (value: number) => void,
          ): Promise<Blob>;
        };
      }
    ).__studio;
    const camera = JSON.stringify(instance.getCamera());
    try {
      const blob = await instance.renderPanorama(
        'fast',
        new AbortController().signal,
        () => undefined,
      );
      const bitmap = await createImageBitmap(blob);
      const result = {
        width: bitmap.width,
        height: bitmap.height,
        type: blob.type,
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
        restored: camera === JSON.stringify(instance.getCamera()),
      };
      bitmap.close();
      return result;
    } finally {
      preset.panoramaWidth = saved.width;
      preset.panoramaSamples = saved.samples;
    }
  });
  expect(panorama).toMatchObject({ width: 256, height: 128, type: 'image/png', restored: true });
  await writeFile(testInfo.outputPath('panorama.png'), new Uint8Array(panorama.bytes));
  await page.evaluate(async () => {
    await window.__archai!.executor.dispatch('create-arch-element', {
      tool: 'column',
      x: 4000,
      y: 0,
    });
  });
  await expect(studio.getByRole('button', { name: 'Publish VR link', exact: true })).toBeDisabled();
  await expect(studio.getByText(/prepared output is outdated/)).toBeVisible();
  await studio.getByRole('button', { name: '360 image', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'Render 360 image', exact: true })).toBeEnabled();
  await studio.close();
});
