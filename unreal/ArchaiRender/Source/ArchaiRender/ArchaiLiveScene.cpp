#include "ArchaiRenderGameMode.h"
#include "ArchaiEmbeddedBridge.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Components/StaticMeshComponent.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshOperations.h"
#include "MeshDescription.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "TextureResource.h"
#include "IImageWrapperModule.h"
#include "IImageWrapper.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "PhysicsEngine/BodySetup.h"

namespace {
bool AssetHash(const FString& Hash) {
    if (Hash.Len() != 64) return false;
    for (TCHAR C : Hash) if (!FChar::IsHexDigit(C)) return false;
    return true;
}
FString MaterialKey(const TSharedPtr<FJsonObject>& Data) {
    FString Key; FJsonSerializer::Serialize(Data.ToSharedRef(), TJsonWriterFactory<>::Create(&Key)); return Key;
}
FLinearColor LiveColor(const TSharedPtr<FJsonObject>& Data, const TCHAR* Name) {
    const auto& Values = Data->GetArrayField(Name);
    return FLinearColor(Values[0]->AsNumber(), Values[1]->AsNumber(), Values[2]->AsNumber(), 1);
}
}

UStaticMesh* AArchaiRenderGameMode::LiveMesh(const FString& Hash)
{
    if (auto Cached = LiveMeshes.FindRef(Hash)) return Cached;
    if (!AssetHash(Hash)) return nullptr;
    TArray<uint8> Bytes;
    const FString Name=TEXT("asset-")+Hash+TEXT(".mesh");
    if (!(ArchaiEmbedded::Enabled() ? ArchaiEmbedded::Asset(Name,Bytes) : FFileHelper::LoadFileToArray(Bytes, *(SessionDir/Name))) || Bytes.Num() < 16) return nullptr;
    const uint32* Header = reinterpret_cast<const uint32*>(Bytes.GetData());
    const uint32 Count = Header[1], IndexCount = Header[2];
    if (Header[0] != 0x314d4341 || !Count || !IndexCount || IndexCount % 3 || 16ull + Count * 48ull + IndexCount * 4ull != static_cast<uint64>(Bytes.Num())) return nullptr;
    const float* Values = reinterpret_cast<const float*>(Bytes.GetData() + 16);
    const uint32* Indices = reinterpret_cast<const uint32*>(Bytes.GetData() + 16 + Count * 48);
    FMeshDescription Description;
    FStaticMeshAttributes Attributes(Description); Attributes.Register();
    auto Positions = Attributes.GetVertexPositions();
    auto Normals = Attributes.GetVertexInstanceNormals();
    auto Tangents = Attributes.GetVertexInstanceTangents();
    auto Signs = Attributes.GetVertexInstanceBinormalSigns();
    auto UVs = Attributes.GetVertexInstanceUVs(); UVs.SetNumChannels(1);
    auto Colors = Attributes.GetVertexInstanceColors();
    const FPolygonGroupID Group = Description.CreatePolygonGroup();
    Attributes.GetPolygonGroupMaterialSlotNames()[Group] = TEXT("Live");
    TArray<FVertexID> Vertices; Vertices.Reserve(Count);
    for (uint32 I = 0; I < Count; ++I) {
        const float* V = Values + I * 12;
        const FVertexID Id = Description.CreateVertex(); Vertices.Add(Id);
        Positions[Id] = FVector3f(V[0], V[2], V[1]) * 0.1f;
    }
    for (uint32 I = 0; I < IndexCount; I += 3) {
        TArray<FVertexInstanceID, TInlineAllocator<3>> Corners;
        // Swapping Y/Z already changes handedness into Unreal's clockwise winding.
        // Reversing again makes outward surfaces back-facing and flips two-sided normals.
        for (uint32 Offset : {0u, 1u, 2u}) {
            const uint32 Index = Indices[I + Offset]; if (Index >= Count) return nullptr;
            const float* V = Values + Index * 12;
            const FVertexInstanceID Corner = Description.CreateVertexInstance(Vertices[Index]); Corners.Add(Corner);
            const FVector3f Normal = FVector3f(V[3], V[5], V[4]).GetSafeNormal();
            Normals[Corner] = Normal;
            // A stable tangent basis; UV-aware tangent generation is done below.
            const FVector3f Axis = FMath::Abs(Normal.Z) < 0.9f ? FVector3f(0, 0, 1) : FVector3f(0, 1, 0);
            Tangents[Corner] = FVector3f::CrossProduct(Axis, Normal).GetSafeNormal(); Signs[Corner] = 1;
            UVs.Set(Corner, 0, FVector2f(V[6], V[7])); Colors[Corner] = FVector4f(V[8], V[9], V[10], V[11]);
        }
        Description.CreatePolygon(Group, Corners);
    }
    FStaticMeshOperations::ComputeTriangleTangentsAndNormals(Description);
    FStaticMeshOperations::ComputeMikktTangents(Description, true);
    UStaticMesh* Mesh = NewObject<UStaticMesh>(this);
    Mesh->GetStaticMaterials().Add(FStaticMaterial(nullptr, TEXT("Live")));
    UStaticMesh::FBuildMeshDescriptionsParams Params;
    Params.bFastBuild = true; Params.bBuildSimpleCollision = true; Params.bAllowCpuAccess = true;
    TArray<const FMeshDescription*> Descriptions = { &Description };
    if (!Mesh->BuildFromMeshDescriptions(Descriptions, Params)) return nullptr;
    Mesh->CreateBodySetup();
    Mesh->GetBodySetup()->CollisionTraceFlag = CTF_UseComplexAsSimple;
    LiveMeshes.Add(Hash, Mesh); ++MeshesBuilt;
    return Mesh;
}

UTexture2D* AArchaiRenderGameMode::LiveTexture(const FString& Hash, bool SRGB)
{
    const FString Key = Hash + (SRGB ? TEXT(":color") : TEXT(":linear"));
    if (auto Cached = LiveTextures.FindRef(Key)) return Cached;
    if (!AssetHash(Hash)) return nullptr;
    TArray<uint8> Bytes;
    const FString Name=TEXT("asset-")+Hash+TEXT(".png");
    if (!(ArchaiEmbedded::Enabled() ? ArchaiEmbedded::Asset(Name,Bytes) : FFileHelper::LoadFileToArray(Bytes, *(SessionDir/Name)))) return nullptr;
    auto& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
    TSharedPtr<IImageWrapper> Image = Module.CreateImageWrapper(EImageFormat::PNG);
    if (!Image || !Image->SetCompressed(Bytes.GetData(), Bytes.Num()) || Image->GetWidth() > 4096 || Image->GetHeight() > 4096) return nullptr;
    TArray64<uint8> Raw;
    if (!Image->GetRaw(ERGBFormat::BGRA, 8, Raw)) return nullptr;
    UTexture2D* Texture = UTexture2D::CreateTransient(Image->GetWidth(), Image->GetHeight(), PF_B8G8R8A8);
    if (!Texture) return nullptr;
    Texture->SRGB = SRGB;
    auto& Mip = Texture->GetPlatformData()->Mips[0];
    void* Destination = Mip.BulkData.Lock(LOCK_READ_WRITE); FMemory::Memcpy(Destination, Raw.GetData(), Raw.Num()); Mip.BulkData.Unlock();
    Texture->UpdateResource(); LiveTextures.Add(Key, Texture); return Texture;
}

UMaterialInstanceDynamic* AArchaiRenderGameMode::LiveMaterial(const TSharedPtr<FJsonObject>& Data)
{
    const FString Key = MaterialKey(Data);
    if (auto Cached = LiveMaterials.FindRef(Key)) return Cached;
    const bool Transparent = Data->GetBoolField(TEXT("transparent"));
    UMaterialInterface* Master = LoadObject<UMaterialInterface>(nullptr, Transparent ? TEXT("/Game/Archai/M_LiveTransparent.M_LiveTransparent") : TEXT("/Game/Archai/M_LiveOpaque.M_LiveOpaque"));
    if (!Master) return nullptr;
    UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(Master, this);
    Material->SetVectorParameterValue(TEXT("BaseColor"), LiveColor(Data, TEXT("color")));
    Material->SetVectorParameterValue(TEXT("Emissive"), LiveColor(Data, TEXT("emissive")));
    Material->SetScalarParameterValue(TEXT("Roughness"), Data->GetNumberField(TEXT("roughness")));
    Material->SetScalarParameterValue(TEXT("Metalness"), Data->GetNumberField(TEXT("metalness")));
    Material->SetScalarParameterValue(TEXT("Opacity"), Data->GetNumberField(TEXT("opacity")));
    Material->SetScalarParameterValue(TEXT("AlphaTest"), Data->GetNumberField(TEXT("alphaTest")));
    Material->SetScalarParameterValue(TEXT("AOIntensity"), Data->GetNumberField(TEXT("aoIntensity")));
    const auto& NormalScale = Data->GetArrayField(TEXT("normalScale"));
    Material->SetVectorParameterValue(TEXT("NormalScale"), FLinearColor(NormalScale[0]->AsNumber(), NormalScale[1]->AsNumber(), 1, 0));
    Material->SetScalarParameterValue(TEXT("VertexColors"), Data->GetBoolField(TEXT("vertexColors")) ? 1 : 0);
    Material->SetScalarParameterValue(TEXT("Unlit"), Data->GetBoolField(TEXT("unlit")) ? 1 : 0);
    for (const TCHAR* Name : {TEXT("map"), TEXT("normalMap"), TEXT("roughnessMap"), TEXT("metalnessMap"), TEXT("emissiveMap"), TEXT("aoMap"), TEXT("alphaMap")}) {
        const TSharedPtr<FJsonObject>* Texture;
        if (!Data->TryGetObjectField(Name, Texture)) continue;
        const FString Hash = (*Texture)->GetStringField(TEXT("hash"));
        UTexture2D* Asset = LiveTexture(Hash, FString(Name) == TEXT("map") || FString(Name) == TEXT("emissiveMap"));
        if (!Asset) return nullptr;
        Material->SetTextureParameterValue(Name, Asset);
        Material->SetScalarParameterValue(*(FString(TEXT("Has_")) + Name), 1);
        const auto& UV = (*Texture)->GetArrayField(TEXT("matrix"));
        Material->SetVectorParameterValue(*(FString(Name) + TEXT("_U")), FLinearColor(UV[0]->AsNumber(), UV[3]->AsNumber(), UV[6]->AsNumber(), 0));
        Material->SetVectorParameterValue(*(FString(Name) + TEXT("_V")), FLinearColor(UV[1]->AsNumber(), UV[4]->AsNumber(), UV[7]->AsNumber(), 0));
    }
    LiveMaterials.Add(Key, Material); return Material;
}

void AArchaiRenderGameMode::BeginLiveScene(const TSharedPtr<FJsonObject>& Ticket)
{
    const int64 Base = static_cast<int64>(Ticket->GetNumberField(TEXT("baseRevision")));
    if (Base != Revision || Ticket->GetNumberField(TEXT("bridgeVersion")) != 1)
    { WriteStatus(TEXT("error"), TEXT("Live scene revision mismatch. Reconnect the view.")); return; }
    if (Ticket->GetBoolField(TEXT("reset"))) {
        for (auto Actor : SceneActors) if (IsValid(Actor)) Actor->Destroy();
        SceneActors.Reset(); LiveActors.Reset(); LiveMeshKeys.Reset(); LiveMaterialKeys.Reset();
    }
    bLiveBridge = true; bLoading = true; LiveIndex = 0; LoadProgress = 0;
    LiveUpserts = Ticket->GetArrayField(TEXT("upsert")); PendingActors.Reset();
    StatusText = TEXT("Updating Unreal scene…"); WriteStatus(TEXT("loading"));
}

void AArchaiRenderGameMode::AdvanceLiveScene()
{
    // Yield between elements so the viewport, progress and controls remain responsive.
    const double Start = FPlatformTime::Seconds();
    do {
        if (LiveIndex >= LiveUpserts.Num()) break;
        const auto Node = LiveUpserts[LiveIndex]->AsObject();
        const FString Id = Node->GetStringField(TEXT("id")), Element = Node->GetStringField(TEXT("elementId"));
        UStaticMesh* Mesh = LiveMesh(Node->GetStringField(TEXT("mesh")));
        UMaterialInstanceDynamic* Material = LiveMaterial(Node->GetObjectField(TEXT("material")));
        if (!Mesh || !Material) {
            for (auto Actor : PendingActors) if (IsValid(Actor)) Actor->Destroy();
            PendingActors.Reset(); bLoading = false;
            WriteStatus(TEXT("error"), TEXT("Could not build a live mesh or material. Reconnect the view.")); return;
        }
        AStaticMeshActor* Actor = GetWorld()->SpawnActor<AStaticMeshActor>(); Actor->SetActorHiddenInGame(true);
        auto Component = Actor->GetStaticMeshComponent(); Component->SetMobility(EComponentMobility::Movable);
        Component->SetStaticMesh(Mesh); Component->SetMaterial(0, Material);
        Component->SetCollisionEnabled(ECollisionEnabled::QueryOnly);
        Component->SetCollisionResponseToAllChannels(ECR_Block);
        const auto& M = Node->GetArrayField(TEXT("matrix"));
        // Three's metre-scaled world matrix and millimetre vertices -> Unreal centimetres.
        FMatrix Matrix(FPlane(M[0]->AsNumber()*1000, M[2]->AsNumber()*1000, M[1]->AsNumber()*1000, 0),
            FPlane(M[8]->AsNumber()*1000, M[10]->AsNumber()*1000, M[9]->AsNumber()*1000, 0),
            FPlane(M[4]->AsNumber()*1000, M[6]->AsNumber()*1000, M[5]->AsNumber()*1000, 0),
            FPlane(M[12]->AsNumber()*100, M[14]->AsNumber()*100, M[13]->AsNumber()*100, 1));
        Actor->SetActorTransform(FTransform(Matrix));
        const FName Tag(*(TEXT("ArchaiObject=") + Element)); Actor->Tags.Add(Tag); Component->ComponentTags.Add(Tag);
        PendingActors.Add(Actor); ++LiveIndex;
        LoadProgress = LiveUpserts.Num() ? static_cast<float>(LiveIndex) / LiveUpserts.Num() : 1;
    } while (FPlatformTime::Seconds() - Start < 0.008);
    if (LiveIndex < LiveUpserts.Num()) {
        StatusText = FString::Printf(TEXT("Loading elements · %d of %d"), LiveIndex, LiveUpserts.Num());
        WriteStatus(TEXT("loading")); return;
    }
    for (const auto& Value : PendingTicket->GetArrayField(TEXT("remove"))) {
        const FString Id = Value->AsString();
        if (auto Actor = LiveActors.FindRef(Id)) Actor->Destroy(); LiveActors.Remove(Id); LiveMeshKeys.Remove(Id); LiveMaterialKeys.Remove(Id);
    }
    for (int32 I = 0; I < LiveUpserts.Num(); ++I) {
        const auto Node = LiveUpserts[I]->AsObject(); const FString Id = Node->GetStringField(TEXT("id"));
        if (auto Previous = LiveActors.FindRef(Id)) Previous->Destroy();
        LiveActors.Add(Id, PendingActors[I]); PendingActors[I]->SetActorHiddenInGame(false);
        LiveMeshKeys.Add(Id, Node->GetStringField(TEXT("mesh"))); LiveMaterialKeys.Add(Id, MaterialKey(Node->GetObjectField(TEXT("material"))));
    }
    SceneActors.Reset(); for (const auto& Entry : LiveActors) SceneActors.Add(Entry.Value);
    // Release GPU assets that no remaining element uses.
    TSet<FString> UsedMeshes, UsedMaterials;
    for (const auto& Pair : LiveMeshKeys) UsedMeshes.Add(Pair.Value);
    for (const auto& Pair : LiveMaterialKeys) UsedMaterials.Add(Pair.Value);
    for (auto It = LiveMeshes.CreateIterator(); It; ++It) if (!UsedMeshes.Contains(It.Key())) It.RemoveCurrent();
    for (auto It = LiveMaterials.CreateIterator(); It; ++It) if (!UsedMaterials.Contains(It.Key())) It.RemoveCurrent();
    TSet<UTexture*> UsedTextures;
    for (const auto& Pair : LiveMaterials) for (const auto& Parameter : Pair.Value->TextureParameterValues) UsedTextures.Add(Parameter.ParameterValue);
    for (auto It = LiveTextures.CreateIterator(); It; ++It) if (!UsedTextures.Contains(It.Value())) It.RemoveCurrent();
    PendingActors.Reset(); LiveUpserts.Reset();
    Revision = PendingRevision; ModelHash = FString::Printf(TEXT("live:%lld"), Revision);
    bLoading = false; LoadProgress = 1; StatusText = TEXT("Unreal scene ready");
    bool ResetCamera=false;PendingTicket->TryGetBoolField(TEXT("resetCamera"),ResetCamera);
    ApplyLook(PendingTicket, bInitialCamera||ResetCamera); bInitialCamera = false;
    WriteStatus(TEXT("ready"));
}
