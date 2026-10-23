#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
namespace ArchaiEmbedded {
    bool Enabled();
    TSharedPtr<FJsonObject> Read(const TCHAR* Channel, bool Consume = false);
    bool Asset(const FString& Name, TArray<uint8>& Bytes);
    void Status(const FString& Json);
}
