#include "ArchaiRenderGameMode.h"
#include "ArchaiEmbeddedBridge.h"
#include "InterchangeManager.h"
#include "InterchangeSourceData.h"
#include "InterchangeGenericAssetsPipeline.h"
#include "InterchangeGenericAssetsPipelineSharedSettings.h"
#include "InterchangeGenericScenesPipeline.h"
#include "Engine/DirectionalLight.h"
#include "Engine/SkyLight.h"
#include "Engine/PointLight.h"
#include "Engine/SpotLight.h"
#include "Engine/RectLight.h"
#include "Components/LocalLightComponent.h"
#include "Components/RectLightComponent.h"
#include "Components/SpotLightComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Engine/StaticMeshActor.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/TextureCube.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/World.h"
#include "Engine/GameViewportClient.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/SkyLightComponent.h"
#include "GameFramework/DefaultPawn.h"
#include "GameFramework/FloatingPawnMovement.h"
#include "Camera/CameraActor.h"
#include "Engine/MapBuildDataRegistry.h"
#include "StaticMeshComponentLODInfo.h"
#include "LightMap.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/SBoxPanel.h"
#include "Kismet/GameplayStatics.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformProcess.h"
#include "GameFramework/PlayerController.h"
#include "Camera/PlayerCameraManager.h"
#include "EngineUtils.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Layout/SBorder.h"
#include "Styling/CoreStyle.h"
#include "UnrealClient.h"
#include "HighResScreenshot.h"
#include "Widgets/SWindow.h"
#include "GenericPlatform/GenericWindow.h"
#include "Framework/Application/SlateApplication.h"
#include "Misc/App.h"
#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#if defined(UE_LIBRARY_ENABLED) && UE_LIBRARY_ENABLED
#include "Windows/WindowsApplication.h"
#endif
#include <bcrypt.h>
#endif

namespace
{
#if PLATFORM_WINDOWS
HWND ArchaiHostWindow = nullptr;
#endif
bool CursorPosition(APlayerController* PC,FVector2D& Position)
{
#if PLATFORM_WINDOWS
    if(ArchaiEmbedded::Enabled() && PC->GetWorld()->GetGameViewport()) {
        auto View=PC->GetWorld()->GetGameViewport();const auto Window=View->GetWindow();
        if(Window.IsValid() && Window->GetNativeWindow().IsValid() && View->Viewport) {
            const HWND Handle=static_cast<HWND>(Window->GetNativeWindow()->GetOSWindowHandle());
            POINT Point;RECT Client;
            if(GetCursorPos(&Point) && ScreenToClient(Handle,&Point) && GetClientRect(Handle,&Client) && Client.right>0 && Client.bottom>0) {
                const FIntPoint Size=View->Viewport->GetSizeXY();
                // Use the hosted surface's current pixels rather than Slate's
                // previous-frame pointer cache, including on scaled displays.
                Position=FVector2D(double(Point.x)*Size.X/Client.right,double(Point.y)*Size.Y/Client.bottom);return true;
            }
        }
    }
#endif
    float X,Y;if(!PC->GetMousePosition(X,Y))return false;Position=FVector2D(X,Y);return true;
}
TSharedPtr<FJsonObject> ReadJson(const FString& Path)
{
    if (IFileManager::Get().FileSize(*Path) > (Path.EndsWith(TEXT("session.json")) ? 128ll : 4ll) * 1024 * 1024) return nullptr;
    FString Text;
    TSharedPtr<FJsonObject> Result;
    if (!FFileHelper::LoadFileToString(Text, *Path)) return nullptr;
    return FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Result) ? Result : nullptr;
}
FVector SourcePosition(const TArray<TSharedPtr<FJsonValue>>& Values)
{
    return FVector(Values[0]->AsNumber(), Values[2]->AsNumber(), Values[1]->AsNumber()) / 10.0;
}
bool CheckHash(const TArray<uint8>& Bytes, const FString& Expected)
{
#if PLATFORM_WINDOWS
    uint8 Digest[32];
    const NTSTATUS Result = BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0,
        const_cast<PUCHAR>(Bytes.GetData()), Bytes.Num(), Digest, sizeof(Digest));
    return Result >= 0 && BytesToHex(Digest, UE_ARRAY_COUNT(Digest)).Equals(Expected, ESearchCase::IgnoreCase);
#else
    return false;
#endif
}
}

AArchaiRenderGameMode::AArchaiRenderGameMode()
{
    PrimaryActorTick.bCanEverTick = true;
    DefaultPawnClass = ADefaultPawn::StaticClass();
}

void AArchaiRenderGameMode::BeginPlay()
{
    Super::BeginPlay();
    FParse::Value(FCommandLine::Get(), TEXT("ArchaiSession="), SessionDir);
    FParse::Value(FCommandLine::Get(), TEXT("ArchaiToken="), Token);
    FParse::Value(FCommandLine::Get(), TEXT("ArchaiParent="), ParentHandle);
    bSmoke = FParse::Param(FCommandLine::Get(), TEXT("ArchaiSmoke"));
    FParse::Value(FCommandLine::Get(), TEXT("ArchaiCapture="), CapturePath);
    SessionDir = FPaths::ConvertRelativePathToFull(SessionDir);
    if (Token.IsEmpty())
    {
        for (TActorIterator<AActor> It(GetWorld()); It; ++It)
            for (const FName& Tag : It->Tags) if (Tag.ToString().StartsWith(TEXT("ArchaiObject="))) { SceneActors.Add(*It); break; }
        FString ElementFilter;
        if (FParse::Value(FCommandLine::Get(), TEXT("ArchaiElementFilter="), ElementFilter)) {
            const auto Filter = ReadJson(ElementFilter); TSet<FString> Retained;
            if (Filter) for (const auto& Value : Filter->GetArrayField(TEXT("elements"))) Retained.Add(Value->AsString());
            for (int32 I = SceneActors.Num()-1; I >= 0; --I) {
                bool Keep = false;
                for (const FName& Tag : SceneActors[I]->Tags) if (Retained.Contains(Tag.ToString().RightChop(13))) Keep = true;
                if (!Keep) { SceneActors[I]->Destroy(); SceneActors.RemoveAt(I); }
            }
        }
        StatusText = TEXT("Baked Unreal scene · Drag to orbit · Right-drag pan · Wheel zoom · F frame");
    }
    else
    {
    StatusText = TEXT("Loading Archai scene…");
    Sun = GetWorld()->SpawnActor<ADirectionalLight>();
    Sun->GetLightComponent()->SetMobility(EComponentMobility::Movable);
    CastChecked<UDirectionalLightComponent>(Sun->GetLightComponent())->SetAtmosphereSunLight(true);
    Sky = GetWorld()->SpawnActor<ASkyLight>();
    Sky->GetLightComponent()->SetMobility(EComponentMobility::Movable);
    Sky->GetLightComponent()->SetRealTimeCaptureEnabled(false);
    Sky->GetLightComponent()->SourceType = SLS_SpecifiedCubemap;
    Sky->GetLightComponent()->bLowerHemisphereIsBlack = false;
    Sky->GetLightComponent()->SetCubemap(LoadObject<UTextureCube>(nullptr, TEXT("/Game/Archai/DaylightAmbientCubemap.DaylightAmbientCubemap")));
    AStaticMeshActor* SkyDome = GetWorld()->SpawnActor<AStaticMeshActor>();
    EnvironmentSky = SkyDome;
    SkyDome->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
    SkyDome->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere")));
    SkyDome->GetStaticMeshComponent()->SetMaterial(0, UMaterialInstanceDynamic::Create(LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/Archai/M_EnvironmentSky.M_EnvironmentSky")), this));
    SkyDome->GetStaticMeshComponent()->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    SkyDome->GetStaticMeshComponent()->SetCastShadow(false);
    SkyDome->GetStaticMeshComponent()->SetVisibleInRayTracing(false);
    SkyDome->SetActorScale3D(FVector(10000));
    GetWorld()->SpawnActor<ASkyAtmosphere>();
    Post = GetWorld()->SpawnActor<APostProcessVolume>();
    Post->bUnbound = true;
    Post->Settings.bOverride_AutoExposureMethod = true;
    Post->Settings.AutoExposureMethod = EAutoExposureMethod::AEM_Manual;
    }
    if (APlayerController* PC = GetWorld()->GetFirstPlayerController())
    {
        PC->SetInputMode(FInputModeGameAndUI().SetHideCursorDuringCapture(false));
        PC->bShowMouseCursor = true;
    }
    if (GetWorld()->GetGameViewport() && ParentHandle == 0)
    {
        GetWorld()->GetGameViewport()->AddViewportWidgetContent(
            SNew(SBorder).HAlign(HAlign_Left).VAlign(VAlign_Top).Padding(16)
            .BorderImage(FCoreStyle::Get().GetBrush("NoBorder"))
            [SNew(SVerticalBox)
             +SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).ColorAndOpacity(FLinearColor::White)
             .ShadowColorAndOpacity(FLinearColor::Black).ShadowOffset(FVector2D(1,1))
             .Text_Lambda([Weak = TWeakObjectPtr<AArchaiRenderGameMode>(this)]()
             { return FText::FromString(Weak.IsValid() ? Weak->StatusText : FString()); })]
             +SVerticalBox::Slot().AutoHeight().Padding(0,12,0,0)[SNew(SHorizontalBox)
              +SHorizontalBox::Slot().AutoWidth()[SNew(SButton).Text(FText::FromString(TEXT("Frame scene (F)")))
               .OnClicked_Lambda([this](){ FrameScene(); return FReply::Handled(); })]
              +SHorizontalBox::Slot().AutoWidth().Padding(8,0)[SNew(SButton).Text(FText::FromString(TEXT("Render PNG")))
               .OnClicked_Lambda([this](){ RenderImage(); return FReply::Handled(); })]
              +SHorizontalBox::Slot().AutoWidth().Padding(8,0)[SNew(SButton).Text(FText::FromString(TEXT("Exposure -")))
               .OnClicked_Lambda([this](){ if (Post) { Post->Settings.AutoExposureBias = FMath::Clamp(Post->Settings.AutoExposureBias - 0.25f, -4.f, 4.f); ++LookRevision; WriteStatus(TEXT("ready")); } return FReply::Handled(); })]
              +SHorizontalBox::Slot().AutoWidth().Padding(8,0)[SNew(SButton).Text(FText::FromString(TEXT("Exposure +")))
               .OnClicked_Lambda([this](){ if (Post) { Post->Settings.AutoExposureBias = FMath::Clamp(Post->Settings.AutoExposureBias + 0.25f, -4.f, 4.f); ++LookRevision; WriteStatus(TEXT("ready")); } return FReply::Handled(); })]
              +SHorizontalBox::Slot().AutoWidth()[SNew(SButton).Text(FText::FromString(TEXT("Close viewer")))
               .OnClicked_Lambda([](){ FPlatformMisc::RequestExit(false); return FReply::Handled(); })]
             ]]);
    }
    PollSession();
}

void AArchaiRenderGameMode::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);
#if PLATFORM_WINDOWS && defined(UE_LIBRARY_ENABLED) && UE_LIBRARY_ENABLED
    // The library host supplies the Windows message pump. UE 5.8 also queues
    // input on workers; its usual post-pump drain is skipped in library mode.
    FWindowsApplication::StaticPostPumpMessages();
#endif
    if (const auto Config = ArchaiEmbedded::Read(TEXT("configure"),true)) {
        SessionDir = Config->GetStringField(TEXT("directory")); Token = Config->GetStringField(TEXT("token")); ProjectId=Config->GetStringField(TEXT("projectId"));
        for (auto Actor : SceneActors) if(IsValid(Actor))Actor->Destroy();
        for (auto Actor : PendingActors) if(IsValid(Actor))Actor->Destroy();
        for (auto& Pair : ProjectLights) if(IsValid(Pair.Value))Pair.Value->Destroy();
        ProjectLights.Reset();
        if(IsValid(SelectionOutline))SelectionOutline->Destroy();
        SelectionOutline=nullptr;SelectedObject.Empty();
        SceneActors.Reset(); LiveActors.Reset(); LiveMeshKeys.Reset(); LiveMaterialKeys.Reset();
        LiveUpserts.Reset(); PendingActors.Reset(); LiveMeshes.Reset(); LiveMaterials.Reset(); LiveTextures.Reset(); ModelHash.Empty(); Revision=0; PendingRevision=0; bLoading=false; bInitialCamera=true;
        PlacementEvents.Reset(); PlacementSequence=0; SelectionSequence=0;
        PendingTicket.Reset();PendingHash.Empty();CommandId.Empty();CommandImage.Empty();
        LiveIndex=0;MeshesBuilt=0;SceneImports=0;LookRevision=0;LoadProgress=0;bLiveBridge=false;
    }
    if (bLiveBridge && bLoading) AdvanceLiveScene();
    // GameMode BeginPlay can precede player possession in a cooked baked map.
    // Position the player only once its pawn exists, before requesting a capture.
    if (Token.IsEmpty() && bInitialCamera && SceneActors.Num() > 0)
    {
        APlayerController* PC = GetWorld()->GetFirstPlayerController();
        if (PC && PC->GetPawn())
        {
            FrameScene();
            for (TActorIterator<ACameraActor> It(GetWorld()); It; ++It)
            { PC->GetPawn()->SetActorLocation(It->GetActorLocation()); PC->SetControlRotation(It->GetActorRotation()); break; }
            PC->SetInputMode(FInputModeGameAndUI().SetHideCursorDuringCapture(false));
            for (TActorIterator<APostProcessVolume> It(GetWorld()); It; ++It) { Post = *It; break; }
            FString LookFile;
            if (FParse::Value(FCommandLine::Get(), TEXT("ArchaiBakedLook="), LookFile)) {
                const auto Look = ReadJson(LookFile);
                if (Look && Post) {
                    double Exposure = 0, Bloom = 0.1;
                    Look->TryGetNumberField(TEXT("exposure"), Exposure); Look->TryGetNumberField(TEXT("bloom"), Bloom);
                    Post->Settings.bOverride_AutoExposureBias = true; Post->Settings.AutoExposureBias = FMath::Clamp(Exposure,-4.0,4.0);
                    Post->Settings.bOverride_BloomIntensity = true; Post->Settings.BloomIntensity = FMath::Clamp(Bloom,0.0,2.0);
                    const TSharedPtr<FJsonObject>* Camera; const TArray<TSharedPtr<FJsonValue>> *Eye, *Aim;
                    if (Look->TryGetObjectField(TEXT("camera"),Camera) && (*Camera)->TryGetArrayField(TEXT("position"),Eye) && (*Camera)->TryGetArrayField(TEXT("target"),Aim) && Eye->Num()==3 && Aim->Num()==3) {
                        OrbitTarget=SourcePosition(*Aim); bOrbitTarget=true;
                        PC->GetPawn()->SetActorLocation(SourcePosition(*Eye)); PC->SetControlRotation((OrbitTarget-SourcePosition(*Eye)).Rotation());
                    }
                }
            }
            bInitialCamera = false;
            UE_LOG(LogTemp, Display, TEXT("Archai baked camera ready: %s, %d scene actors"), *PC->GetPawn()->GetActorLocation().ToString(), SceneActors.Num());
        }
    }
    PollElapsed += DeltaSeconds;
    if (PollElapsed >= 0.2f) { PollElapsed = 0; PollViewport(); PollSession(); PollCommand(); if (!bLoading && !ModelHash.IsEmpty() && Revision == PendingRevision) WriteStatus(TEXT("ready")); }
    if (!CommandImage.IsEmpty() && IFileManager::Get().FileSize(*CommandImage) > 0) FinishCommand();
    if (!bLoading && (!ModelHash.IsEmpty() || (Token.IsEmpty() && SceneActors.Num() > 0)) && !CapturePath.IsEmpty() && !bCaptureRequested)
    {
        ReadySeconds += DeltaSeconds;
        if (ReadySeconds >= 2.0f)
        {
            bCaptureRequested = true;
            FScreenshotRequest::RequestScreenshot(CapturePath, false, false);
        }
    }
    if (APlayerController* PC = GetWorld()->GetFirstPlayerController())
    {
        const bool DesktopOrbit = !FParse::Param(FCommandLine::Get(), TEXT("vr"));
        if(DesktopOrbit && GetWorld()->GetGameViewport() && GetWorld()->GetGameViewport()->GetMouseCaptureMode()!=EMouseCaptureMode::CaptureDuringMouseDown) {
            // Player possession may occur after BeginPlay. Configure visible,
            // non-locking desktop input once the actual controller is present.
            PC->SetInputMode(FInputModeGameAndUI().SetHideCursorDuringCapture(false).SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock));
            GetWorld()->GetGameViewport()->SetMouseCaptureMode(EMouseCaptureMode::CaptureDuringMouseDown);
        }
        const bool Looking = !DesktopOrbit;
        PC->ResetIgnoreLookInput();
        PC->SetIgnoreLookInput(!Looking);
        PC->ResetIgnoreMoveInput();
        PC->SetIgnoreMoveInput(!Looking);
        PC->bShowMouseCursor = !Looking;
        if (DesktopOrbit && PC->GetPawn() && !bLoading)
        {
            APawn* Pawn = PC->GetPawn();
            if (!bOrbitTarget) { OrbitTarget = Pawn->GetActorLocation() + PC->GetControlRotation().Vector() * 1000; bOrbitTarget = true; }
            float MX = 0, MY = 0;
            PC->GetInputMouseDelta(MX, MY);
            if (PC->WasInputKeyJustPressed(EKeys::LeftMouseButton)) DragDistance = 0;
            DragDistance += FMath::Abs(MX) + FMath::Abs(MY);
            FVector Offset = Pawn->GetActorLocation() - OrbitTarget;
            const float Distance = FMath::Max(10.0, Offset.Size());
            const bool Left = PC->IsInputKeyDown(EKeys::LeftMouseButton) && PlacementTool.IsEmpty();
        const bool Pan = PC->IsInputKeyDown(EKeys::RightMouseButton) || (Left && (bPanTool || PC->IsInputKeyDown(EKeys::LeftShift) || PC->IsInputKeyDown(EKeys::LeftControl)));
            if (Pan && !bNavigationLocked)
            {
                const FRotationMatrix Axes(PC->GetControlRotation());
                const FVector Delta = (Axes.GetUnitAxis(EAxis::Y) * -MX + Axes.GetUnitAxis(EAxis::Z) * -MY) * Distance * 0.002;
                Pawn->SetActorLocation(Pawn->GetActorLocation() + Delta); OrbitTarget += Delta;
            }
            else if (Left && !bNavigationLocked && (!FMath::IsNearlyZero(MX) || !FMath::IsNearlyZero(MY)))
            {
                FRotator Rotation = Offset.Rotation();
                Rotation.Yaw -= MX * 0.35;
                Rotation.Pitch = FMath::Clamp(Rotation.Pitch + MY * 0.35, -89.0, 89.0);
                Pawn->SetActorLocation(OrbitTarget + Rotation.Vector() * Distance);
                PC->SetControlRotation((OrbitTarget - Pawn->GetActorLocation()).Rotation());
            }
            const float Wheel = PC->WasInputKeyJustPressed(EKeys::MouseScrollUp) ? -0.12f : PC->WasInputKeyJustPressed(EKeys::MouseScrollDown) ? 0.12f : 0;
            const float Dolly = PC->IsInputKeyDown(EKeys::MiddleMouseButton) ? -MY * 0.015f : 0;
            if (!bNavigationLocked && (Wheel != 0 || Dolly != 0)) Pawn->SetActorLocation(OrbitTarget + Offset.GetSafeNormal() * FMath::Clamp(Distance * FMath::Exp(Wheel + Dolly), 10.f, 10000000.f));
            if (PlacementTool.IsEmpty() && PC->WasInputKeyJustReleased(EKeys::LeftMouseButton) && DragDistance < 4)
            {
                FHitResult Hit;
                SelectedObject.Empty();
                if (SelectionOutline) { SelectionOutline->Destroy(); SelectionOutline = nullptr; }
                AActor* Picked = nullptr;
                FVector2D Cursor;const bool bCursor=CursorPosition(PC,Cursor);
                if (bCursor && PC->GetHitResultAtScreenPosition(Cursor,ECC_Visibility,true,Hit)) Picked = Hit.GetActor();
                if (!Picked)
                {
                    FVector Origin, Direction;
                    if (bCursor && PC->DeprojectScreenPositionToWorld(Cursor.X,Cursor.Y,Origin, Direction))
                    {
                        double Nearest = TNumericLimits<double>::Max();
                        for (AActor* Actor : SceneActors)
                        {
                            const FBox Bounds = Actor->GetComponentsBoundingBox(true);
                            FVector Location, Normal; float Time;
                            if (Bounds.IsValid && FMath::LineExtentBoxIntersection(Bounds, Origin, Origin + Direction * 10000000, FVector::ZeroVector, Location, Normal, Time) && Time < Nearest)
                            { Nearest = Time; Picked = Actor; }
                        }
                    }
                }
                if (Picked)
                {
                    for (const FName& Tag : Picked->Tags) if (Tag.ToString().StartsWith(TEXT("ArchaiObject="))) { SelectedObject = Tag.ToString().Mid(13); break; }
                    if (!ParentHandle && !SelectedObject.IsEmpty()) StatusText = TEXT("Element selected · Drag to orbit · Right-drag pan · Wheel zoom");
                    if (!SelectedObject.IsEmpty())
                    {
                        FBox Bounds(ForceInit);
                        for (AActor* Actor : SceneActors) if (Actor->Tags.Contains(FName(*(TEXT("ArchaiObject=") + SelectedObject)))) Bounds += Actor->GetComponentsBoundingBox(true);
                        if (Bounds.IsValid)
                        {
                            SelectionOutline = GetWorld()->SpawnActor<AActor>();
                            UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
                            const float Thickness = FMath::Max(0.5f, static_cast<float>(Bounds.GetExtent().Size()) * 0.002f);
                            for (int32 Axis = 0; Axis < 3; ++Axis) for (int32 A = 0; A < 2; ++A) for (int32 B = 0; B < 2; ++B)
                            {
                                FVector P = Bounds.GetCenter(), Size(Thickness);
                                Size[Axis] = Bounds.GetSize()[Axis] + Thickness;
                                P[(Axis + 1) % 3] = A ? Bounds.Max[(Axis + 1) % 3] : Bounds.Min[(Axis + 1) % 3];
                                P[(Axis + 2) % 3] = B ? Bounds.Max[(Axis + 2) % 3] : Bounds.Min[(Axis + 2) % 3];
                                UStaticMeshComponent* Edge = NewObject<UStaticMeshComponent>(SelectionOutline);
                                Edge->SetStaticMesh(Cube); Edge->SetCollisionEnabled(ECollisionEnabled::NoCollision); Edge->SetCastShadow(false);
                                SelectionOutline->AddInstanceComponent(Edge); Edge->RegisterComponent(); Edge->SetWorldLocation(P); Edge->SetWorldScale3D(Size / 100);
                            }
                        }
                    }
                }
                ++SelectionSequence;
                WriteStatus(TEXT("ready"));
            }
        }
        if (PC->WasInputKeyJustPressed(EKeys::Escape)) { PC->SetInputMode(FInputModeGameAndUI()); PC->bShowMouseCursor = true; }
        if (!PlacementTool.IsEmpty() && !bLoading && (PC->WasInputKeyJustPressed(EKeys::LeftMouseButton) || PC->WasInputKeyJustPressed(EKeys::Enter) || PC->WasInputKeyJustPressed(EKeys::Escape)))
        {
            TSharedRef<FJsonObject> Event = MakeShared<FJsonObject>();
            Event->SetNumberField(TEXT("sequence"), ++PlacementSequence);
            Event->SetStringField(TEXT("tool"), PlacementTool);
            const FString Action = PC->WasInputKeyJustPressed(EKeys::Enter) ? TEXT("finish") : PC->WasInputKeyJustPressed(EKeys::Escape) ? TEXT("cancel") : TEXT("place");
            Event->SetStringField(TEXT("action"), Action);
            FVector Origin = FVector::ZeroVector, Direction = FVector::ZeroVector, Point = FVector::ZeroVector;
            FHitResult Hit;
            bool bPoint = false;
            FVector2D Cursor;
            if (Action == TEXT("place") && CursorPosition(PC,Cursor) && PC->DeprojectScreenPositionToWorld(Cursor.X,Cursor.Y,Origin, Direction))
            {
                if (PC->GetHitResultAtScreenPosition(Cursor,ECC_Visibility,true,Hit) && FMath::Abs(Hit.ImpactNormal.Z) > 0.6) { Point = Hit.ImpactPoint; bPoint = true; }
                else if (Direction.Z < -0.00001) { const float Distance = -Origin.Z / Direction.Z; if (Distance > 0) { Point = Origin + Direction * Distance; bPoint = true; } }
            }
            if (bPoint)
            {
                TSharedRef<FJsonObject> Position = MakeShared<FJsonObject>();
                Position->SetNumberField(TEXT("x"), Point.X * 10); Position->SetNumberField(TEXT("y"), Point.Y * 10);
                Position->SetNumberField(TEXT("elevation"), Point.Z * 10); Position->SetNumberField(TEXT("heading"), PC->GetControlRotation().Yaw);
                Event->SetObjectField(TEXT("point"), Position);
            }
            else Event->SetField(TEXT("point"), MakeShared<FJsonValueNull>());
            PlacementEvents.Add(MakeShared<FJsonValueObject>(Event));
            if (PlacementEvents.Num() > 64) PlacementEvents.RemoveAt(0);
            WriteStatus(TEXT("ready"));
        }
        if (PC->WasInputKeyJustPressed(EKeys::F)) FrameScene();
        if (!ParentHandle && PC->WasInputKeyJustPressed(EKeys::F11)) PC->ConsoleCommand(TEXT("fullscreen"));
        if (PC->GetPawn()) if (UFloatingPawnMovement* Movement = Cast<UFloatingPawnMovement>(PC->GetPawn()->GetMovementComponent()))
            Movement->MaxSpeed = MoveSpeed * (PC->IsInputKeyDown(EKeys::LeftShift) ? 4.f : 1.f);
    }
}

void AArchaiRenderGameMode::RenderImage()
{
    if (bLoading) return;
    const FString Directory = FString(FPlatformProcess::UserDir()) / TEXT("Archai/Renders");
    IFileManager::Get().MakeDirectory(*Directory, true);
    const FString Path = Directory / FString::Printf(TEXT("Unreal-%s.png"), *FDateTime::Now().ToString(TEXT("%Y%m%d-%H%M%S")));
    FScreenshotRequest::RequestScreenshot(Path, false, false);
    StatusText = TEXT("Image saved to ") + Path;
}

void AArchaiRenderGameMode::PollCommand()
{
    if (Token.IsEmpty() || bLoading || !CommandImage.IsEmpty()) return;
    const TSharedPtr<FJsonObject> Command = ArchaiEmbedded::Enabled() ? ArchaiEmbedded::Read(TEXT("command"),true) : ReadJson(SessionDir / TEXT("command.json"));
    FString IncomingToken, Id, Action;
    FGuid Guid;
    if (!Command || !Command->TryGetStringField(TEXT("token"), IncomingToken) || IncomingToken != Token ||
        !Command->TryGetStringField(TEXT("id"), Id) || Id == CommandId || !FGuid::Parse(Id, Guid) ||
        !Command->TryGetStringField(TEXT("action"), Action)) return;
    if (Action != TEXT("frame") && Action != TEXT("image")) return;
    CommandId = Id;
    if (Action == TEXT("frame")) { FrameScene(); FinishCommand(); }
    else
    {
        CommandImage = SessionDir / (TEXT("image-") + Id + TEXT(".png"));
        if (SelectionOutline) SelectionOutline->SetActorHiddenInGame(true);
        const TSharedPtr<FJsonObject>* Options;
        if (Command->TryGetObjectField(TEXT("options"), Options) && GetWorld()->GetGameViewport()->Viewport)
        {
            FString Quality;
            (*Options)->TryGetStringField(TEXT("quality"), Quality);
            if (IConsoleVariable* AA = IConsoleManager::Get().FindConsoleVariable(TEXT("r.PostProcessAAQuality"))) AA->Set(Quality == TEXT("high") ? 6 : 2);
            const uint32 Width = FMath::Clamp(static_cast<int32>((*Options)->GetNumberField(TEXT("width"))), 320, 7680);
            const uint32 Height = FMath::Clamp(static_cast<int32>((*Options)->GetNumberField(TEXT("height"))), 240, 7680);
            FHighResScreenshotConfig& Config = GetHighResScreenshotConfig();
            Config.SetResolution(Width, Height, 1.f); Config.FilenameOverride = CommandImage; Config.bMaskEnabled = false;
            GetWorld()->GetGameViewport()->Viewport->TakeHighResScreenShot();
        }
        else FScreenshotRequest::RequestScreenshot(CommandImage, false, false);
    }
}

void AArchaiRenderGameMode::FinishCommand()
{
    TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("token"), Token);
    Result->SetStringField(TEXT("id"), CommandId);
    FString Text;
    FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Text));
    const FString Temporary = SessionDir / TEXT("command-result.tmp");
    FFileHelper::SaveStringToFile(Text, *Temporary, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    IFileManager::Get().Move(*(SessionDir / TEXT("command-result.json")), *Temporary, true);
    CommandImage.Empty();
    if (IConsoleVariable* AA = IConsoleManager::Get().FindConsoleVariable(TEXT("r.PostProcessAAQuality"))) AA->Set(6);
    if (SelectionOutline) SelectionOutline->SetActorHiddenInGame(false);
}

int32 AArchaiRenderGameMode::PrepareLightmapUVs()
{
#if WITH_EDITOR
    int32 Count = 0;
    for (const FWorldContext& Context : GEngine->GetWorldContexts())
    {
        UWorld* World = Context.World();
        if (!World || World->WorldType != EWorldType::Editor) continue;
        for (TActorIterator<AStaticMeshActor> It(World); It; ++It)
        {
            UStaticMesh* Mesh = It->GetStaticMeshComponent()->GetStaticMesh();
            if (!Mesh || Mesh->GetNumSourceModels() < 1) return -1;
            FMeshBuildSettings& Settings = Mesh->GetSourceModel(0).BuildSettings;
            Settings.bGenerateLightmapUVs = true;
            Settings.SrcLightmapIndex = 0;
            Settings.DstLightmapIndex = 1;
            Mesh->SetLightMapCoordinateIndex(1);
            Mesh->SetLightMapResolution(128);
            Mesh->Build(false);
            Mesh->MarkPackageDirty();
            ++Count;
        }
    }
    return Count;
#else
    return -1;
#endif
}

int32 AArchaiRenderGameMode::VerifyBakedLighting()
{
#if WITH_EDITOR
    int32 Count = 0;
    for (const FWorldContext& Context : GEngine->GetWorldContexts())
    {
        UWorld* World = Context.World();
        if (!World || World->WorldType != EWorldType::Editor) continue;
        for (TActorIterator<AStaticMeshActor> It(World); It; ++It)
        {
            UStaticMeshComponent* Component = It->GetStaticMeshComponent();
            if (Component->Mobility != EComponentMobility::Static) continue;
            if (!Component->GetStaticMesh()) continue;
            if (!Component->LODData.Num()) return -1;
            const FMeshMapBuildData* Data = Component->GetMeshMapBuildData(Component->LODData[0], false);
            if (!Data || !Data->LightMap) return -1;
            ++Count;
        }
    }
    return Count;
#else
    return -1;
#endif
}

void AArchaiRenderGameMode::PollSession()
{
    if (bLoading || Token.IsEmpty()) return;
    const TSharedPtr<FJsonObject> Ticket = ArchaiEmbedded::Enabled() ? ArchaiEmbedded::Read(TEXT("scene"),true) : ReadJson(SessionDir / TEXT("session.json"));
    FString TicketToken, NextProject, NextHash, ModelFile;
    double NextRevision = 0;
    if (!Ticket || !Ticket->TryGetStringField(TEXT("token"), TicketToken) || TicketToken != Token ||
        !Ticket->TryGetStringField(TEXT("projectId"), NextProject) ||
        !Ticket->TryGetNumberField(TEXT("revision"), NextRevision) || NextRevision <= PendingRevision) return;
    if (!ProjectId.IsEmpty() && ProjectId != NextProject) { WriteStatus(TEXT("error"), TEXT("Project mismatch")); return; }
    ProjectId = NextProject;
    PendingRevision = static_cast<int64>(NextRevision);
    PendingTicket = Ticket;
    if (Ticket->HasField(TEXT("bridgeVersion"))) { BeginLiveScene(Ticket); return; }
    bLiveBridge = false;
    if (!Ticket->TryGetStringField(TEXT("modelHash"), NextHash) || !Ticket->TryGetStringField(TEXT("modelFile"), ModelFile))
    { WriteStatus(TEXT("error"), TEXT("Invalid scene ticket")); return; }
    PendingHash = NextHash;
    if (ModelHash == PendingHash && !ModelHash.IsEmpty())
    {
        ApplyLook(Ticket, false);
        Revision = PendingRevision;
        WriteStatus(TEXT("ready"));
        return;
    }
    if (ModelFile != FPaths::GetCleanFilename(ModelFile) || !ModelFile.EndsWith(TEXT(".glb")))
    { WriteStatus(TEXT("error"), TEXT("Invalid scene file name")); return; }
    const FString ModelPath = SessionDir / ModelFile;
    TArray<uint8> Bytes;
    if (IFileManager::Get().FileSize(*ModelPath) > 512ll * 1024 * 1024 || !FFileHelper::LoadFileToArray(Bytes, *ModelPath) || Bytes.Num() < 20)
    { WriteStatus(TEXT("error"), TEXT("Scene file unavailable or too large")); return; }
    uint32 Magic, Length;
    FMemory::Memcpy(&Magic, Bytes.GetData(), 4);
    FMemory::Memcpy(&Length, Bytes.GetData() + 12, 4);
    if (Magic != 0x46546c67 || Length > static_cast<uint32>(Bytes.Num() - 20))
    { WriteStatus(TEXT("error"), TEXT("Invalid scene format")); return; }
    if (!CheckHash(Bytes, NextHash))
    { WriteStatus(TEXT("error"), TEXT("Scene integrity check failed")); return; }
    const FUTF8ToTCHAR JsonText(reinterpret_cast<const ANSICHAR*>(Bytes.GetData() + 20), Length);
    TSharedPtr<FJsonObject> Gltf;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(FString(JsonText.Length(), JsonText.Get())), Gltf))
    { WriteStatus(TEXT("error"), TEXT("Invalid scene metadata")); return; }
    Bindings.Reset();
    const TArray<TSharedPtr<FJsonValue>>* Nodes;
    if (Gltf->TryGetArrayField(TEXT("nodes"), Nodes))
    {
        for (int32 Index = 0; Index < Nodes->Num(); ++Index)
        {
            const TSharedPtr<FJsonObject> Node = (*Nodes)[Index]->AsObject();
            const TSharedPtr<FJsonObject>* Extras;
            const TSharedPtr<FJsonObject>* Archai;
            FString Id;
            if (!Node->HasField(TEXT("mesh")) || !Node->TryGetObjectField(TEXT("extras"), Extras)) continue;
            if ((*Extras)->TryGetObjectField(TEXT("archai"), Archai)) (*Archai)->TryGetStringField(TEXT("id"), Id);
            if (Id.IsEmpty()) (*Extras)->TryGetStringField(TEXT("elementId"), Id);
            // The cooked glTF translator gives scene actors generated asset names,
            // even when display names exist. Match its node index to validated extras.
            const FString ImportedName = FString::Printf(TEXT("%s_node_%d"), *FPaths::GetBaseFilename(ModelFile), Index);
            if (!Id.IsEmpty()) Bindings.Add(ImportedName, Id);
        }
    }
    bLoading = true;
    PendingActors.Reset();
    StatusText = TEXT("Updating scene…");
    WriteStatus(TEXT("loading"));
    UInterchangeGenericAssetsPipeline* Assets = NewObject<UInterchangeGenericAssetsPipeline>(this);
    // Preserve instance nodes for the level pipeline. Runtime defaults otherwise bake
    // geometry into different factory nodes and leave scene actors without meshes.
    Assets->CommonMeshesProperties->bBakeMeshes = false;
    Assets->CommonMeshesProperties->bBakePivotMeshes = false;
    UInterchangeGenericLevelPipeline* Level = NewObject<UInterchangeGenericLevelPipeline>(this);
    Pipelines = { Assets, Level };
    FImportAssetParameters Params;
    Params.bIsAutomated = true;
    Params.ImportLevel = GetWorld()->PersistentLevel;
    Params.OverridePipelines = { FSoftObjectPath(Assets), FSoftObjectPath(Level) };
    Params.OnSceneObjectDoneNative.BindLambda([this](UObject* Object)
    { if (AActor* Actor = Cast<AActor>(Object)) { Actor->SetActorHiddenInGame(true); PendingActors.Add(Actor); } });
    Params.OnSceneImportDoneNative.BindLambda([this](const TArray<UObject*>&) { CompleteImport(); });
    UInterchangeSourceData* Source = UInterchangeManager::CreateSourceData(ModelPath);
    // UE 5.8's script wrapper checks the scene result before it enters InProgress.
    // The native asset result identifies a successfully started asynchronous import.
    const auto Results = UInterchangeManager::GetInterchangeManager().ImportSceneAsync(
        FString::Printf(TEXT("/Game/ArchaiRuntime/Revision_%lld"), PendingRevision), Source, Params);
    if (!Results.Get<0>()->IsValid())
    { bLoading = false; WriteStatus(TEXT("error"), TEXT("Unreal could not start the scene import")); }
}

void AArchaiRenderGameMode::CompleteImport()
{
    int32 MeshCount = 0, MappedCount = 0;
    TSet<FString> MatchedBindings;
    for (AActor* Actor : PendingActors)
    {
        TInlineComponentArray<UStaticMeshComponent*> Components(Actor);
        for (UStaticMeshComponent* Component : Components)
        {
            const UStaticMesh* Mesh = Component->GetStaticMesh();
            if (!Mesh) continue;
            ++MeshCount;
            UE_LOG(LogTemp, Display, TEXT("Archai imported mesh %s on %s"), *Mesh->GetName(), *Actor->GetName());
            for (const auto& Binding : Bindings)
            {
                if (Actor->GetName().Equals(Binding.Key, ESearchCase::IgnoreCase) || Actor->GetName().StartsWith(Binding.Key + TEXT("_"), ESearchCase::IgnoreCase) ||
                    Component->GetName().Equals(Binding.Key, ESearchCase::IgnoreCase) || Mesh->GetName().Equals(Binding.Key, ESearchCase::IgnoreCase))
                {
                    const FName Tag(*(TEXT("ArchaiObject=") + Binding.Value));
                    Component->ComponentTags.AddUnique(Tag);
                    Actor->Tags.AddUnique(Tag);
                    ++MappedCount;
                    MatchedBindings.Add(Binding.Key);
                    break;
                }
            }
        }
    }
    bLoading = false;
    UE_LOG(LogTemp, Display, TEXT("Archai import: %d actors, %d meshes, %d mapped, %d bindings"), PendingActors.Num(), MeshCount, MappedCount, Bindings.Num());
    if (!MeshCount || MeshCount != MappedCount || MatchedBindings.Num() != Bindings.Num())
    {
        for (AActor* Actor : PendingActors) if (IsValid(Actor)) Actor->Destroy();
        PendingActors.Reset();
        WriteStatus(TEXT("error"), TEXT("Scene import failed or object identity was lost"));
        return;
    }
    for (AActor* Actor : SceneActors) if (IsValid(Actor)) Actor->Destroy();
    SceneActors = MoveTemp(PendingActors);
    for (AActor* Actor : SceneActors) if (IsValid(Actor)) Actor->SetActorHiddenInGame(false);
    ModelHash = PendingHash;
    ++SceneImports;
    Revision = PendingRevision;
    ApplyLook(PendingTicket, bInitialCamera);
    bInitialCamera = false;
    StatusText = TEXT("Archai Render · Drag to orbit · Right-drag pan · Wheel zoom · Click to select · F frame");
    WriteStatus(TEXT("ready"));
    if (bSmoke && CapturePath.IsEmpty()) FPlatformMisc::RequestExit(false);
}

void AArchaiRenderGameMode::ApplyLook(const TSharedPtr<FJsonObject>& Ticket, bool ResetCamera)
{
    const TSharedPtr<FJsonObject>* Settings;
    if (Ticket->TryGetObjectField(TEXT("settings"), Settings))
    {
        const auto& Look = *Settings;
        double Altitude = 35, Azimuth = 220, Intensity = 3, SkyIntensity = 1, Exposure = 0;
        bool Enabled = true;
        Look->TryGetNumberField(TEXT("altitude"), Altitude);
        Look->TryGetNumberField(TEXT("azimuth"), Azimuth);
        Look->TryGetNumberField(TEXT("sunIntensity"), Intensity);
        Look->TryGetNumberField(TEXT("skyIntensity"), SkyIntensity);
        Look->TryGetNumberField(TEXT("exposure"), Exposure);
        Look->TryGetBoolField(TEXT("sunEnabled"), Enabled);
        Sun->SetActorRotation(FRotator(-FMath::Clamp(Altitude, -10.0, 90.0), Azimuth, 0));
        const TArray<TSharedPtr<FJsonValue>>* Direction;
        if (Ticket->TryGetArrayField(TEXT("sunDirection"), Direction) && Direction->Num() == 3)
            Sun->SetActorRotation((-SourcePosition(*Direction)).Rotation());
        Sun->GetLightComponent()->SetIntensity(Enabled ? FMath::Clamp(Intensity, 0.0, 10.0) * 10000 : 0);
        Sky->GetLightComponent()->SetIntensity(FMath::Clamp(SkyIntensity, 0.0, 5.0) * 5000);
        Post->Settings.bOverride_AutoExposureBias = true;
        Post->Settings.AutoExposureBias = FMath::Clamp(Exposure, -4.0, 4.0);
        Post->Settings.bOverride_AutoExposureApplyPhysicalCameraExposure = true;
        bool BakedPreview = false;
        Look->TryGetBoolField(TEXT("bakedPreview"), BakedPreview);
        FString ExposureMode = TEXT("auto"); Look->TryGetStringField(TEXT("exposureMode"), ExposureMode);
        const EAutoExposureMethod PreviousExposureMode=Post->Settings.AutoExposureMethod;
        Post->Settings.AutoExposureMethod = !BakedPreview && ExposureMode == TEXT("auto") ? EAutoExposureMethod::AEM_Histogram : EAutoExposureMethod::AEM_Manual;
        const auto ExtendedExposure = IConsoleManager::Get().FindConsoleVariable(TEXT("r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange"));
        const bool bExposureEV100 = ExtendedExposure && ExtendedExposure->GetInt() != 0;
        Post->Settings.bOverride_AutoExposureMinBrightness = true; Post->Settings.AutoExposureMinBrightness = bExposureEV100 ? 5.f : 0.03f;
        Post->Settings.bOverride_AutoExposureMaxBrightness = true; Post->Settings.AutoExposureMaxBrightness = bExposureEV100 ? 16.f : 20000.f;
        Post->Settings.bOverride_HistogramLogMin=true;Post->Settings.HistogramLogMin=bExposureEV100?3.f:-8.f;
        Post->Settings.bOverride_HistogramLogMax=true;Post->Settings.HistogramLogMax=bExposureEV100?18.f:16.f;
        Post->Settings.bOverride_AutoExposureSpeedUp = true; Post->Settings.AutoExposureSpeedUp = 3.f;
        Post->Settings.bOverride_AutoExposureSpeedDown = true; Post->Settings.AutoExposureSpeedDown = 2.f;
        if(ResetCamera||PreviousExposureMode!=Post->Settings.AutoExposureMethod)if(auto PC=GetWorld()->GetFirstPlayerController())if(PC->PlayerCameraManager)PC->PlayerCameraManager->SetGameCameraCutThisFrame();
        if (auto Dome = Cast<AStaticMeshActor>(EnvironmentSky)) if (auto Material = Cast<UMaterialInstanceDynamic>(Dome->GetStaticMeshComponent()->GetMaterial(0)))
            Material->SetScalarParameterValue(TEXT("SkyScale"), BakedPreview ? 1.f : 5000.f);
        // EV100 ~= 13 balances the photometric sun (30,000 lux by default).
        // Vertex-lit previews contain display-referred illumination instead.
        Post->Settings.AutoExposureApplyPhysicalCameraExposure = !BakedPreview;
        Post->Settings.bOverride_CameraISO = true; Post->Settings.CameraISO = 100;
        Post->Settings.bOverride_CameraShutterSpeed = true; Post->Settings.CameraShutterSpeed = 125;
        Post->Settings.bOverride_DepthOfFieldFstop = true; Post->Settings.DepthOfFieldFstop = 8;
        double Bloom = 0.1, AO = 1;
        Look->TryGetNumberField(TEXT("bloom"), Bloom); Look->TryGetNumberField(TEXT("ambientOcclusion"), AO);
        Post->Settings.bOverride_BloomIntensity = true; Post->Settings.BloomIntensity = FMath::Clamp(Bloom, 0.0, 2.0);
        Post->Settings.bOverride_BloomThreshold = true; Post->Settings.BloomThreshold = 3;
        Post->Settings.bOverride_AmbientOcclusionIntensity = true; Post->Settings.AmbientOcclusionIntensity = FMath::Clamp(AO, 0.0, 2.0);
        Post->Settings.bOverride_VignetteIntensity = true; Post->Settings.VignetteIntensity = 0;
        Post->Settings.bOverride_LumenSceneLightingQuality = true; Post->Settings.LumenSceneLightingQuality = 2;
        Post->Settings.bOverride_LumenFinalGatherQuality = true; Post->Settings.LumenFinalGatherQuality = 2;
        const TArray<TSharedPtr<FJsonValue>>* Lights;
        TSet<FString> Retained;
        if (Look->TryGetArrayField(TEXT("lights"), Lights)) for (const auto& Value : *Lights)
        {
            const TSharedPtr<FJsonObject> Light = Value->AsObject();
            FString Id, Kind, Color;
            const TArray<TSharedPtr<FJsonValue>>* Position;
            if (!Light || !Light->TryGetStringField(TEXT("id"), Id) || !Light->TryGetStringField(TEXT("kind"), Kind) ||
                !Light->TryGetArrayField(TEXT("position"), Position) || Position->Num() != 3) continue;
            Retained.Add(Id);
            ALight* Actor = ProjectLights.FindRef(Id);
            UClass* Type = Kind == TEXT("spot") ? ASpotLight::StaticClass() : Kind == TEXT("area") ? ARectLight::StaticClass() : APointLight::StaticClass();
            if (IsValid(Actor) && Actor->GetClass() != Type) { Actor->Destroy(); Actor = nullptr; }
            if (!IsValid(Actor))
            {
                Actor = GetWorld()->SpawnActor<ALight>(Type);
                ProjectLights.Add(Id, Actor);
                Actor->GetLightComponent()->SetMobility(EComponentMobility::Movable);
            }
            Actor->SetActorLocation(SourcePosition(*Position) * 1000.0);
            double Power = 3000, Radius = 10, Size = 1, Yaw = 0, Tilt = -90;
            bool On = true;
            Light->TryGetNumberField(TEXT("intensity"), Power); Light->TryGetBoolField(TEXT("enabled"), On);
            Light->TryGetNumberField(TEXT("radius"), Radius); Light->TryGetNumberField(TEXT("size"), Size);
            Light->TryGetNumberField(TEXT("yaw"), Yaw); Light->TryGetNumberField(TEXT("tilt"), Tilt);
            Actor->SetActorRotation(FRotator(Tilt, Yaw, 0));
            ULocalLightComponent* Component = CastChecked<ULocalLightComponent>(Actor->GetLightComponent());
            Component->SetIntensityUnits(ELightUnits::Lumens);
            Component->SetIntensity(On ? Power : 0);
            Component->SetAttenuationRadius(Radius * 100);
            if (Light->TryGetStringField(TEXT("color"), Color)) Component->SetLightColor(FLinearColor(FColor::FromHex(Color)));
            if (USpotLightComponent* Spot = Cast<USpotLightComponent>(Component)) {
                double Inner=20, Outer=45; Light->TryGetNumberField(TEXT("innerCone"),Inner); Light->TryGetNumberField(TEXT("outerCone"),Outer);
                Spot->SetOuterConeAngle(FMath::Clamp(Outer,1.0,89.0)); Spot->SetInnerConeAngle(FMath::Clamp(Inner,0.0,Outer));
            }
            if (URectLightComponent* Rect = Cast<URectLightComponent>(Component)) { double Height=Size; Light->TryGetNumberField(TEXT("height"),Height); Rect->SetSourceWidth(Size * 100); Rect->SetSourceHeight(Height * 100); }
        }
        for (auto It = ProjectLights.CreateIterator(); It; ++It) if (!Retained.Contains(It.Key()))
        { if (IsValid(It.Value())) It.Value()->Destroy(); It.RemoveCurrent(); }
    }
    if (!ResetCamera) return;
    const TSharedPtr<FJsonObject>* Camera;
    const TArray<TSharedPtr<FJsonValue>>* Position;
    const TArray<TSharedPtr<FJsonValue>>* Target;
    APlayerController* PC = GetWorld()->GetFirstPlayerController();
    if (PC && PC->GetPawn() && Ticket->TryGetObjectField(TEXT("camera"), Camera) &&
        (*Camera)->TryGetArrayField(TEXT("position"), Position) && Position->Num() == 3 &&
        (*Camera)->TryGetArrayField(TEXT("target"), Target) && Target->Num() == 3)
    {
        const FVector Point = SourcePosition(*Position);
        OrbitTarget = SourcePosition(*Target); bOrbitTarget = true;
        const FRotator Rotation = (SourcePosition(*Target) - Point).Rotation();
        PC->GetPawn()->SetActorLocationAndRotation(Point, Rotation);
        PC->SetControlRotation(Rotation);
        double VerticalFov = 55;
        (*Camera)->TryGetNumberField(TEXT("fov"), VerticalFov);
        int32 Width = 1280, Height = 800;
        PC->GetViewportSize(Width, Height);
        const double Aspect = Height > 0 ? static_cast<double>(Width) / Height : 1.6;
        PC->PlayerCameraManager->SetFOV(FMath::RadiansToDegrees(2 * FMath::Atan(FMath::Tan(FMath::DegreesToRadians(FMath::Clamp(VerticalFov, 10.0, 120.0)) / 2) * Aspect)));
    }
    else FrameScene();
}

void AArchaiRenderGameMode::PollViewport()
{
#if PLATFORM_WINDOWS
    if (!ParentHandle || Token.IsEmpty() || !GetWorld()->GetGameViewport()) return;
    const TSharedPtr<FJsonObject> Layout = ArchaiEmbedded::Enabled() ? ArchaiEmbedded::Read(TEXT("viewport")) : ReadJson(SessionDir / TEXT("viewport.json"));
    FString LayoutToken;
    if (!Layout || !Layout->TryGetStringField(TEXT("token"), LayoutToken) || LayoutToken != Token) return;
    const TSharedPtr<SWindow> Window = GetWorld()->GetGameViewport()->GetWindow();
    if (!Window.IsValid() || !Window->GetNativeWindow().IsValid()) return;
    const HWND Child = static_cast<HWND>(Window->GetNativeWindow()->GetOSWindowHandle());
    const HWND Parent = reinterpret_cast<HWND>(static_cast<UPTRINT>(ParentHandle));
    if (!IsWindow(Parent)) { FPlatformMisc::RequestExit(false); return; }
    if (!bEmbedded)
    {
        SetWindowLongPtr(Child, GWL_STYLE, (GetWindowLongPtr(Child, GWL_STYLE) & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)) | WS_CHILD | WS_CLIPSIBLINGS);
        SetParent(Child, Parent);
        bEmbedded = GetParent(Child) == Parent;
        if (!bEmbedded) { WriteStatus(TEXT("error"), TEXT("Could not attach the Unreal viewport to Archai.")); return; }
        ArchaiHostWindow = Parent;
        FApp::SetHasFocusFunction([]() { return IsWindow(ArchaiHostWindow) && GetForegroundWindow() == GetAncestor(ArchaiHostWindow, GA_ROOT); });
        FSlateApplication::Get().SetHandleDeviceInputWhenApplicationNotActive(true);
        SetWindowLongPtr(Child, GWL_EXSTYLE, GetWindowLongPtr(Child, GWL_EXSTYLE) & ~WS_EX_APPWINDOW);
    }
    const int32 X = FMath::Clamp(static_cast<int32>(Layout->GetNumberField(TEXT("x"))), 0, 32768);
    const int32 Y = FMath::Clamp(static_cast<int32>(Layout->GetNumberField(TEXT("y"))), 0, 32768);
    const int32 Width = FMath::Clamp(static_cast<int32>(Layout->GetNumberField(TEXT("width"))), 1, 16384);
    const int32 Height = FMath::Clamp(static_cast<int32>(Layout->GetNumberField(TEXT("height"))), 1, 16384);
    if (ViewportX != X || ViewportY != Y || ViewportWidth != Width || ViewportHeight != Height)
    {
        ViewportX = X; ViewportY = Y; ViewportWidth = Width; ViewportHeight = Height;
        SetWindowPos(Child, HWND_TOP, X, Y, Width, Height, SWP_NOACTIVATE | SWP_FRAMECHANGED);
        // UELibrary's native window starts at 1x1. Updating the HWND alone
        // leaves Unreal's cached hit-test region at that size, rejecting input.
        if(ArchaiEmbedded::Enabled())Window->GetNativeWindow()->ReshapeWindow(X,Y,Width,Height);
        if (!bLoading && !ModelHash.IsEmpty()) WriteStatus(TEXT("ready"));
    }
    Layout->TryGetStringField(TEXT("placementTool"), PlacementTool);
    Layout->TryGetBoolField(TEXT("navigationLocked"), bNavigationLocked);
    Layout->TryGetBoolField(TEXT("panTool"), bPanTool);
    const TArray<TSharedPtr<FJsonValue>>* Exclusions;
    FString NextClip = FString::Printf(TEXT("%d:%d"), Width, Height);
    if (Layout->TryGetArrayField(TEXT("exclusions"), Exclusions)) for (const auto& Value : *Exclusions)
    { const auto R = Value->AsObject(); if (R) NextClip += FString::Printf(TEXT(":%d,%d,%d,%d"), (int32)R->GetNumberField(TEXT("x")), (int32)R->GetNumberField(TEXT("y")), (int32)R->GetNumberField(TEXT("width")), (int32)R->GetNumberField(TEXT("height"))); }
    if (NextClip != ClipKey)
    {
        HRGN Region = CreateRectRgn(0, 0, Width, Height);
        if (Layout->TryGetArrayField(TEXT("exclusions"), Exclusions)) for (const auto& Value : *Exclusions)
        {
            const auto R = Value->AsObject(); if (!R) continue;
            const int32 L = R->GetNumberField(TEXT("x")), T = R->GetNumberField(TEXT("y"));
            HRGN Hole = CreateRectRgn(L, T, L + (int32)R->GetNumberField(TEXT("width")), T + (int32)R->GetNumberField(TEXT("height")));
            CombineRgn(Region, Region, Hole, RGN_DIFF); DeleteObject(Hole);
        }
        if (!SetWindowRgn(Child, Region, true)) DeleteObject(Region);
        ClipKey = NextClip;
    }
    const bool Visible = Layout->GetBoolField(TEXT("visible"));
    if(ArchaiEmbedded::Enabled()) {
        // Keep Slate's visibility cache in sync as well, so a retained hidden
        // scene stops drawing and can resume without rebuilding its meshes.
        const auto Native=Window->GetNativeWindow();
        if(Native->IsVisible()!=Visible) { if(Visible)Native->Show();else Native->Hide(); }
    } else if ((IsWindowVisible(Child) != 0) != Visible) ShowWindow(Child, Visible ? SW_SHOWNOACTIVATE : SW_HIDE);
#endif
}

void AArchaiRenderGameMode::FrameScene()
{
    if (bNavigationLocked) return;
    APlayerController* PC = GetWorld()->GetFirstPlayerController();
    if (!PC || !PC->GetPawn()) return;
    FBox Bounds(ForceInit);
    for (AActor* Actor : SceneActors) if (IsValid(Actor)) Bounds += Actor->GetComponentsBoundingBox(true);
    if (!Bounds.IsValid) return;
    const FVector Target = Bounds.GetCenter();
    OrbitTarget = Target; bOrbitTarget = true;
    const float Radius = FMath::Max(300.0, Bounds.GetExtent().Size());
    const FVector Point = Target + FVector(-Radius, -Radius, Radius * 0.8);
    PC->GetPawn()->SetActorLocation(Point);
    PC->SetControlRotation((Target - Point).Rotation());
}

void AArchaiRenderGameMode::WriteStatus(const FString& State, const FString& Error)
{
    if (Token.IsEmpty()) return;
    TSharedRef<FJsonObject> Status = MakeShared<FJsonObject>();
    Status->SetNumberField(TEXT("version"), 1);
    Status->SetStringField(TEXT("token"), Token);
    Status->SetStringField(TEXT("projectId"), ProjectId);
    Status->SetStringField(TEXT("state"), State);
    Status->SetBoolField(TEXT("embedded"), bEmbedded);
    if(ArchaiEmbedded::Enabled()) {
        Status->SetBoolField(TEXT("inputActive"),FSlateApplication::Get().IsActive());
        const auto Widget=FSlateApplication::Get().GetUserFocusedWidget(0);
        Status->SetStringField(TEXT("inputWidget"),Widget.IsValid()?Widget->GetTypeAsString():TEXT("none"));
        if(const auto Window=GetWorld()->GetGameViewport()->GetWindow();Window.IsValid()) {
            Status->SetStringField(TEXT("inputWindowPosition"),Window->GetPositionInScreen().ToString());
            Status->SetStringField(TEXT("inputWindowSize"),Window->GetSizeInScreen().ToString());
        }
    }
    Status->SetNumberField(TEXT("customLights"), ProjectLights.Num());
    Status->SetArrayField(TEXT("placements"), PlacementEvents);
    Status->SetNumberField(TEXT("viewportWidth"), ViewportWidth);
    Status->SetNumberField(TEXT("viewportHeight"), ViewportHeight);
    Status->SetNumberField(TEXT("revision"), State == TEXT("ready") ? Revision : PendingRevision);
    Status->SetBoolField(TEXT("standaloneRuntime"), true);
    Status->SetStringField(TEXT("error"), Error);
    int32 MeshCount = 0;
    for (AActor* Actor : SceneActors)
    {
        TInlineComponentArray<UStaticMeshComponent*> Components(Actor);
        for (UStaticMeshComponent* Component : Components) if (Component->GetStaticMesh()) ++MeshCount;
    }
    Status->SetNumberField(TEXT("meshActors"), MeshCount);
    Status->SetNumberField(TEXT("identityMappedActors"), MeshCount);
    Status->SetNumberField(TEXT("sceneImports"), SceneImports);
    Status->SetBoolField(TEXT("liveBridge"), bLiveBridge);
    Status->SetNumberField(TEXT("meshesBuilt"), MeshesBuilt);
    Status->SetStringField(TEXT("stage"), StatusText);
    if (State == TEXT("loading") && bLiveBridge) Status->SetNumberField(TEXT("progress"), LoadProgress);
    Status->SetNumberField(TEXT("lookRevision"), LookRevision);
    Status->SetStringField(TEXT("selectedObject"), SelectedObject);
    Status->SetNumberField(TEXT("selectionSequence"), SelectionSequence);
    if (Post) Status->SetNumberField(TEXT("exposure"), Post->Settings.AutoExposureBias);
    FBox Bounds(ForceInit);
    for (AActor* Actor : SceneActors) if (IsValid(Actor)) Bounds += Actor->GetComponentsBoundingBox(true);
    if (Bounds.IsValid)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (double Value : { Bounds.Min.X, Bounds.Min.Y, Bounds.Min.Z, Bounds.Max.X, Bounds.Max.Y, Bounds.Max.Z })
            Values.Add(MakeShared<FJsonValueNumber>(Value));
        Status->SetArrayField(TEXT("sceneBounds"), Values);
    }
    if (APlayerController* PC = GetWorld()->GetFirstPlayerController())
    {
        if (APawn* Pawn = PC->GetPawn())
        {
            const FVector Position = Pawn->GetActorLocation();
            TSharedRef<FJsonObject> Camera = MakeShared<FJsonObject>();
            Camera->SetNumberField(TEXT("x"), Position.X);
            Camera->SetNumberField(TEXT("y"), Position.Y);
            Camera->SetNumberField(TEXT("z"), Position.Z);
            Status->SetObjectField(TEXT("camera"), Camera);
            TSharedRef<FJsonObject> View = MakeShared<FJsonObject>();
            TArray<TSharedPtr<FJsonValue>> Eye, Aim;
            const FVector Target = bOrbitTarget ? OrbitTarget : Position + PC->GetControlRotation().Vector() * 1000;
            for (double Value : { Position.X * 10, Position.Z * 10, Position.Y * 10 }) Eye.Add(MakeShared<FJsonValueNumber>(Value));
            for (double Value : { Target.X * 10, Target.Z * 10, Target.Y * 10 }) Aim.Add(MakeShared<FJsonValueNumber>(Value));
            View->SetArrayField(TEXT("position"), Eye); View->SetArrayField(TEXT("target"), Aim);
            if (PC->PlayerCameraManager && ViewportWidth > 0 && ViewportHeight > 0)
            {
                const double Fov = FMath::RadiansToDegrees(2 * FMath::Atan(FMath::Tan(FMath::DegreesToRadians(PC->PlayerCameraManager->GetFOVAngle()) / 2) * ViewportHeight / ViewportWidth));
                View->SetNumberField(TEXT("fov"), FMath::Clamp(Fov, 10.0, 120.0));
            }
            Status->SetObjectField(TEXT("viewCamera"), View);
        }
    }
    if (!Error.IsEmpty()) StatusText = TEXT("Archai Render: ") + Error;
    FString Text;
    FJsonSerializer::Serialize(Status, TJsonWriterFactory<>::Create(&Text));
    if(ArchaiEmbedded::Enabled()) { ArchaiEmbedded::Status(Text);return; }
    const FString Temp = SessionDir / TEXT("status.tmp");
    const FString Destination = SessionDir / TEXT("status.json");
    if (FFileHelper::SaveStringToFile(Text, *Temp, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
        IFileManager::Get().Move(*Destination, *Temp, true);
}
