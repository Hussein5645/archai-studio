import path from 'node:path';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

type Addon={start(library:string,parent:string,command:string):void;state():{ready:boolean;stopped:boolean;error:string};submit(channel:string,json:string):void;asset(name:string,bytes:Buffer):void;status():string;hide():void;stop():void;join():void};
/** One Unreal library instance, ticked by a native thread inside the Archai process. */
export class UnrealNativeHost {
  private addon:Addon|null=null;
  private parent='';
  private layout='';
  private readonly assets=new Set<string>();
  private readyJob:Promise<void>|null=null;
  constructor(readonly library:string,readonly addonPath:string,private readonly runtimeRoot:string){}
  launch(parent:string,directory:string,token:string,projectId:string):ChildProcess {
    const child=Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null,
      kill:()=>{
        if(this.addon?.state().ready){
          this.viewport(JSON.stringify({...JSON.parse(this.layout||'{}'),token,visible:false}));
          // Clear the old world's resources without shutting down the library,
          // which cannot be initialized a second time in this process.
          this.addon.submit('configure',JSON.stringify({directory,token,projectId}));
          this.assets.clear();
        }
        this.addon?.hide();child.exitCode=0;child.emit('exit',0);return true;
      }});
    this.readyJob=(async()=>{
      if(!this.addon){
        const base=path.join(this.runtimeRoot,'ArchaiRender/Binaries/Win64');
        const project=path.join(this.runtimeRoot,'ArchaiRender/ArchaiRender.uproject');
        // Unreal resolves its base directory from the DLL module before parsing the
        // library command line. A -basedir argument alone cannot relocate cooked data.
        if(path.resolve(path.dirname(this.library)).toLowerCase()!==path.resolve(base).toLowerCase())
          throw Error('Stage the Unreal library beside its matching cooked runtime in ArchaiRender/Binaries/Win64.');
        this.addon=createRequire(import.meta.url)(this.addonPath) as Addon;
        this.parent=parent;
        // The engine outlives individual scenes and keeps its log handle open.
        // Keep that log outside the ephemeral scene directory so stop can remove it.
        const command=`"${project}" /Game/Archai/Viewer -basedir="${base}" -pak -game -windowed -NoHMD -nosound -nosplash -abslog="${path.join(path.dirname(directory),'native-engine.log')}" -ArchaiSession="${directory}" -ArchaiToken=${token} -ArchaiParent=${parent}`;
        this.addon.start(this.library,parent,command);
      }else if(parent!==this.parent)throw Error('Native Unreal supports one Archai host window per application process.');
      const deadline=Date.now()+180000;
      while(!this.addon.state().ready){
        const state=this.addon.state();if(state.error)throw Error(state.error);
        if(Date.now()>deadline)throw Error('Native Unreal did not finish initializing.');
        await delay(50);
      }
      this.assets.clear();this.addon.submit('configure',JSON.stringify({directory,token,projectId}));
      if(this.layout)this.addon.submit('viewport',this.layout);
    })();
    void this.readyJob.catch(error=>child.emit('error',error));
    return child as unknown as ChildProcess;
  }
  async ready(){await this.readyJob;}
  viewport(json:string){this.layout=json;if(this.addon?.state().ready)this.addon.submit('viewport',json);}
  status(){return this.addon?.status()??'{}';}
  error(){return this.addon?.state().error??'';}
  submit(channel:string,json:string){if(!this.addon?.state().ready)throw Error('Native Unreal is not ready.');this.addon.submit(channel,json);}
  hasAsset(name:string){return this.assets.has(name);}
  retain(names:Set<string>){for(const name of this.assets)if(!names.has(name))this.assets.delete(name);this.submit('retain',JSON.stringify({assets:[...names]}));}
  asset(name:string,bytes:Uint8Array){
    if(!this.addon)throw Error('Native Unreal is not initialized.');
    this.addon.asset(name,Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));this.assets.add(name);
  }
  async shutdown(){
    if(!this.addon)return;this.addon.stop();
    const deadline=Date.now()+30000;
    while(!this.addon.state().stopped){if(Date.now()>deadline)throw Error('Native Unreal shutdown did not finish.');await delay(20);}
    this.addon.join();
  }
}
