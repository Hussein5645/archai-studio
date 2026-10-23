import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readRenderPackage } from './renderPackage.js';

/** Persistent user-owned Editor projects. Closing ArchAI never closes or deletes them. */
export class UnrealEditor {
  private children = new Map<string, ChildProcess>();
  private external = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private engine: string, private root: string, private script: string, private launchProcess: typeof spawn = spawn) {}

  open(bytes: Uint8Array, launch = true): Promise<string> {
    const job = this.queue.catch(() => undefined).then(() => this.apply(bytes, launch));
    this.queue = job;
    return job;
  }

  private async apply(bytes: Uint8Array, launch: boolean): Promise<string> {
    const executable = path.join(this.engine, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
    await fs.access(executable).catch(() => { throw new Error(`Unreal Editor was not found in ${this.engine}. Set ARCHAI_UNREAL_ENGINE to your Unreal installation.`); });
    const scene = await readRenderPackage(bytes);
    const key = createHash('sha256').update(scene.projectId).digest('hex').slice(0, 24);
    const directory = path.join(this.root, key);
    const project = path.join(directory, 'ArchaiScene.uproject');
    let running = this.children.has(key);
    const known = this.external.get(key);
    if (!running && known) {
      try { process.kill(known, 0); running = true; } catch { this.external.delete(key); }
    }
    if (!running && process.platform === 'win32') {
      try {
        const report = JSON.parse(await fs.readFile(path.join(directory, 'ArchaiSource', 'status.json'), 'utf8')) as { pid?: number };
        if (Number.isInteger(report.pid) && report.pid! > 0) {
          const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$archaiEditorProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${report.pid}'; ` +
            '$archaiEditorProcess.Name -eq "UnrealEditor.exe" -and $archaiEditorProcess.CommandLine.IndexOf($env:ARCHAI_EDITOR_PROJECT, [StringComparison]::OrdinalIgnoreCase) -ge 0'],
          { windowsHide: true, timeout: 10_000, env: { ...process.env, ARCHAI_EDITOR_PROJECT: project } });
          if (stdout.trim() === 'True') { this.external.set(key, report.pid!); running = true; }
        }
      } catch { /* No independently running Editor for this project. */ }
    }
    // Sync requests never reopen an Editor the user has closed.
    if (!launch && !running) return '';
    await fs.mkdir(path.join(directory, 'Content', 'Python'), { recursive: true });
    await fs.mkdir(path.join(directory, 'Config'), { recursive: true });
    try {
      await fs.writeFile(project, JSON.stringify({ FileVersion: 3, EngineAssociation: '5.8',
        Plugins: ['PythonScriptPlugin', 'EditorScriptingUtilities', 'Interchange', 'InterchangeAssets', 'MovieRenderPipeline', 'GLTFExporter', 'OpenXR']
          .map((Name) => ({ Name, Enabled: true })) }, null, 2), { flag: 'wx' });
      await fs.writeFile(path.join(directory, 'Config', 'DefaultEngine.ini'),
        '[/Script/EngineSettings.GameMapsSettings]\nEditorStartupMap=/Game/Archai/Scene\nGameDefaultMap=/Game/Archai/Scene\n\n' +
        '[/Script/Engine.RendererSettings]\nr.AllowStaticLighting=True\nr.DynamicGlobalIlluminationMethod=1\nr.ReflectionMethod=1\nr.GenerateMeshDistanceFields=True\n');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await fs.copyFile(this.script, path.join(directory, 'Content', 'Python', 'archai_editor.py'));
    await fs.writeFile(path.join(directory, 'Content', 'Python', 'init_unreal.py'), 'import archai_editor\narchai_editor.start()\n');
    const revision = randomUUID().replaceAll('-', '');
    const input = path.join(directory, 'ArchaiSource', revision);
    await fs.mkdir(input, { recursive: true });
    await fs.writeFile(path.join(input, 'scene.glb'), scene.model);
    const { model: _model, ...configuration } = scene;
    await fs.writeFile(path.join(input, 'render.json'), JSON.stringify(configuration));
    const pending = path.join(directory, 'ArchaiSource', 'pending.json');
    await fs.writeFile(`${pending}.tmp`, JSON.stringify({ revision, modelHash: scene.modelHash }));
    await fs.rename(`${pending}.tmp`, pending);
    if (launch && !running) {
      const child = this.launchProcess(executable, [project, '-NoSplash', '-NoSourceControl'], {
        detached: true, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, 'UE-LocalDataCachePath': process.env['ARCHAI_UNREAL_DDC'] || path.join(this.root, 'DerivedDataCache') },
      });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      this.children.set(key, child);
      child.once('exit', () => { if (this.children.get(key) === child) this.children.delete(key); });
      child.unref();
    }
    return project;
  }
}
