import path from 'node:path';
import fs from 'node:fs/promises';
import { build, Platform, Arch } from 'electron-builder';

const index = process.argv.indexOf('--output');
if (index < 0 || !process.argv[index + 1]) throw new Error('Provide --output <release directory>');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
  config: { ...pkg.build, directories: { ...pkg.build.directories, output: path.resolve(process.argv[index + 1]) },
    nsis: { ...pkg.build.nsis, artifactName: `ArchAI-Setup-${pkg.build.buildVersion}.\u0024{ext}` },
    extraResources: [] } });
