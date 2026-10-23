import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = 'F:/Archai-Releases/0.3.0.8/native-check-3';
const exportRoot = path.join(root, (await fs.readdir(root)).find((name) => name.startsWith('Archai-Experience-')));
const scene = path.join(exportRoot, 'Scene');
const ticket = JSON.parse(await fs.readFile(path.join(scene, 'session.json'), 'utf8'));
const executable = path.join(exportRoot, 'Runtime/ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe');
const child = spawn(executable, [`-ArchaiSession=${scene}`, `-ArchaiToken=${ticket.token}`, '-windowed', '-ResX=1000', '-ResY=720', '-nosplash'], { windowsHide: false, stdio: 'ignore' });
const read = () => fs.readFile(path.join(scene, 'status.json'), 'utf8').then(JSON.parse).catch(() => null);
try {
  for (let i = 0; i < 120 && (await read())?.state !== 'ready'; i++) await delay(1000);
  const before = await read();
  if (before?.state !== 'ready') throw new Error('Exported player did not become ready');
  await fs.writeFile(path.join(root, 'input-ready'), 'ready');
  console.log('Exported player ready for pointer verification.');
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline && !await fs.access(path.join(root, 'input-done')).then(() => true).catch(() => false)) await delay(1000);
  const after = await read();
  const selected = (after?.selectionSequence ?? 0) > (before.selectionSequence ?? 0) && Boolean(after.selectedObject);
  const navigated = JSON.stringify(before.viewCamera) !== JSON.stringify(after?.viewCamera);
  await fs.writeFile(path.join(root, 'input-verification.json'), JSON.stringify({ selected, navigated, beforeCamera: before.viewCamera, afterCamera: after?.viewCamera, selectedObject: after?.selectedObject }, null, 2));
  if (!selected || !navigated) throw new Error('Pointer selection or navigation was not verified');
  console.log('Exported element selection and orbit input verified.');
} finally { child.kill(); }
