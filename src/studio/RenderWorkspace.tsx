import { renderLightsOf } from '@/document/renderLight';
import { cameraNavigationLocked } from '@/document/viewCamera';
import { Brush, MapPin, Maximize, Pipette, X } from 'lucide-react';
import { materialUi, useMaterialUi } from '@/materials/uiStore';
import { instanceMaterialsOf, typeMaterialsOf } from '@/materials/slots';
import { showRenderControlsEvent } from './renderControls';
import { ViewOutputDialog, viewActionEvent, encodeImage, type ViewAction, type ImageOutput } from './ViewOutput';
import { exportScope } from './exportScope';
import { scenePlacement } from '@/view3d/placement';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp, useAppState } from '@/app/context';
import { createScenePackage } from './scenePackage';
import { parseSettings, settingsKey, type RenderSettings } from './settings';
import { renderOf, viewBakeSignature, type ViewBake } from './viewRender';
import { startViewBake, pendingBakeKey, type PendingViewBake } from './viewBake';
import { retainedLiveBuilder } from './unrealLiveScene';
import { exportInteractiveFolder, type InteractiveOutput } from './interactiveExport';
import { loadPreparation } from './preparationCache';
import { documentInContext, viewContext } from '@/document/viewVisibility';
import { viewSettingsOf } from '@/view3d/useSceneView';
import { saveViewPreview, useViewPreview } from '@/view3d/viewPreview';
import type { CameraState } from '@/view3d/SceneView';
import type { UnrealStatus } from '@shared/unrealRuntime';
import styles from './RenderWorkspace.module.css';

export function UnrealViewport({ portalId, onClose }: { portalId: string; onClose: () => void }) {
  const { platform, catalog, executor, store, toasts } = useApp();
  const doc = useAppState((state) => documentInContext(state.doc, viewContext(portalId)));
  const preview = useViewPreview(doc.id, portalId);
  const overlayVisible = useRef(false);
  const boundsQueue = useRef<Promise<void>>(Promise.resolve());
  const tool = useAppState((state) => state.ui.tool);
  const materialTools = useMaterialUi();
  const placement = useRef(scenePlacement({ store, executor, toasts }));
  const placementSequence = useRef(0);
  const selectionSequence = useRef(0);
  const headerRef = useRef<HTMLElement>(null);
  const editingBoard = useAppState((state) => Boolean(state.ui.view3d.editingBoard));
  const leftOpen = useAppState((state) => state.ui.panels.left);
  const inspectorOpen = useAppState((state) => state.ui.panels.inspector);
  useLayoutEffect(() => {
    const header = headerRef.current,
      main = header?.closest('main');
    if (!header || !main) return;
    const update = () =>
      main.style.setProperty(
        '--scene-toolbar-offset',
        Math.ceil(header.getBoundingClientRect().bottom - main.getBoundingClientRect().top + 12) +
          'px',
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => {
      observer.disconnect();
      main.style.removeProperty('--scene-toolbar-offset');
    };
  }, []);
  const openControls = () => {
    if (!store.getState().ui.panels.inspector) void executor.dispatch('toggle-inspector');
    window.dispatchEvent(new Event(showRenderControlsEvent));
  };
  const render = renderOf(doc, portalId);
  const camera = (doc.elements[portalId]?.meta?.['view3d'] as { camera?: CameraState } | undefined)
    ?.camera;
  const navigationLocked = cameraNavigationLocked(doc, portalId);
  const appearance = viewSettingsOf(doc, portalId).style ?? doc.workspace.viewStyle;
  const viewport = useRef<HTMLDivElement>(null);
  const model = useRef<{ key: string; bytes: ArrayBuffer } | null>(null);
  const [settings, setSettings] = useState(() => render.settings);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<UnrealStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState('');
  const [syncStage, setSyncStage] = useState('');
  const liveBuilder = useRef(retainedLiveBuilder(doc.id, portalId, platform.storage));
  const firstSync = useRef(true);
  const syncRequested = useRef(false);
  const syncLoop = useRef<Promise<void> | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [live, setLive] = useState(true);
  const [outputMode, setOutputMode] = useState<'render' | 'interactive' | null>(null);
  const [exportDestination, setExportDestination] = useState<'folder' | 'link'>('folder');
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const current = useRef({ doc, settings, camera });
  useEffect(
    () => () => {
      if (store.getState().doc.id !== initialProject.current) return;
      const latest = current.current;
      void platform.storage
        .set(settingsKey(latest.doc.id + ':' + portalId), JSON.stringify(latest.settings))
        .catch(() => undefined);
      executor.dispatchSync('set-view3d-settings', {
        id: portalId,
        renderSettings: latest.settings,
      });
      if (statusRef.current?.viewCamera)
        executor.dispatchSync('set-view3d-camera', {
          id: portalId,
          camera: statusRef.current.viewCamera,
        });
    },
    [executor, platform, portalId, store],
  );
  useEffect(() => {
    current.current = { doc, settings, camera };
  }, [doc, settings, camera]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialProject = useRef(doc.id);
  const [bakeStage, setBakeStage] = useState('');
  const bakePercent = bakeStage.startsWith('Preparing the WebXR version')
    ? Number(bakeStage.match(/(\d+)%/)?.[1] ?? 0)
    : undefined;
  const [preparingBake, setPreparingBake] = useState(false);
  const [pendingBake, setPendingBake] = useState<PendingViewBake | null>(null);
  useEffect(() => {
    const controls = () => { const s = renderOf(store.getState().doc, portalId).settings; return { exposure: s.exposure, exposureMode: s.exposureMode, sunEnabled: s.sunEnabled, sunIntensity: s.sunIntensity, skyIntensity: s.skyIntensity, bloom: s.bloom, ambientOcclusion: s.ambientOcclusion }; };
    let previous = JSON.stringify(controls());
    return store.subscribe(() => {
      const next = controls(), key = JSON.stringify(next);
      if (key !== previous) { previous = key; setSettings((value) => ({ ...value, ...next })); }
    });
  }, [store, portalId]);
  useEffect(() => {
    platform.window.setProgress?.(operation || syncStage || preparingBake || pendingBake || status?.state === 'starting' || status?.state === 'loading' ? 'indeterminate' : null);
    return () => platform.window.setProgress?.(null);
  }, [operation, syncStage, preparingBake, pendingBake, status?.state, platform]);
  const [vrLink, setVrLink] = useState('');
  const bakedModel = useRef<{ cacheId: string; bytes: ArrayBuffer } | null>(null);
  const viewKey = settingsKey(doc.id + ':' + portalId);
  const patchView = useCallback(
    (patch: Record<string, unknown>) =>
      executor.dispatch('set-view3d-settings', { id: portalId, ...patch }),
    [executor, portalId],
  );
  const initialSettings = useRef(render.settings);
  const migratedLights = useRef(false);
  const hasProjectSettings = useRef(
    Boolean(
      (doc.elements[portalId]?.meta?.['view3d'] as { renderSettings?: unknown })?.renderSettings,
    ),
  );
  const alive = useRef(true);

  useEffect(() => {
    if (doc.id !== initialProject.current) onClose();
  }, [doc.id, onClose]);
  useEffect(() => {
    alive.current = true;
    let active = true;
    void platform.storage
      .get(viewKey)
      .then((text) => {
        if (active) {
          const saved = hasProjectSettings.current
            ? initialSettings.current
            : text
              ? parseSettings(text)
              : initialSettings.current;
          setSettings({ ...saved, sky: 'sun', entourage: [] });
          setLoaded(true);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(String(reason));
          setLoaded(true);
        }
      });
    void platform.storage
      .get(pendingBakeKey(doc.id, portalId))
      .then((text) => {
        if (active && text) setPendingBake(JSON.parse(text));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [platform, doc.id, portalId, viewKey]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void platform.storage
        .set(viewKey, JSON.stringify(settings))
        .catch((reason: unknown) => setError(String(reason)));
      void patchView({ renderSettings: settings });
    }, 400);
    return () => clearTimeout(timer);
  }, [settings, loaded, viewKey, patchView, platform.storage]);
  useEffect(() => {
    if (!pendingBake || !platform.unreal?.bakeStatus) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const job = await platform.unreal!.bakeStatus!(pendingBake.jobId);
        if (!active) return;
        setBakeStage(job.stage);
        if (job.state === 'ready' && job.output) {
          const bake: ViewBake = {
            ...pendingBake,
            signature: pendingBake.signature,
            cacheId: pendingBake.cacheId,
            vertices: pendingBake.vertices,
            triangles: pendingBake.triangles,
            lightScale: pendingBake.lightScale,
            output: job.output,
            createdAt: new Date().toISOString(),
          };
          const result = await patchView({ bake });
          if (!result.ok) throw new Error(result.error.message);
          await platform.storage.delete(pendingBakeKey(doc.id, portalId));
          setPendingBake(null);
          setNotice(bake.webError ? `Unreal bake ready. Browser bake unavailable: ${bake.webError}` : 'Bake ready. Choose Baked scene or export a VR link.');
        } else if (job.state === 'error') {
          await platform.storage.delete(pendingBakeKey(doc.id, portalId));
          setPendingBake(null);
          setError(job.error ?? 'Unreal bake failed');
        }
      } catch (reason) {
        if (active) {
          setError(String(reason));
          setPendingBake(null);
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pendingBake, platform, doc.id, portalId, patchView]);

  useEffect(() => {
    if (!loaded || migratedLights.current || !settings.lights.length) return;
    migratedLights.current = true;
    void executor.dispatch('migrate-render-lights', { portalId, lights: settings.lights }).then((result) => {
      if (result.ok) setSettings((value) => ({ ...value, lights: [] }));
      else setError(result.error.message);
    });
  }, [loaded, settings.lights, executor, portalId]);
  const sendBounds = useCallback(async () => {
    const element = viewport.current;
    if (!element || !platform.unreal) return;
    const rect = element.getBoundingClientRect();
    const scale = window.devicePixelRatio;
    const layout = {
      x: Math.max(0, Math.round(rect.left * scale)),
      y: Math.max(0, Math.round(rect.top * scale)),
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
      visible: document.visibilityState === 'visible' && !overlayVisible.current,
      exclusions: [...document.querySelectorAll<HTMLElement>('[data-testid="left-panel"],[data-testid="inspector"],[role="toolbar"],header,footer,[data-unreal-overlay]')]
        .filter((node) => node !== element && node.getClientRects().length > 0 && !node.closest('[role="dialog"]'))
        .map((node) => node.getBoundingClientRect())
        .filter((r) => r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom && r.width > 2 && r.height > 2)
        .slice(0, 64).map((r) => ({ x: Math.floor((r.left - rect.left - 3) * scale), y: Math.floor((r.top - rect.top - 3) * scale), width: Math.ceil((r.width + 6) * scale), height: Math.ceil((r.height + 6) * scale) })),
      navigationLocked, panTool: tool === 'hand',
      placementTool:
        render.renderer === 'unreal' && tool !== 'select' && tool !== 'hand' ? tool : '',
    };
    const next = boundsQueue.current
      .catch(() => undefined)
      .then(() => platform.unreal!.viewport(layout));
    boundsQueue.current = next;
    await next;
  }, [platform, render.renderer, tool, navigationLocked]);
  useEffect(() => {
    void sendBounds().catch((reason: unknown) => setError(String(reason)));
  }, [sendBounds, leftOpen, inspectorOpen]);
  const boundsCallback = useRef(sendBounds);
  useEffect(() => {
    const check = () => {
      const blocked = [
        ...document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"]'),
      ].some((node) => node.getClientRects().length > 0);
      if (overlayVisible.current !== blocked) {
        overlayVisible.current = blocked;
        void boundsCallback.current().catch((reason: unknown) => setError(String(reason)));
      }
    };
    const observer = new MutationObserver(check);
    const layoutTimer = setInterval(() => { check(); void boundsCallback.current().catch(() => undefined); }, 350);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'open', 'aria-hidden'],
    });
    check();
    return () => { observer.disconnect(); clearInterval(layoutTimer); };
  }, []);
  useEffect(() => {
    boundsCallback.current = sendBounds;
  });
  useEffect(() => {
    const update = () =>
      void boundsCallback.current().catch((reason: unknown) => setError(String(reason)));
    const observer = new ResizeObserver(update);
    const mountedViewport = viewport.current;
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener('resize', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      alive.current = false;
      observer.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('visibilitychange', update);
      const rect = mountedViewport?.getBoundingClientRect();
      if (rect) void platform.unreal?.viewport({ x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.top)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)), visible: false, exclusions: [] }).catch(() => undefined);
    };
  }, [platform]);
  useEffect(() => {
    let active = true;
    let initial = true;
    const poll = () =>
      void platform.unreal
        ?.status()
        .then((next) => {
          if (active) {
            setStatus(next);
            if (initial) {
              initial = false;
              placementSequence.current = Math.max(0, ...(next.placements ?? []).map(event => event.sequence));
              selectionSequence.current = next.selectionSequence ?? 0;
            }
            if ((next.selectionSequence ?? 0) > selectionSequence.current) {
              selectionSequence.current = next.selectionSequence!;
              void executor.dispatch('select', { ids: next.selectedObject && store.getState().doc.elements[next.selectedObject] ? [next.selectedObject] : [] });
              const element = next.selectedObject ? store.getState().doc.elements[next.selectedObject] : null;
              const tools = materialUi.get();
              if (element && tools.painting && tools.active) {
                void executor.dispatch('paint-element', { ids: [element.id], materialId: tools.active, assetSlots: [] });
              } else if (element && tools.picking) {
                const materialId = Object.values(instanceMaterialsOf(element))[0] ?? Object.values(typeMaterialsOf(element))[0];
                if (materialId) { materialUi.set({ active: materialId, picking: false }); void executor.dispatch('show-materials'); }
                else toasts.push({ kind: 'info', message: "This element uses its model's original material. Choose a material in Materials to paint it." });
              }
            }
            for (const event of next.placements ?? []) {
              if (event.sequence <= placementSequence.current) continue;
              placementSequence.current = event.sequence;
              if (store.getState().ui.tool !== event.tool) continue;
              if (event.action === 'place') placement.current.place(event.point);
              if (event.action === 'finish') placement.current.finish();
              if (event.action === 'cancel') {
                placement.current.cancel();
                void executor.dispatch('set-tool', { tool: 'select' });
              }
            }
          }
        })
        .catch((reason: unknown) => {
          if (active) setError(String(reason));
        });
    poll();
    const timer = setInterval(poll, 600);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [platform, executor, store, toasts]);

  const packageCurrent = async (selected: string[] | null = null) => {
    const source = current.current;
    if (selected) {
      const { exportSceneSnapshot } = await import('@/view3d/vrExport');
      const bytes = await exportSceneSnapshot(source.doc, catalog, { maxTextureSize: 4096, stableMeshNames: true, include: exportScope(source.doc, selected), style: appearance });
      return createScenePackage(source.doc, { ...source.settings, lights: renderLightsOf(source.doc) }, bytes, statusRef.current?.viewCamera ?? source.camera);
    }
    const key =
      viewBakeSignature(source.doc, source.settings) + ':' + appearance;
    if (render.renderer !== 'baked' && model.current?.key !== key) {
      const { exportSceneSnapshot } = await import('@/view3d/vrExport');
      const bytes = await exportSceneSnapshot(source.doc, catalog, {
        maxTextureSize: 4096,
        stableMeshNames: true,
        style: appearance,
        extras: (id) => ({ parentId: source.doc.elements[id]?.parentId ?? null }),
      });
      model.current = { key, bytes };
    }
    if (render.renderer === 'baked' && render.bake) {
      if (bakedModel.current?.cacheId !== render.bake.cacheId + ':' + appearance) {
        const saved = await loadPreparation(platform.storage, render.bake.cacheId, 'baked');
        if (!saved)
          throw new Error('Saved bake data is missing on this computer. Bake this view again.');
        let bytes = saved.bytes;
        if (appearance !== 'realistic') {
          const [{ GLTFLoader }, { GLTFExporter }, { exportAppearance }] = await Promise.all([
            import('three/examples/jsm/loaders/GLTFLoader.js'),
            import('three/examples/jsm/exporters/GLTFExporter.js'),
            import('@/view3d/exportAppearance'),
          ]);
          const parsed = await new GLTFLoader().parseAsync(bytes, '');
          const dispose = exportAppearance(parsed.scene, appearance, 'm');
          try {
            const result = await new GLTFExporter().parseAsync(parsed.scene, { binary: true });
            if (!(result instanceof ArrayBuffer)) throw new Error('Could not apply the view style');
            bytes = result;
          } finally {
            dispose();
          }
        }
        bakedModel.current = { cacheId: render.bake.cacheId + ':' + appearance, bytes };
      }
      return createScenePackage(
        source.doc,
        {
          ...source.settings,
          bakedPreview: true,
          sunEnabled: false,
          skyIntensity: 0,
          lights: [],
          exposure: Math.max(
            -4,
            Math.min(4, source.settings.exposure + Math.log2(render.bake.lightScale)),
          ),
        },
        bakedModel.current.bytes,
        source.camera,
      );
    }
    return createScenePackage(source.doc, { ...source.settings, lights: [...source.settings.lights, ...renderLightsOf(source.doc)] }, model.current!.bytes, statusRef.current?.viewCamera ?? source.camera);
  };
  const synchronize = () => {
    syncRequested.current = true;
    if (syncLoop.current) return syncLoop.current;
    const job = queue.current
      .catch(() => undefined)
      .then(async () => {
        setBusy(true);
        setError('');
        try { do {
          syncRequested.current = false;
          if (!alive.current) return;
          await sendBounds();
          if (platform.unreal?.live && render.renderer !== 'baked') {
            const source = current.current;
            const runtimeStatus = await platform.unreal.status();
            if (runtimeStatus.state === 'idle' || runtimeStatus.state === 'closed' || runtimeStatus.state === 'error' || runtimeStatus.projectId !== source.doc.id) liveBuilder.current.resetUploads();
            let scene = await liveBuilder.current.build(source.doc, catalog, appearance, source.settings,
              firstSync.current ? source.camera : statusRef.current?.viewCamera ?? source.camera, setSyncStage);
            setSyncStage('Sending scene changes to Unreal…');
            if (alive.current) {
              let next;
              try { next = await platform.unreal.live(scene); }
              catch (reason) {
                if (!String(reason).includes('Refresh the scene cache')) throw reason;
                liveBuilder.current.invalidateCached();
                scene = await liveBuilder.current.build(source.doc, catalog, appearance, source.settings, source.camera, setSyncStage);
                next = await platform.unreal.live(scene);
              }
              liveBuilder.current.acknowledge(scene); setStatus(next);
              firstSync.current=false;
            }
          } else {
            setSyncStage('Preparing scene…');
            const packaged = await packageCurrent();
            setSyncStage('Loading scene in Unreal…');
            if (alive.current) setStatus((await platform.unreal?.update(packaged.bytes)) ?? null);
          }
        } while (syncRequested.current && alive.current);
        } catch (reason) {
          setError(String(reason));
          setLive(false);
        } finally {
          setSyncStage('');
          setBusy(false);
        }
      });
    queue.current = job;
    syncLoop.current = job;
    void job.finally(() => { if (syncLoop.current === job) syncLoop.current = null; });
    return job;
  };
  const syncCallback = useRef(synchronize);
  useEffect(() => {
    syncCallback.current = synchronize;
  });
  useEffect(() => {
    if (!loaded || !live) return;
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      void syncCallback.current();
    }, 800);
    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, [doc, settings, loaded, live, render.renderer]);

  const perform = async (action: 'image' | 'scene' | 'frame', image?: ImageOutput, selected: string[] | null = null) => {
    setBusy(true);
    setError('');
    setNotice('');
    setOperation(action === 'scene' ? 'Preparing interactive export…' : action === 'image' ? 'Preparing image render…' : 'Framing scene…');
    try {
      await queue.current;
      if (action !== 'scene') {
        if (autoTimer.current) {
          clearTimeout(autoTimer.current);
          autoTimer.current = null;
        }
        await synchronize();
        setBusy(true);
      }
      if (action === 'image') {
        setOperation(`Rendering image · ${image?.width ?? 1920} × ${image?.height ?? 1080}…`);
        const bytes = await platform.unreal!.image(image);
        setOperation('Saving rendered image…');
        const format = image?.format ?? 'png';
        await platform.files.saveBinary(await encodeImage(bytes, format), `Unreal render.${format === 'png' ? 'png' : 'jpg'}`, `image/${format}`);
      } else if (action === 'frame') await platform.unreal!.command('frame');
      else {
        const packaged = await packageCurrent(selected);
        setOperation('Exporting interactive scene…');
        const output = await platform.unreal!.exportScene(packaged.bytes);
        if (output) setNotice(`Interactive scene saved: ${output}`);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      setOperation('');
    }
  };
  const exportInteractive = async (ids: string[] | null, output: InteractiveOutput) => {
    setBusy(true); setError(''); setNotice(''); setOperation(output.destination === 'link' ? 'Preparing WebXR link…' : 'Preparing interactive folder…');
    try {
      await queue.current;
      if (output.destination === 'link') {
        const result = await executor.dispatch('publish-vr-tour', { portalId, elementIds: ids ?? undefined, interactive: output });
        if (!result.ok) throw new Error(result.error.message);
        setVrLink((result.value as { link: string }).link); setNotice('WebXR interactive link ready.');
      } else {
        const saved = await exportInteractiveFolder(platform, catalog, current.current.doc, portalId, ids, output, statusRef.current?.viewCamera ?? current.current.camera);
        if (saved) setNotice('Interactive scene saved: ' + saved);
      }
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); setOperation(''); }
  };
  const connected = status?.state === 'ready' && status.embedded;
  const loading = operation || syncStage || (status?.state === 'loading' || status?.state === 'starting'
    ? status.stage || 'Loading Unreal scene…'
    : !status && !error && platform.unreal ? 'Starting Unreal viewport…' : '');
  const update = (patch: Partial<RenderSettings>) =>
    setSettings((value) => ({ ...value, ...patch }));
  const capturePreview = useCallback(async () => {
    if (statusRef.current?.state !== 'ready') return;
    const bytes = await platform.unreal!.image();
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await saveViewPreview(platform, doc.id, portalId, 'data:image/png;base64,' + btoa(binary));
  }, [platform, doc.id, portalId]);
  useEffect(() => {
    if (status?.state !== 'ready' || !status.embedded) return;
    const timer = setTimeout(() => {
      void capturePreview().catch(() => undefined);
    }, 1200);
    return () => clearTimeout(timer);
  }, [status?.state, status?.revision, status?.embedded, capturePreview]);
  const close = async () => {
    setOperation('Saving view preview…');
    const latest = await platform.unreal?.status();
    if (latest) statusRef.current = latest;
    if (latest?.viewCamera)
      await executor.dispatch('set-view3d-camera', { id: portalId, camera: latest.viewCamera });
    try {
      await capturePreview();
    } catch {
      /* The previous completed preview remains available. */
    }
    try {
      await platform.storage.set(viewKey, JSON.stringify(current.current.settings));
      await patchView({ renderSettings: current.current.settings });
      onClose();
    } catch (reason) {
      setError('Could not save view settings: ' + String(reason));
    } finally {
      setOperation('');
    }
  };
  const bakeView = async () => {
    if (preparingBake || pendingBake) return;
    openControls();
    setPreparingBake(true);
    setBakeStage('Preparing the scene');
    setBusy(true);
    setError('');
    try {
      await patchView({ renderSettings: current.current.settings });
      const job = await startViewBake(
        platform,
        catalog,
        current.current.doc,
        portalId,
        current.current.settings,
        statusRef.current?.viewCamera ?? current.current.camera,
        setBakeStage,
      );
      setPendingBake(job);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      setPreparingBake(false);
    }
  };
  const actions = useRef<(action: ViewAction) => void>(() => {});
  useEffect(() => { actions.current = (action) => {
    if (action === 'render' || action === 'interactive') { setError(''); setExportDestination('folder'); setOutputMode(action); }
    else if (action === 'bake') void bakeView();
    else { setError(''); setExportDestination('link'); setOutputMode('interactive'); }
  }; });
  useEffect(() => {
    const handler = (event: Event) => { const detail = (event as CustomEvent<{ portalId: string; action: ViewAction }>).detail; if (detail.portalId === portalId) actions.current(detail.action); };
    window.addEventListener(viewActionEvent, handler);
    return () => window.removeEventListener(viewActionEvent, handler);
  }, [portalId]);
  return (
    <section
      className={styles.workspace}
      style={{
        left: editingBoard ? '55%' : 0,
      }}
      aria-label="Unreal rendering"
      data-testid="unreal-workspace"
    >
      <header ref={headerRef} className={styles.header}>
        <strong>{doc.elements[portalId]?.name || '3D view'}</strong>
        <button
          onClick={() => void executor.dispatch('toggle-view-board')}
          data-active={editingBoard}
        >
          Edit board
        </button>
        <button disabled={!connected || busy || navigationLocked} onClick={() => void perform('frame')}>
          <Maximize size={13} /> Frame all
        </button>
        <button data-active={tool === 'arch:vr-stop'} onClick={() => { materialUi.set({ painting: false, picking: false }); void executor.dispatch('set-tool', { tool: tool === 'arch:vr-stop' ? 'select' : 'arch:vr-stop' }); }} title="Click a floor to place a VR tour stop"><MapPin size={13} /> VR stop</button>
        <button data-active={materialTools.painting} title="Paint the clicked element with the material selected in Materials" onClick={() => { void executor.dispatch('set-tool', { tool: 'select' }); materialUi.set({ painting: !materialTools.painting, picking: false, scope: 'object' }); if (!materialTools.painting) void executor.dispatch('show-materials'); }}><Brush size={13} /> Paint</button>
        <button data-active={materialTools.picking} title="Pick the clicked element's assigned material" onClick={() => { void executor.dispatch('set-tool', { tool: 'select' }); materialUi.set({ picking: !materialTools.picking, painting: false }); }}><Pipette size={13} /> Pick</button>
        <button onClick={() => void close()} aria-label="Back to Board" title="Close 3D workspace">
          <X size={15} />
        </button>
      </header>
      <div
        className={styles.body}
        style={{
          left: 0, right: 0,
        }}
      >
        <div className={styles.viewport} ref={viewport} data-testid="unreal-viewport">
          {preview && (
            <img
              src={preview}
              alt="Saved render preview"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
              }}
            />
          )}
          {!connected && <p>Loading Unreal viewport…</p>}
        </div>

      </div>
      <footer
        className={styles.footer}
        data-ready={connected && !loading && !error && !status?.error && !notice && !pendingBake && !preparingBake && !vrLink || undefined}
        data-testid="unreal-status"
      >
        {connected
          ? `Unreal connected · ${status.meshActors} meshes`
          : !platform.unreal
            ? 'Unreal rendering requires the Archai desktop app.'
            : status?.available === false
              ? 'The bundled Unreal player is unavailable. Reinstall Archai with Unreal rendering.'
              : 'Preparing the Unreal viewport…'}{' '}
        ·{' '}
        {tool !== 'select' && tool !== 'hand'
          ? 'Click floors to place · Enter finishes · Esc cancels · '
          : ''}
        Drag to orbit · Right-drag to pan · Wheel to zoom · F frame
        {(error || status?.error) && <p role="alert">{error || status?.error} <button style={{ pointerEvents: 'auto' }} onClick={() => { setLive(true); void synchronize(); }}>Retry connection</button></p>}
        {notice && <p role="status">{notice}</p>}
        {loading && !error && !status?.error && !pendingBake && !preparingBake && <div className={styles.bakeProgress} data-testid="unreal-loading">
          <p role="status">{loading}</p>
          <div className={styles.bakeTrack} role="progressbar" aria-label="Unreal operation" aria-valuetext={loading}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={!operation && !syncStage && status?.progress !== undefined ? Math.round(status.progress * 100) : undefined}
            data-indeterminate={Boolean(operation || syncStage || status?.progress === undefined) || undefined}>
            <div className={styles.bakeFill} style={!operation && !syncStage && status?.progress !== undefined ? { width: `${status.progress * 100}%` } : undefined} />
          </div>
        </div>}
        {(pendingBake || preparingBake) && (
          <div className={styles.bakeProgress} data-testid="bake-progress">
            <strong>Baking scene</strong>
            <div
              className={styles.bakeTrack}
              role="progressbar"
              aria-label="Scene baking"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={bakePercent}
              aria-valuetext={bakeStage || 'Preparing bake…'}
              data-indeterminate={bakePercent === undefined || undefined}
            >
              <div className={styles.bakeFill} style={bakePercent === undefined ? undefined : { width: `${bakePercent}%` }} />
            </div>
            <p role="status">{bakeStage || 'Preparing bake…'}</p>
          </div>
        )}
        {vrLink && <input aria-label="VR link" readOnly value={vrLink} onFocus={(e) => e.currentTarget.select()} style={{ pointerEvents: 'auto' }} />}
      </footer>
      {outputMode && <ViewOutputDialog key={outputMode+exportDestination} initialDestination={exportDestination} portalId={portalId} result={vrLink || notice} mode={outputMode} busy={busy || Boolean(operation)} error={error || status?.error || ''} onClose={() => setOutputMode(null)} onImage={(options) => perform('image', options)} onInteractive={exportInteractive}>
        <label>Exposure<input aria-label="Render exposure" type="range" min="-4" max="4" step="0.1" value={settings.exposure} onChange={(e) => update({ exposure: Number(e.target.value) })} /></label>
        <label>Sun strength<input aria-label="Sun strength" type="range" min="0" max="10" step="0.1" value={settings.sunIntensity} onChange={(e) => update({ sunIntensity: Number(e.target.value) })} /></label>
        <label>Sky brightness<input aria-label="Sky brightness" type="range" min="0" max="5" step="0.1" value={settings.skyIntensity} onChange={(e) => update({ skyIntensity: Number(e.target.value) })} /></label>
      </ViewOutputDialog>}
    </section>
  );
}
