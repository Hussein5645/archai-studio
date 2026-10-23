import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const source=path.resolve(process.argv[2]), destination=path.resolve(process.argv[3]);
const xml=await fs.readFile(path.join(destination,'Engine/Build/Commit.gitdeps.xml'),'utf8');
let copied=0, bytes=0, index=0;
const files=[...xml.matchAll(/<File Name="([^"]+)" Hash="([a-f0-9]+)"/g)]
 .filter(match=>!/(^|\/)(Linux|Mac|Android|IOS|TVOS|HoloLens|Win32)(\/|$)/i.test(match[1]));
await Promise.all(Array.from({length:4},async()=>{
 while(index<files.length){
  const [,name,hash]=files[index++];
  const from=path.resolve(source,name),to=path.resolve(destination,name);
  if(!from.startsWith(source+path.sep)||!to.startsWith(destination+path.sep))throw Error('Invalid dependency path');
  if(await fs.stat(to).then(s=>s.isFile()).catch(()=>false))continue;
  const data=await fs.readFile(from).catch(()=>null);
  if(!data||createHash('sha1').update(data).digest('hex')!==hash)continue;
  await fs.mkdir(path.dirname(to),{recursive:true});await fs.writeFile(to,data,{flag:'wx'});
  copied++;bytes+=data.length;
  if(copied%2000===0)console.log(`${copied} verified files reused; ${Math.round(bytes/1024/1024)} MiB`);
 }
}));
console.log(JSON.stringify({copied,bytes,checked:files.length}));
