import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(process.argv[2]||'E:/Archai-UnrealSource/host-check');await fs.mkdir(root,{recursive:true});
const repo=fileURLToPath(new URL('../',import.meta.url));
const stub=path.join(root,'host-test-library.cpp'),dll=path.join(root,'host-test-library.dll');
await fs.writeFile(stub,`#include <windows.h>
#include <atomic>
#include <string>
static HWND Window;static DWORD InitThread;static std::atomic<DWORD> SubmitThread=0;static std::atomic<unsigned> AssetBytes=0,Ticks=0,Messages=0;
extern "C" __declspec(dllexport) int UELibrary_InitW(HINSTANCE,HWND window,const wchar_t*){Window=window;InitThread=GetCurrentThreadId();return 0;}
extern "C" __declspec(dllexport) int UELibrary_Tick(){Ticks++;SendMessageW(Window,WM_APP+11,0,0);return 0;}
extern "C" __declspec(dllexport) int UELibrary_Shutdown(){return 0;}
extern "C" __declspec(dllexport) LRESULT UELibrary_WndProc(HWND window,UINT message,WPARAM w,LPARAM l){if(message==WM_APP+11){Messages++;return 0;}return DefWindowProcW(window,message,w,l);}
extern "C" __declspec(dllexport) int Archai_Submit(const char*,const char*){SubmitThread=GetCurrentThreadId();return 0;}
extern "C" __declspec(dllexport) int Archai_Asset(const char*,const void*,unsigned bytes){AssetBytes+=bytes;return 0;}
extern "C" __declspec(dllexport) const char* Archai_Status(){thread_local std::string text;text=R"({"pid":)"+std::to_string(GetCurrentProcessId())+R"(,"initThread":)"+std::to_string(InitThread)+R"(,"submitThread":)"+std::to_string(SubmitThread.load())+R"(,"assetBytes":)"+std::to_string(AssetBytes.load())+R"(,"ticks":)"+std::to_string(Ticks.load())+R"(,"messages":)"+std::to_string(Messages.load())+"}";return text.c_str();}
`);
// The test library exercises hosting, threading and messages, not Unreal rendering.
const compile=path.join(root,'compile.cmd');
await fs.writeFile(compile,`@echo off\r\ncall "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\Tools\\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul\r\ncl /nologo /std:c++17 /EHsc /LD "${stub}" /Fe:"${dll}" user32.lib\r\n`);
async function run(file,args,options={}){
 const child=spawn(file,args,{cwd:root,windowsHide:true,stdio:'inherit',...options});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});if(code!==0)throw Error(`Host check failed (${code})`);
}
await run(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${compile}""`],{windowsVerbatimArguments:true});
const main=path.join(root,'main.cjs'),report=path.join(root,'verification.json');
await fs.writeFile(main,`const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),assert=require('node:assert/strict');
const addon=require(${JSON.stringify(path.join(repo,'native/unreal-host/build/Release/archai_unreal_host.node'))});
app.whenReady().then(async()=>{let window;try{
 window=new BrowserWindow({show:false});const handle=window.getNativeWindowHandle();const parent=(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString();
 addon.start(${JSON.stringify(dll)},parent,'host-check');const deadline=Date.now()+30000;
 while(!addon.state().ready){if(addon.state().error)throw Error(addon.state().error);if(Date.now()>deadline)throw Error('Native thread did not initialize');await new Promise(r=>setTimeout(r,20));}
 addon.submit('scene','{}');addon.asset('asset-test.mesh',Buffer.from([1,2,3,4]));await new Promise(r=>setTimeout(r,50));
 const data=JSON.parse(addon.status());assert.equal(data.pid,process.pid);assert.notEqual(data.initThread,data.submitThread);assert.equal(data.assetBytes,4);assert.ok(data.ticks>0&&data.messages>0);
 addon.hide();addon.stop();while(!addon.state().stopped){if(Date.now()>deadline)throw Error('Native thread did not shut down');await new Promise(r=>setTimeout(r,20));}addon.join();assert.equal(addon.state().ready,false);fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({success:true,scope:'Native DLL host only; test library is not Unreal',...data},null,2));window.destroy();app.quit();
 }catch(error){fs.writeFileSync(${JSON.stringify(path.join(root,'error.txt'))},String(error.stack||error));if(window)window.destroy();app.exit(1);}});`);
await run(path.join(repo,'node_modules/electron/dist/electron.exe'),[main,'--user-data-dir='+path.join(root,'profile')]);
console.log(await fs.readFile(report,'utf8'));
