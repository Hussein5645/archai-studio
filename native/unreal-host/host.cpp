#include <node_api.h>
#include <windows.h>
#include <atomic>
#include <thread>
#include <mutex>
#include <string>
#include <stdexcept>
#include <chrono>

namespace {
using InitFn=int(*)(HINSTANCE,HWND,const wchar_t*);
using TickFn=int(*)();
using WndFn=LRESULT(*)(HWND,UINT,WPARAM,LPARAM);
using SubmitFn=int(*)(const char*,const char*);
using AssetFn=int(*)(const char*,const void*,uint32_t);
using StatusFn=const char*(*)();
std::thread EngineThread;
std::atomic<bool> Running=false,Ready=false,Started=false,Stopped=false;
std::atomic<HWND> Window=nullptr;
std::atomic<WndFn> EngineWnd=nullptr;
std::atomic<uint32_t> MouseDowns=0,MouseMoves=0;
std::mutex StateLock;
std::string Error;
SubmitFn Submit=nullptr;AssetFn Asset=nullptr;StatusFn Status=nullptr;

std::wstring Wide(const std::string& value) {
 int size=MultiByteToWideChar(CP_UTF8,0,value.data(),(int)value.size(),nullptr,0);
 std::wstring result(size,0);MultiByteToWideChar(CP_UTF8,0,value.data(),(int)value.size(),result.data(),size);return result;
}
std::string String(napi_env env,napi_value value) {
 size_t size=0;if(napi_get_value_string_utf8(env,value,nullptr,0,&size)!=napi_ok)throw std::runtime_error("Expected a string");
 std::string result(size+1,0);napi_get_value_string_utf8(env,value,result.data(),size+1,&size);result.resize(size);return result;
}
napi_value Text(napi_env env,const std::string& text){napi_value value;napi_create_string_utf8(env,text.data(),text.size(),&value);return value;}
LRESULT CALLBACK WindowProc(HWND window,UINT message,WPARAM wParam,LPARAM lParam) {
 if(message==WM_LBUTTONDOWN)++MouseDowns;
 if(message==WM_MOUSEMOVE)++MouseMoves;
 if(message==WM_LBUTTONDOWN||message==WM_RBUTTONDOWN)SetFocus(window);
 auto proc=EngineWnd.load();return proc?proc(window,message,wParam,lParam):DefWindowProcW(window,message,wParam,lParam);
}
template<class T>T Function(HMODULE module,const char* name){auto value=GetProcAddress(module,name);if(!value)throw std::runtime_error(std::string("Missing native Unreal export: ")+name);return reinterpret_cast<T>(value);}
void Engine(const std::wstring library,HWND parent,const std::wstring command) {
 bool initialized=false;TickFn shutdown=nullptr;
 try {
  auto module=LoadLibraryExW(library.c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if(!module)throw std::runtime_error("Cannot load Unreal library; Windows error "+std::to_string(GetLastError()));
  auto init=Function<InitFn>(module,"UELibrary_InitW");auto tick=Function<TickFn>(module,"UELibrary_Tick");shutdown=Function<TickFn>(module,"UELibrary_Shutdown");
  Submit=Function<SubmitFn>(module,"Archai_Submit");Asset=Function<AssetFn>(module,"Archai_Asset");Status=Function<StatusFn>(module,"Archai_Status");
  WNDCLASSW type={};type.hInstance=GetModuleHandleW(nullptr);type.lpfnWndProc=WindowProc;type.lpszClassName=L"ArchaiUnrealNativeViewport";RegisterClassW(&type);
  HWND window=CreateWindowExW(WS_EX_NOPARENTNOTIFY,type.lpszClassName,L"",WS_CHILD|WS_CLIPCHILDREN|WS_CLIPSIBLINGS,0,0,1,1,parent,nullptr,type.hInstance,nullptr);
  if(!window)throw std::runtime_error("Cannot create the native Unreal viewport");Window=window;
  EngineWnd=Function<WndFn>(module,"UELibrary_WndProc");
  if(init(type.hInstance,window,command.c_str())!=0)throw std::runtime_error("Unreal library initialization failed");
  initialized=true;Ready=true;
  while(Running) {
   MSG message;while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)){TranslateMessage(&message);DispatchMessageW(&message);}
   if(tick()!=0)throw std::runtime_error("Unreal library tick failed");
   std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
 }catch(const std::exception& error){std::lock_guard lock(StateLock);Error=error.what();}
 Ready=false;
 if(initialized&&shutdown)shutdown();
 EngineWnd=nullptr;if(Window)DestroyWindow(Window.exchange(nullptr));
 Stopped=true;
 // Unreal does not support restarting after Shutdown. Keep its DLL loaded until process exit.
}
napi_value Start(napi_env env,napi_callback_info info){
 try{size_t count=3;napi_value args[3];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);if(count!=3)throw std::runtime_error("Expected library, parent window and command line");
  auto library=Wide(String(env,args[0])),command=Wide(String(env,args[2]));auto parent=reinterpret_cast<HWND>(std::stoull(String(env,args[1])));
  if(!IsWindow(parent))throw std::runtime_error("Invalid Archai host window");
  if(Started.exchange(true))throw std::runtime_error("Unreal can be initialized only once per application process");
  Running=true;EngineThread=std::thread(Engine,library,parent,command);return Text(env,"starting");
 }catch(const std::exception& error){napi_throw_error(env,nullptr,error.what());return nullptr;}
}
napi_value State(napi_env env,napi_callback_info){std::lock_guard lock(StateLock);napi_value result,ready,error,stopped,downs,moves;napi_create_object(env,&result);napi_get_boolean(env,Ready,&ready);napi_set_named_property(env,result,"ready",ready);napi_get_boolean(env,Stopped,&stopped);napi_set_named_property(env,result,"stopped",stopped);error=Text(env,Error);napi_set_named_property(env,result,"error",error);napi_create_uint32(env,MouseDowns,&downs);napi_set_named_property(env,result,"mouseDowns",downs);napi_create_uint32(env,MouseMoves,&moves);napi_set_named_property(env,result,"mouseMoves",moves);return result;}
napi_value Send(napi_env env,napi_callback_info info){try{if(!Ready)throw std::runtime_error("Native Unreal is starting");size_t count=2;napi_value args[2];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);if(count!=2)throw std::runtime_error("Expected channel and scene data");auto channel=String(env,args[0]),json=String(env,args[1]);if(Submit(channel.c_str(),json.c_str()))throw std::runtime_error("Native scene submission failed");return Text(env,"ok");}catch(const std::exception& e){napi_throw_error(env,nullptr,e.what());return nullptr;}}
napi_value Upload(napi_env env,napi_callback_info info){try{if(!Ready)throw std::runtime_error("Native Unreal is starting");size_t count=2;napi_value args[2];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);if(count!=2)throw std::runtime_error("Expected asset name and buffer");auto name=String(env,args[0]);void* data=nullptr;size_t size=0;if(napi_get_buffer_info(env,args[1],&data,&size)!=napi_ok||size>512ull*1024*1024)throw std::runtime_error("Invalid native asset buffer");if(Asset(name.c_str(),data,(uint32_t)size))throw std::runtime_error("Native asset submission failed");return Text(env,"ok");}catch(const std::exception& e){napi_throw_error(env,nullptr,e.what());return nullptr;}}
napi_value Read(napi_env env,napi_callback_info){return Text(env,Ready&&Status?Status():"{}");}
void Cleanup(void*){Running=false;if(Window){ShowWindow(Window,SW_HIDE);SetParent(Window,nullptr);}if(EngineThread.joinable())EngineThread.join();}
napi_value Stop(napi_env env,napi_callback_info){Running=false;return Text(env,"stopping");}
napi_value Join(napi_env env,napi_callback_info){if(!Stopped){napi_throw_error(env,nullptr,"Wait for native shutdown before joining its thread");return nullptr;}if(EngineThread.joinable())EngineThread.join();return Text(env,"closed");}
napi_value Hide(napi_env env,napi_callback_info){if(Window)ShowWindow(Window,SW_HIDE);return Text(env,"hidden");}
}
NAPI_MODULE_INIT(){
 napi_property_descriptor properties[]={
  {"start",nullptr,Start,nullptr,nullptr,nullptr,napi_default,nullptr},{"state",nullptr,State,nullptr,nullptr,nullptr,napi_default,nullptr},
  {"submit",nullptr,Send,nullptr,nullptr,nullptr,napi_default,nullptr},{"asset",nullptr,Upload,nullptr,nullptr,nullptr,napi_default,nullptr},
  {"status",nullptr,Read,nullptr,nullptr,nullptr,napi_default,nullptr},{"stop",nullptr,Stop,nullptr,nullptr,nullptr,napi_default,nullptr},{"join",nullptr,Join,nullptr,nullptr,nullptr,napi_default,nullptr},{"hide",nullptr,Hide,nullptr,nullptr,nullptr,napi_default,nullptr}};
 napi_define_properties(env,exports,sizeof(properties)/sizeof(properties[0]),properties);napi_add_env_cleanup_hook(env,Cleanup,nullptr);return exports;
}
