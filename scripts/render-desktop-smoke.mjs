import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('release/render-0.3.0.2');
await fs.mkdir(root, { recursive: true });
const profile = await fs.mkdtemp(path.join(root, 'smoke-profile-'));
const app = await electron.launch({ executablePath: path.resolve(process.argv[2] ?? 'release/win-unpacked/ArchAI.exe'),
  args: [`--user-data-dir=${profile}`], timeout: 60_000 });
try {
  const board = await app.firstWindow();
  await expect(board.getByTestId('home-app-version')).toHaveText('v0.3.0.2', { timeout: 30_000 });
  await board.getByTestId('create-project-btn').click();
  await board.getByRole('button', { name: 'Create Project', exact: true }).click();
  await expect(board.getByTestId('topbar-open-render-studio')).toBeVisible({ timeout: 30_000 });
  await board.screenshot({ path: path.join(root, 'board.png') });
  const opened = app.waitForEvent('window');
  await board.getByTestId('topbar-open-render-studio').click();
  const render = await opened;
  await expect(render.getByTestId('export-unreal-scene')).toBeEnabled({ timeout: 60_000 });
  await expect(render.getByText('Native preview · Unreal runtime not connected', { exact: true })).toBeVisible();
  await render.screenshot({ path: path.join(root, 'render.png') });
  console.log('Packaged desktop smoke passed: version, Board Render entry, scene connection, native preview.');
} finally {
  await app.close();
}
