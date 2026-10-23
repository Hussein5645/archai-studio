import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(`Missing ${name}`);return path.resolve(args[i+1]);};
const engine=option('--engine'), workspace=option('--workspace');
const sdk=args.includes('--dotnet')?option('--dotnet'):null;
const installedTools=args.includes('--installed-tools')?option('--installed-tools'):null;
const configuration=args.includes('--development')?'Development':'Shipping';
const jobs=args.includes('--jobs')?Number(args[args.indexOf('--jobs')+1]):4;
if(!Number.isInteger(jobs)||jobs<1||jobs>12)throw Error('Choose 1–12 compiler jobs.');
if(await fs.access(path.join(engine,'Engine/Build/InstalledBuild.txt')).then(()=>true).catch(()=>false))
 throw Error('Unreal library integration requires a source engine build. The selected installation is an installed build.');
await fs.mkdir(workspace,{recursive:true});
const marker=path.join(workspace,'.archai-library-build');
const entries=await fs.readdir(workspace);
if(entries.length&&!entries.includes('.archai-library-build'))throw Error('Choose an empty library build workspace.');
await fs.writeFile(marker,'Archai native library build workspace\n');
const root=fileURLToPath(new URL('../',import.meta.url));
await fs.cp(path.join(root,'unreal/ArchaiRender'),workspace,{recursive:true,filter:file=>!['ArchaiRender.Target.cs','ArchaiRenderEditor.Target.cs'].includes(path.basename(file))});
await fs.copyFile(path.join(root,'unreal/library/ArchaiEmbedded.Target.cs'),path.join(workspace,'Source/ArchaiEmbedded.Target.cs'));
await fs.mkdir(path.join(workspace,'Temp'),{recursive:true});
// UE's library mode initializes Slate as permanently inactive and suppresses
// subsequent activation events. A native child viewport consequently never
// activates its game input. Scope this fix to UE_LIBRARY_ENABLED builds.
const slateFile=path.join(engine,'Engine/Source/Runtime/Slate/Private/Framework/Application/SlateApplication.cpp');
const slate=await fs.readFile(slateFile,'utf8');
if(!slate.includes('// Archai: activate game input in the hosted library viewport.')){
 const original='bAppIsActive = !GUELibraryOverrideSettings.bIsEmbedded;';
 if(slate.split(original).length!==2)throw Error('Review the embedded Slate activation fix for this engine version.');
 await fs.writeFile(slateFile,slate.replace(original,`// Archai: activate game input in the hosted library viewport.
#if defined(UE_LIBRARY_ENABLED) && UE_LIBRARY_ENABLED
\tbAppIsActive = true;
#else
\t${original}
#endif`));
}
if(args.includes('--prepare-only'))process.exit(0);
const bat=path.join(engine,'Engine/Build/BatchFiles/Build.bat');
const command=`"${bat}" ArchaiEmbedded Win64 ${configuration} "${path.join(workspace,'ArchaiRender.uproject')}" -NoHotReload -NoUBA -MaxParallelActions=${jobs} -UBARootDir="${path.join(workspace,'UBA')}" -UBAStoreCapacityGb=20`;
let executable=process.env.ComSpec||'cmd.exe',parameters=['/d','/s','/c',`"${command}"`];
if(installedTools){
 const sourceVersion=JSON.parse(await fs.readFile(path.join(engine,'Engine/Build/Build.version'),'utf8'));
 const toolVersion=JSON.parse(await fs.readFile(path.join(installedTools,'Engine/Build/Build.version'),'utf8'));
 if(['MajorVersion','MinorVersion','PatchVersion'].some(key=>sourceVersion[key]!==toolVersion[key]))throw Error('Build tools must match the source engine version.');
 await fs.cp(path.join(installedTools,'Engine/Binaries/DotNET/UnrealBuildTool'),path.join(engine,'Engine/Binaries/DotNET/UnrealBuildTool'),{recursive:true});
 executable=path.join(sdk??path.join(installedTools,'Engine/Binaries/ThirdParty/DotNet/10.0/win-x64'),'dotnet.exe');
 parameters=[path.join(engine,'Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll'),'ArchaiEmbedded','Win64',configuration,path.join(workspace,'ArchaiRender.uproject'),'-NoHotReload','-NoUBA',`-MaxParallelActions=${jobs}`,`-UBARootDir=${path.join(workspace,'UBA')}`,'-UBAStoreCapacityGb=20'];
}
const child=spawn(executable,parameters,{cwd:engine,stdio:'inherit',windowsHide:true,windowsVerbatimArguments:!installedTools,
 env:{...process.env,...(sdk?{PATH:sdk+';'+process.env.PATH,UE_USE_SYSTEM_DOTNET:'1'}:{}),TEMP:path.join(workspace,'Temp'),TMP:path.join(workspace,'Temp'),'UE-LocalDataCachePath':path.join(workspace,'Cache'),
 NUGET_PACKAGES:path.join(workspace,'NuGet'),DOTNET_CLI_HOME:path.join(workspace,'DotNet'),UBA_ROOT:path.join(workspace,'UBA')}});
const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
if(code!==0)throw Error(`Unreal native library build failed (${code})`);
console.log('Built Unreal as a native library. Runtime hosting still requires its matching cooked content and the native host module.');
