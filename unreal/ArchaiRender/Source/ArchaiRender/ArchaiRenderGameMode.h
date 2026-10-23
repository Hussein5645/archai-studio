#pragma once
#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "Dom/JsonObject.h"
#include "ArchaiRenderGameMode.generated.h"

class UInterchangePipelineBase;
class ADirectionalLight;
class ASkyLight;
class APostProcessVolume;
class ALight;
class UStaticMesh;
class UTexture2D;
class UMaterialInstanceDynamic;

UCLASS()
class AArchaiRenderGameMode : public AGameModeBase
{
    GENERATED_BODY()
public:
    AArchaiRenderGameMode();
    virtual void BeginPlay() override;
    virtual void Tick(float DeltaSeconds) override;
    UFUNCTION(BlueprintCallable, Category="Archai")
    static int32 VerifyBakedLighting();
    UFUNCTION(BlueprintCallable, Category="Archai")
    static int32 PrepareLightmapUVs();
private:
    void PollCommand();
    void PollViewport();
    FVector OrbitTarget = FVector::ZeroVector;
    bool bOrbitTarget = false;
    bool bNavigationLocked = false, bPanTool = false;
    FVector2D PressMouse = FVector2D::ZeroVector;
    float DragDistance = 0;
    FString ClipKey;
    FString SelectedObject;
    int32 SelectionSequence = 0;
    UPROPERTY() TObjectPtr<AActor> SelectionOutline;
    bool bEmbedded = false;
    FString PlacementTool;
    int32 PlacementSequence = 0;
    TArray<TSharedPtr<FJsonValue>> PlacementEvents;
    uint64 ParentHandle = 0;
    int32 ViewportX = 0, ViewportY = 0, ViewportWidth = 0, ViewportHeight = 0;
    void FinishCommand();
    void RenderImage();
    void PollSession();
    void CompleteImport();
    void BeginLiveScene(const TSharedPtr<FJsonObject>& Ticket);
    void AdvanceLiveScene();
    UStaticMesh* LiveMesh(const FString& Hash);
    UTexture2D* LiveTexture(const FString& Hash, bool SRGB);
    UMaterialInstanceDynamic* LiveMaterial(const TSharedPtr<FJsonObject>& Data);
    UPROPERTY() TMap<FString, TObjectPtr<AActor>> LiveActors;
    UPROPERTY() TMap<FString, TObjectPtr<UStaticMesh>> LiveMeshes;
    UPROPERTY() TMap<FString, TObjectPtr<UTexture2D>> LiveTextures;
    UPROPERTY() TMap<FString, TObjectPtr<UMaterialInstanceDynamic>> LiveMaterials;
    TArray<TSharedPtr<FJsonValue>> LiveUpserts;
    TMap<FString, FString> LiveMeshKeys;
    TMap<FString, FString> LiveMaterialKeys;
    int32 LiveIndex = 0, MeshesBuilt = 0;
    bool bLiveBridge = false;
    float LoadProgress = 0;
    void ApplyLook(const TSharedPtr<FJsonObject>& Ticket, bool ResetCamera);
    void WriteStatus(const FString& State, const FString& Error = TEXT(""));
    void FrameScene();
    FString SessionDir, Token, ProjectId, ModelHash, PendingHash, StatusText;
    FString CapturePath;
    FString CommandId, CommandImage;
    float MoveSpeed = 500;
    int32 LookRevision = 0;
    int64 Revision = 0, PendingRevision = 0;
    float PollElapsed = 0;
    bool bLoading = false;
    bool bInitialCamera = true;
    bool bSmoke = false;
    int32 SceneImports = 0;
    bool bCaptureRequested = false;
    float ReadySeconds = 0;
    TSharedPtr<FJsonObject> PendingTicket;
    TMap<FString, FString> Bindings;
    UPROPERTY() TArray<TObjectPtr<AActor>> SceneActors;
    UPROPERTY() TArray<TObjectPtr<AActor>> PendingActors;
    UPROPERTY() TArray<TObjectPtr<UInterchangePipelineBase>> Pipelines;
    UPROPERTY() TObjectPtr<ADirectionalLight> Sun;
    UPROPERTY() TObjectPtr<ASkyLight> Sky;
    UPROPERTY() TObjectPtr<AActor> EnvironmentSky;
    UPROPERTY() TObjectPtr<APostProcessVolume> Post;
    UPROPERTY() TMap<FString, TObjectPtr<ALight>> ProjectLights;
};
