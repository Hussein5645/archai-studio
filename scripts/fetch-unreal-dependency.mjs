import fs from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]);let names=process.argv.slice(3);
const xml=await fs.readFile(path.join(root,'Engine/Build/Commit.gitdeps.xml'),'utf8');
const attributes=text=>Object.fromEntries([...text.matchAll(/(\w+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
const files=new Map([...xml.matchAll(/<File ([^>]+)\/>/g)].map(match=>{const a=attributes(match[1]);return [a.Name,a];}));
const blobs=new Map([...xml.matchAll(/<Blob ([^>]+)\/>/g)].map(match=>{const a=attributes(match[1]);return [a.Hash,a];}));
const packs=new Map([...xml.matchAll(/<Pack ([^>]+)\/>/g)].map(match=>{const a=attributes(match[1]);return [a.Hash,a];}));
if(names.includes('--build-tools')){
 names=[];for(const [name] of files)if(name.startsWith('Engine/Source/Programs/')&&/\.(props|targets|cs)$/.test(name)&&!await fs.access(path.join(root,name)).then(()=>true).catch(()=>false))names.push(name);
 names.sort((a,b)=>blobs.get(files.get(a).Hash).PackHash.localeCompare(blobs.get(files.get(b).Hash).PackHash));
}
let previousHash='',previousRaw;
for(const name of names){
 const file=files.get(name);if(!file)throw Error('Dependency is not in Epic manifest: '+name);
 const blob=blobs.get(file.Hash),pack=packs.get(blob.PackHash);
 if(Number(pack.CompressedSize)>512*1024*1024)throw Error('Use GitDependencies for packs over 512 MiB.');
 const url=`https://cdn.unrealengine.com/dependencies/${pack.RemotePath}/${pack.Hash}`;
 let raw=previousRaw;
 if(previousHash!==pack.Hash){const response=await fetch(url);if(!response.ok)throw Error(`Epic download failed (${response.status})`);raw=gunzipSync(Buffer.from(await response.arrayBuffer()));previousRaw=raw;previousHash=pack.Hash;}
 const data=raw.subarray(Number(blob.PackOffset),Number(blob.PackOffset)+Number(blob.Size));
 if(createHash('sha1').update(data).digest('hex')!==file.Hash)throw Error('Dependency hash mismatch.');
 const destination=path.resolve(root,name);if(!destination.startsWith(root+path.sep))throw Error('Invalid dependency path.');
 await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination+'.archai-download',data);await fs.rename(destination+'.archai-download',destination);
 console.log(`Verified ${name} (${data.length} bytes)`);
}
