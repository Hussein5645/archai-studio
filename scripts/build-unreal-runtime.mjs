import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return path.resolve(args[index + 1]);
}
const engine = option('--engine');
const workspace = option('--workspace');
const source = fileURLToPath(new URL('../unreal/ArchaiRender', import.meta.url));
const project = path.join(workspace, 'ArchaiRender.uproject');
await fs.mkdir(workspace, { recursive: true });
const marker = path.join(workspace, '.archai-runtime-build');
const existing = await fs.readdir(workspace);
if (existing.length && !existing.includes('.archai-runtime-build')) throw new Error('Choose an empty build workspace');
await fs.writeFile(marker, 'Archai runtime build workspace\n');
await fs.cp(source, workspace, { recursive: true });
await fs.mkdir(path.join(workspace, 'Temp'), { recursive: true });
const env = { ...process.env, TEMP: path.join(workspace, 'Temp'), TMP: path.join(workspace, 'Temp'),
  'UE-LocalDataCachePath': path.join(workspace, 'Cache') };
const dotnet = path.join(engine, 'Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe');
async function run(executable, parameters) {
  const child = spawn(executable, parameters, { stdio: 'inherit', windowsHide: true, env, shell: false,
    cwd: path.join(engine, 'Engine/Source') });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`Unreal build stage failed (${code})`);
}
await run(dotnet, [path.join(engine, 'Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll'),
  'ArchaiRenderEditor', 'Win64', 'Development', project, '-WaitMutex', '-NoHotReload', '-NoUBA', '-MaxParallelActions=2']);
if (!args.includes('--compile-only')) {
  const bootstrap = fileURLToPath(new URL('../unreal/bootstrap_runtime.py', import.meta.url));
  if (!args.includes('--skip-bootstrap')) await run(path.join(engine, 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'), [project, '-run=pythonscript', `-script=${bootstrap}`, '-unattended', '-nosplash', '-NoSound', '-NullRHI', '-ddc=InstalledNoZenLocalFallback']);
  await run(dotnet, [path.join(engine, 'Engine/Binaries/DotNET/AutomationTool/AutomationTool.dll'), '-WaitForUATMutex', 'BuildCookRun', `-project=${project}`, '-noP4', '-platform=Win64', `-clientconfig=${args.includes('--shipping') ? 'Shipping' : 'Development'}`,
    '-build', args.includes('--skip-cook') ? '-skipcook' : '-cook', '-stage', '-pak', '-archive', `-archivedirectory=${path.join(workspace, 'Packaged')}`, '-unattended', '-utf8output', '-ddc=InstalledNoZenLocalFallback']);
  if (args.includes('--shipping')) {
    const binaries = path.join(workspace, 'Packaged', 'Windows', 'ArchaiRender', 'Binaries', 'Win64');
    await fs.copyFile(path.join(binaries, 'ArchaiRender-Win64-Shipping.exe'), path.join(binaries, 'ArchaiRender.exe'));
  }
}
