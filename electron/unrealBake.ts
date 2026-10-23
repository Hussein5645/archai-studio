import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { unzipSync } from 'fflate';
import { readRenderPackage } from './renderPackage.js';
import type { UnrealStatus } from '../shared/unrealRuntime.js';

type BakeStatus = NonNullable<UnrealStatus['bake']>;
/** Runs only on a trusted Unreal build worker; the distributed experience contains no editor. */
export class UnrealBake {
  status: BakeStatus | undefined;
  private starting = false;
  private cancelled = false;
  private child: ChildProcess | null = null;
  cancel() { this.cancelled = true; this.child?.kill(); }
  constructor(private readonly engine: string, private readonly sources: string) {}
  async available() {
    try { await fs.access(path.join(this.engine, 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe')); await fs.access(path.join(this.sources, 'ArchaiRender/ArchaiRender.uproject')); return true; }
    catch { return false; }
  }
  async start(bytes: Uint8Array, workspace: string): Promise<void> {
    if (this.starting || this.status?.state === 'running') throw new Error('An Unreal bake is already running.');
    this.starting = true;
    try {
    if (!await this.available()) throw new Error('An Unreal build worker is required for baked lighting.');
    await readRenderPackage(bytes);
    await fs.mkdir(workspace); // Always a new dedicated build, never an existing project.
    await fs.writeFile(path.join(workspace, '.archai-unreal-bake'), '1\n');
    this.status = { state: 'running', stage: 'Preparing Unreal bake' };
    await fs.writeFile(path.join(workspace, 'job-status.json'), JSON.stringify(this.status));
    this.cancelled = false;
    void this.run(bytes, workspace).catch((error: unknown) => {
      this.status = { state: 'error', stage: 'Unreal bake failed', error: String(error), output: workspace };
      void fs.writeFile(path.join(workspace, 'job-status.json'), JSON.stringify(this.status)).catch(() => undefined);
    });
    } finally { this.starting = false; }
  }
  async resume(workspace: string) {
    if (this.status?.state === 'running') throw new Error('An Unreal bake is already running.');
    if ((await fs.readFile(path.join(workspace, '.archai-unreal-bake'), 'utf8')).trim() !== '1') throw new Error('Not an Archai bake workspace.');
    const bytes = new Uint8Array(await fs.readFile(path.join(workspace, 'Input/scene-package.zip')));
    await readRenderPackage(bytes);
    this.cancelled = false;
    this.status = { state: 'running', stage: 'Resuming Unreal bake' };
    void this.run(bytes, workspace, true).catch((error: unknown) => {
      this.status = { state: 'error', stage: 'Unreal bake failed', error: String(error), output: workspace };
    });
  }
  private async run(bytes: Uint8Array, workspace: string, resume = false) {
    const stage = (text: string) => { this.status = { state: 'running', stage: text }; };
    if (!resume) {
    await fs.cp(path.join(this.sources, 'ArchaiRender'), workspace, { recursive: true });
    await fs.mkdir(path.join(workspace, 'Input'));
    await fs.mkdir(path.join(workspace, 'Temp'));
    await fs.writeFile(path.join(workspace, 'Input/scene-package.zip'), bytes);
    for (const [name, data] of Object.entries(unzipSync(bytes))) await fs.writeFile(path.join(workspace, 'Input', name), data);
    const project = path.join(workspace, 'ArchaiRender.uproject');
    const descriptor = JSON.parse(await fs.readFile(project, 'utf8')) as { Plugins: Array<{ Name: string; Enabled: boolean }> };
    if (!descriptor.Plugins.some((plugin) => plugin.Name === 'OpenXR')) descriptor.Plugins.push({ Name: 'OpenXR', Enabled: true });
    await fs.writeFile(project, JSON.stringify(descriptor));
    const config = path.join(workspace, 'Config/DefaultEngine.ini');
    let engineConfig = await fs.readFile(config, 'utf8');
    engineConfig = engineConfig.replaceAll('/Game/Archai/Viewer', '/Game/Archai/BakedScene')
      .replace('r.DynamicGlobalIlluminationMethod=1', 'r.DynamicGlobalIlluminationMethod=0')
      .replace('r.ReflectionMethod=1', 'r.ReflectionMethod=2');
    engineConfig = engineConfig.replace('r.RayTracing=True', 'r.RayTracing=False').replace('r.Lumen.HardwareRayTracing=True', 'r.Lumen.HardwareRayTracing=False');
    engineConfig += '\n[/Script/Engine.RendererSettings]\nr.AllowStaticLighting=True\n';
    await fs.writeFile(config, engineConfig);
    const gameConfig = path.join(workspace, 'Config/DefaultGame.ini');
    await fs.writeFile(gameConfig, (await fs.readFile(gameConfig, 'utf8')).replaceAll('/Game/Archai/Viewer', '/Game/Archai/BakedScene'));
    } else {
      await fs.cp(path.join(this.sources, 'ArchaiRender/Source'), path.join(workspace, 'Source'), { recursive: true });
      await fs.copyFile(path.join(this.sources, 'ArchaiRender/Config/DefaultInput.ini'), path.join(workspace, 'Config/DefaultInput.ini'));
    }
    const project = path.join(workspace, 'ArchaiRender.uproject');
    const dotnet = path.join(this.engine, 'Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe');
    const editor = path.join(this.engine, 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe');
    const env = { ...process.env, TEMP: path.join(workspace, 'Temp'), TMP: path.join(workspace, 'Temp'), 'UE-LocalDataCachePath': path.join(path.dirname(workspace), 'Archai-Unreal-Cache') };
    const run = async (file: string, args: string[], log: string) => {
      if (this.cancelled) throw new Error('Bake cancelled because Archai closed.');
      const handle = await fs.open(path.join(workspace, log), 'w');
      try {
        const child = spawn(file, args, { env, shell: false, windowsHide: true, cwd: path.join(this.engine, 'Engine/Source'), stdio: ['ignore', handle.fd, handle.fd] });
        this.child = child;
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        if (code !== 0) { if (this.cancelled) throw new Error('Bake interrupted because Archai closed. Open the project and bake again.'); throw new Error(`${log}: Unreal returned ${String(code)}. Details are saved in ${workspace}.`); }
      } finally { this.child = null; await handle.close(); }
    };
    stage('Compiling the Unreal bake worker');
    await run(dotnet, [path.join(this.engine, 'Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll'), 'ArchaiRenderEditor', 'Win64', 'Development', project, '-WaitMutex', '-NoHotReload', '-NoUBA'], 'compile.log');
    stage('Preparing materials and lightmap UVs. The first bake can take several minutes.');
    await run(editor, [project, '-run=pythonscript', `-script=${path.join(this.sources, 'prepare_baked_scene.py').replaceAll('\\', '/')}`, '-unattended', '-nosplash', '-nosound', '-AllowCommandletRendering', '-ddc=InstalledNoZenLocalFallback'], 'import.log');
    const prepared = JSON.parse(await fs.readFile(path.join(workspace, 'bake-import.json'), 'utf8')) as { success: boolean; error?: string };
    if (!prepared.success) throw new Error(prepared.error || 'Unreal scene import failed');
    stage('Baking static lighting with Unreal Lightmass');
    await run(editor, [project, '-run=ResavePackages', '-buildlighting', '-quality=Preview', '-map=/Game/Archai/BakedScene', '-allowcommandletrendering', '-unattended', '-nosplash', '-nosound', '-IgnoreChangeList', '-ddc=InstalledNoZenLocalFallback'], 'lightmass.log');
    stage('Verifying baked lightmaps');
    await run(editor, [project, '-run=pythonscript', `-script=${path.join(this.sources, 'verify_baked_scene.py').replaceAll('\\', '/')}`, '-unattended', '-nosplash', '-nosound', '-AllowCommandletRendering', '-ddc=InstalledNoZenLocalFallback'], 'verify.log');
    const verified = JSON.parse(await fs.readFile(path.join(workspace, 'bake-verification.json'), 'utf8')) as { success: boolean };
    if (!verified.success) throw new Error('The scene has missing baked lightmaps; see bake-verification.json.');
    stage('Packaging the walkable Windows / OpenXR experience');
    await run(dotnet, [path.join(this.engine, 'Engine/Binaries/DotNET/AutomationTool/AutomationTool.dll'), '-WaitForUATMutex', 'BuildCookRun', `-project=${project}`, '-noP4', '-platform=Win64', '-clientconfig=Shipping', '-build', '-cook', '-stage', '-pak', '-archive', `-archivedirectory=${path.join(workspace, 'Experience')}`, '-unattended', '-utf8output', '-ddc=InstalledNoZenLocalFallback'], 'package.log');
    await fs.access(path.join(workspace, 'Experience/Windows/ArchaiRender.exe'));
    await fs.writeFile(path.join(workspace, 'Experience/README.txt'), 'Archai baked Unreal experience\n\nStart Windows/ArchaiRender.exe for desktop.\nFor PC VR, select your headset OpenXR runtime, connect the headset, and launch ArchaiRender.exe -vr.\nHeadset and controller compatibility require testing on your device.\nThis output does not require the Unreal editor. It is not a browser or standalone Quest package.\n');
    const ready = { state: 'ready' as const, stage: 'Baked Unreal experience ready', output: path.join(workspace, 'Experience') };
    await fs.writeFile(path.join(workspace, 'job-status.json'), JSON.stringify(ready));
    this.status = ready;
  }
}
