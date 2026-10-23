#include "ArchaiEmbeddedBridge.h"
#include "HAL/CriticalSection.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonSerializer.h"
#include <string>

namespace {
FCriticalSection BridgeLock;
TMap<FString,FString> Channels;
TMap<FString,TArray<uint8>> Assets;
FString StatusJson = TEXT("{}");
}
bool ArchaiEmbedded::Enabled() {
#if defined(UE_LIBRARY_ENABLED) && UE_LIBRARY_ENABLED
    return true;
#else
    return false;
#endif
}
TSharedPtr<FJsonObject> ArchaiEmbedded::Read(const TCHAR* Channel, bool Consume) {
    if (!Enabled()) return nullptr;
    FString Text;
    { FScopeLock Lock(&BridgeLock); if (const FString* Value=Channels.Find(Channel)) Text=*Value; if(Consume) Channels.Remove(Channel); }
    TSharedPtr<FJsonObject> Result;
    return !Text.IsEmpty() && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text),Result) ? Result : nullptr;
}
bool ArchaiEmbedded::Asset(const FString& Name, TArray<uint8>& Bytes) {
    if (!Enabled()) return false;
    FScopeLock Lock(&BridgeLock);
    if (const auto Value=Assets.Find(Name)) { Bytes=*Value; return true; }
    return false;
}
void ArchaiEmbedded::Status(const FString& Json) { if(Enabled()){FScopeLock Lock(&BridgeLock);StatusJson=Json;} }

#if defined(UE_LIBRARY_ENABLED) && UE_LIBRARY_ENABLED && PLATFORM_WINDOWS
extern "C" __declspec(dllexport) int Archai_Submit(const char* Channel, const char* Json) {
    if (!Channel||!Json) return 1;
    const FString Key=UTF8_TO_TCHAR(Channel),Text=UTF8_TO_TCHAR(Json);
    if(Key==TEXT("retain")) {
        TSharedPtr<FJsonObject> Data;if(!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text),Data))return 1;
        TSet<FString> Names;for(const auto& Value:Data->GetArrayField(TEXT("assets")))Names.Add(Value->AsString());
        FScopeLock Lock(&BridgeLock);for(auto It=Assets.CreateIterator();It;++It)if(!Names.Contains(It.Key()))It.RemoveCurrent();return 0;
    }
    FScopeLock Lock(&BridgeLock);
    if(Key==TEXT("configure")){Assets.Empty();Channels.Remove(TEXT("scene"));Channels.Remove(TEXT("command"));}
    Channels.Add(Key,Text); return 0;
}
extern "C" __declspec(dllexport) int Archai_Asset(const char* Name, const void* Data, uint32 Size) {
    if(!Name||!Data||!Size||Size>512u*1024u*1024u) return 1;
    const FString Key=UTF8_TO_TCHAR(Name);
    if(Key.Contains(TEXT("/"))||Key.Contains(TEXT("\\"))||!Key.StartsWith(TEXT("asset-"))) return 1;
    TArray<uint8> Bytes;Bytes.Append(static_cast<const uint8*>(Data),Size);
    FScopeLock Lock(&BridgeLock);Assets.Add(Key,MoveTemp(Bytes));return 0;
}
extern "C" __declspec(dllexport) const char* Archai_Status() {
    thread_local std::string Result;
    { FScopeLock Lock(&BridgeLock);Result=TCHAR_TO_UTF8(*StatusJson); }
    return Result.c_str();
}
#endif
