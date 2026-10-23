import fs from 'node:fs/promises';
import path from 'node:path';
import { build, Platform, Arch } from 'electron-builder';

if (!process.argv.includes('--legacy-bundled-unreal')) throw new Error('Unreal must be optional: use npm run dist:win and scripts/package-optional-unreal.mjs.');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return path.resolve(args[index + 1]);
}
const runtime = option('--runtime');
const output = option('--output');
const nativeHost = args.includes('--native-host') ? option('--native-host') : undefined;
const nativeLibrary = path.join(runtime, 'ArchaiRender/Binaries/Win64/ArchaiEmbedded.dll');
const hasNativeLibrary = await fs.access(nativeLibrary).then(() => true).catch(() => false);
if (hasNativeLibrary !== Boolean(nativeHost)) throw new Error('Native releases require both the staged Unreal library and --native-host addon.');
if (nativeHost) {
  await fs.access(nativeHost);
  await fs.access(path.join(runtime, 'ArchaiRender/ArchaiRender.uproject'));
}
const runtimeFilter = ['**/*', '!ArchaiRender/Binaries/Win64/ArchaiRender.exe', '!**/*.pdb', '!**/*.debug', '!**/Saved/**', '!**/Logs/**', '!**/Crashes/**'];
const prepackaged = args.includes('--repack') ? path.join(output, 'win-unpacked') : undefined;
if (prepackaged) {
  await fs.access(path.join(prepackaged, 'ArchAI.exe'));
  await fs.cp('unreal', path.join(prepackaged, 'resources/unreal-worker'), { recursive: true,
    filter: file => !/[\\/](Binaries|Intermediate|Saved|__pycache__)([\\/]|$)/.test(file) });
  await fs.cp(runtime, path.join(prepackaged, 'resources/unreal'), { recursive: true,
    filter: file => !/[\\/](Saved|Logs|Crashes)([\\/]|$)/.test(file) && !file.endsWith('.pdb') && !file.endsWith('.debug') });
  if (nativeHost) {
    await fs.mkdir(path.join(prepackaged, 'resources/unreal-native'), { recursive: true });
    await fs.copyFile(nativeHost, path.join(prepackaged, 'resources/unreal-native/archai_unreal_host.node'));
  } else if (await fs.access(path.join(prepackaged, 'resources/unreal/ArchaiRender/Binaries/Win64/ArchaiEmbedded.dll')).then(() => true).catch(() => false)) {
    throw new Error('This unpacked release already contains native Unreal. Choose a new output directory.');
  }
}
await fs.access(path.join(runtime, 'ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe'));
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never', prepackaged,
  config: { ...pkg.build, directories: { ...pkg.build.directories, output },
    nsis: { ...pkg.build.nsis, artifactName: `ArchAI-Setup-${pkg.build.buildVersion}.\u0024{ext}` },
    extraResources: [{ from: 'unreal', to: 'unreal-worker', filter: ['**/*', '!**/Binaries/**', '!**/Intermediate/**', '!**/Saved/**', '!**/__pycache__/**'] },
      { from: runtime, to: 'unreal', filter: runtimeFilter },
      ...(nativeHost ? [{ from: nativeHost, to: 'unreal-native/archai_unreal_host.node' }] : [])] } });
