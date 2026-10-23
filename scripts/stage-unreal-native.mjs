import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const args=process.argv.slice(2);
function option(name){const i=args.indexOf(name);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing '+name);return path.resolve(args[i+1]);}
const runtime=option('--runtime'),library=option('--library'),output=option('--output');
const root=fileURLToPath(new URL('../',import.meta.url));
const addon=args.includes('--addon')?option('--addon'):path.join(root,'native/unreal-host/build/Release/archai_unreal_host.node');
if(output===runtime||runtime.startsWith(output+path.sep)||output.startsWith(runtime+path.sep))throw Error('Choose a separate staging directory.');
await Promise.all([fs.access(library),fs.access(addon),fs.access(path.join(runtime,'ArchaiRender/Content/Paks'))]);
const marker='.archai-native-stage';
await fs.mkdir(output,{recursive:true});
const entries=await fs.readdir(output);
if(entries.length&&!entries.includes(marker))throw Error('Choose an empty native staging directory.');
await fs.writeFile(path.join(output,marker),'Archai native Unreal runtime staging\n');
const stagedRuntime=path.join(output,'unreal');
await fs.cp(runtime,stagedRuntime,{recursive:true,filter:file=>!/[\\/](Saved|Logs|Crashes)([\\/]|$)/.test(file)&&!file.endsWith('.pdb')&&!file.endsWith('.debug')});
const stagedLibrary=path.join(stagedRuntime,'ArchaiRender/Binaries/Win64/ArchaiEmbedded.dll');
await fs.copyFile(library,stagedLibrary);
await fs.copyFile(path.join(root,'unreal/ArchaiRender/ArchaiRender.uproject'),path.join(stagedRuntime,'ArchaiRender/ArchaiRender.uproject'));
await fs.mkdir(path.join(output,'unreal-native'),{recursive:true});
const stagedAddon=path.join(output,'unreal-native/archai_unreal_host.node');
await fs.copyFile(addon,stagedAddon);
const config={ARCHAI_UNREAL_LIBRARY:stagedLibrary,ARCHAI_NATIVE_RUNTIME_ROOT:stagedRuntime,ARCHAI_UNREAL_NATIVE_HOST:stagedAddon,
 ARCHAI_RENDER_RUNTIME:path.join(stagedRuntime,'ArchaiRender/Binaries/Win64/ArchaiRender-Win64-Shipping.exe')};
await fs.writeFile(path.join(output,'environment.json'),JSON.stringify(config,null,2));
console.log('Staged Unreal library, cooked content and native host. This staging step does not verify runtime compatibility.');
console.log(JSON.stringify(config,null,2));
