import { Camera, CloudSun, Glasses, Maximize } from 'lucide-react';
import { addLog } from '@/diagnostics';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AssetCatalog } from '@/catalog';
import type { ArchaiDocument } from '@/document';
import type { Platform } from '@/platform/types';
import { locationOf } from '@/analysis/model';
import { account } from '@/cloud/account';
import { vrStopsOf, vrTourJson } from '@/view3d/vrTour';
import { uploadVrTour, vrShareConfig, VR_SIGN_IN_MESSAGE } from '@/view3d/vrShare';
import type { CameraState } from '@/view3d/SceneView';
import { BRAND_MARK } from '@/ui/brand';
import { StudioEngine } from './engine';
import { disposeBake, restoreBake, type BakedScene } from './bake';
import { loadPreparation, savePreparation } from './preparationCache';
import { catalogEntourage, loadLibrary, type LibraryModel, type RenderLibrary } from './library';
import type { SceneMessage } from './link';
import {
  defaultSettings,
  GROUNDS,
  parseSettings,
  settingsKey,
  type Ground,
  type RenderSettings,
} from './settings';
import {
  preparationKey,
  preparationSignature,
  preparedLinkKey,
  throwIfCancelled,
  VR_QUALITY,
  type PreparedOutput,
  type VrQuality,
} from './vrPreparation';
import styles from './RenderStudio.module.css';

type Result = {
  signature: string;
  output: PreparedOutput;
  docId: string;
  bake?: BakedScene;
  blob?: Blob;
  url?: string;
  camera?: CameraState;
};
type Job = { label: string; progress: number; cancellable: boolean };
function siteOf(doc: ArchaiDocument): Partial<RenderSettings> {
  for (const element of Object.values(doc.elements)) {
    const location = locationOf(element);
    if (location)
      return { latitude: location.lat, longitude: location.lon, utcOffset: location.utcOffset };
  }
  return {};
}

export function RenderStudio({ platform, catalog }: { platform: Platform; catalog: AssetCatalog }) {
  const viewport = useRef<HTMLDivElement>(null);
  const engine = useRef<StudioEngine | null>(null);
  const [scene, setScene] = useState<SceneMessage | null>(null);
  const [autoBake, setAutoBake] = useState<string | null>(null);
  const [settings, setSettings] = useState<RenderSettings>(defaultSettings);
  const [library, setLibrary] = useState<RenderLibrary | null>(null);
  const [models, setModels] = useState(new Map<string, LibraryModel>());
  const [quality, setQuality] = useState<VrQuality>('balanced');
  const [output, setOutput] = useState<PreparedOutput>('baked');
  const [preview, setPreview] = useState<'fast' | 'rendered'>('fast');
  const [samples, setSamples] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => { if (error) addLog('error', `VR Preparation: ${error}`); }, [error]);
  useEffect(() => { if (status) addLog('info', `VR Preparation: ${status}`); }, [status]);
  const jobLabel = job?.label;
  useEffect(() => { if (jobLabel) addLog('info', `VR Preparation: ${jobLabel}`); }, [jobLabel]);
  const [result, setResult] = useState<Result | null>(null);
  const resultRef = useRef<Result | null>(null);
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const pendingScene = useRef<SceneMessage | null>(null);
  const mounted = useRef(true);
  const loading = useRef(0);
  const settingsDoc = useRef<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState<string | null>(null);
  const [readySignature, setReadySignature] = useState('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const builtDocument = useRef<string | null>(null);
  const [links, setLinks] = useState<Partial<Record<PreparedOutput, string>>>({});
  const hdriUrl = useMemo(
    () => library?.hdris.find((h) => h.id === settings.hdri)?.url ?? null,
    [library, settings.hdri],
  );
  const signature = scene ? preparationSignature(scene.doc, settings, quality) : '';
  const projectId = scene?.docId;
  const signatureRef = useRef(signature);
  useLayoutEffect(() => {
    signatureRef.current = signature;
  }, [signature]);
  const ready = Boolean(
    signature && readySignature === signature && settingsLoaded === scene?.docId,
  );
  const update = useCallback(
    (patch: Partial<RenderSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );
  const release = useCallback((prepared: Result | null) => {
    if (prepared?.bake) disposeBake(prepared.bake);
    if (prepared?.url) URL.revokeObjectURL(prepared.url);
  }, []);
  const unlock = useCallback(() => {
    locked.current = false;
    if (mounted.current) {
      setJob(null);
      if (pendingScene.current) setScene(pendingScene.current);
    }
    pendingScene.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!viewport.current) return;
    const instance = new StudioEngine(viewport.current, {
      onSamples: setSamples,
      onStatus: setStatus,
    });
    instance.setClickMode('preview');
    engine.current = instance;
    if (import.meta.env.DEV) (window as unknown as { __studio?: StudioEngine }).__studio = instance;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      release(resultRef.current);
      instance.dispose();
      engine.current = null;
    };
  }, [release]);
  useEffect(() => {
    if (!platform.studio) return;
    let connected = false;
    const unsubscribe = platform.studio.subscribe((message) => {
      if (message.type === 'scene') {
        connected = true;
        setAutoBake((current) => message['prepare'] === 'bake' ? String(message['docId']) : current === message['docId'] ? current : null);
        if (locked.current) pendingScene.current = message as unknown as SceneMessage;
        else setScene(message as unknown as SceneMessage);
      }
    });
    platform.studio.send({ type: 'hello' });
    const hello = setInterval(() => {
      if (!connected) platform.studio?.send({ type: 'hello' });
    }, 2000);
    const bye = () => platform.studio?.send({ type: 'bye' });
    window.addEventListener('beforeunload', bye);
    return () => {
      clearInterval(hello);
      unsubscribe();
      window.removeEventListener('beforeunload', bye);
      bye();
    };
  }, [platform]);
  useEffect(() => {
    let active = true;
    void account()
      .restore()
      .then(async () => {
        const [lib, entries] = await Promise.allSettled([loadLibrary(), catalogEntourage(catalog)]);
        if (!active) return;
        const map = new Map<string, LibraryModel>();
        if (lib.status === 'fulfilled') {
          setLibrary(lib.value);
          for (const model of lib.value.entourage) map.set(model.id, model);
        }
        if (entries.status === 'fulfilled')
          for (const model of entries.value) map.set(model.id, model);
        setModels(map);
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [catalog]);
  useEffect(() => {
    if (!scene) return;
    document.title = `${scene.name} · ArchAI VR Preparation`;
    if (settingsDoc.current === scene.docId) return;
    settingsDoc.current = scene.docId;
    setSettingsLoaded(null);
    setLinks({});
    controller.current?.abort();
    engine.current?.showBake(null);
    release(resultRef.current);
    resultRef.current = null;
    setResult(null);
    const docId = scene.docId;
    void Promise.all([
      platform.storage.get(settingsKey(scene.docId)),
      platform.storage.get(preparationKey(scene.docId)),
    ])
      .then(([text, preferences]) => {
        if (!mounted.current || settingsDoc.current !== docId) return;
        setSettings(text ? parseSettings(text) : { ...defaultSettings(), ...siteOf(scene.doc) });
        try {
          const saved = JSON.parse(preferences ?? '{}') as {
            quality?: VrQuality;
            output?: PreparedOutput;
          };
          setQuality(
            saved.quality && Object.hasOwn(VR_QUALITY, saved.quality) ? saved.quality : 'balanced',
          );
          setOutput(saved.output === 'panorama' ? 'panorama' : 'baked');
        } catch {
          setQuality('balanced');
          setOutput('baked');
        }
        setSettingsLoaded(scene.docId);
      })
      .catch((reason: unknown) => {
        if (mounted.current && settingsDoc.current === docId)
          setError(`Could not load preparation settings: ${String(reason)}`);
      });
  }, [scene, platform, release]);

  // Serialize asynchronous loads so old geometry or skies cannot replace the current scene.
  useEffect(() => {
    if (!scene || settingsLoaded !== scene.docId || locked.current) return;
    const sequence = ++loading.current;
    const instance = engine.current;
    controller.current?.abort();
    if (!instance) return;
    queue.current = queue.current
      .catch(() => undefined)
      .then(async () => {
        if (!mounted.current || sequence !== loading.current) return;
        setReadySignature('');
        instance.showBake(null);
        setStatus('Preparing the project scene…');
        const documentKey = preparationSignature(scene.doc, defaultSettings(), 'fast');
        const changedDocument = builtDocument.current !== documentKey;
        if (changedDocument) {
          await instance.setDocument(scene.doc, catalog);
          builtDocument.current = documentKey;
        }
        if (settings.sky === 'hdri' && !hdriUrl)
          throw new Error(
            'The selected HDRI is unavailable. Sign in and reopen preparation, or choose Sun & sky.',
          );
        await instance.applySettings(settings, hdriUrl);
        await instance.syncEntourage(settings.entourage, models);
        if (!mounted.current || sequence !== loading.current) return;
        if (scene.camera) instance.setCamera(scene.camera);
        else if (changedDocument && !resultRef.current) instance.frameAll();
        setStatus(null);
        setReadySignature(preparationSignature(scene.doc, settings, quality));
        const saved = resultRef.current;
        if (
          saved?.signature === preparationSignature(scene.doc, settings, quality) &&
          saved.output === output
        )
          instance.showBake(saved.bake?.root ?? null);
      })
      .catch((reason: unknown) => {
        if (mounted.current && sequence === loading.current) {
          setStatus(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
  }, [scene, settings, settingsLoaded, catalog, hdriUrl, models, quality, job, output]);

  // Restore both kinds independently; switching output never discards the project's saved bake.
  useEffect(() => {
    if (
      !projectId ||
      !ready ||
      job ||
      (resultRef.current?.docId === projectId && resultRef.current.output === output)
    )
      return;
    let active = true;
    const docId = projectId;
    void loadPreparation(platform.storage, docId, output)
      .then(async (saved) => {
        if (!saved || !active) return;
        const restored: Result = { ...saved.metadata };
        if (output === 'baked')
          restored.bake = await restoreBake(saved.bytes, {
            vertices: saved.metadata.vertices ?? 0,
            triangles: saved.metadata.triangles ?? 0,
            lightScale: saved.metadata.lightScale ?? 1,
          });
        else {
          restored.blob = new Blob([saved.bytes], { type: 'image/png' });
          restored.url = URL.createObjectURL(restored.blob);
        }
        if (!active || locked.current || settingsDoc.current !== docId) {
          release(restored);
          return;
        }
        engine.current?.showBake(null);
        release(resultRef.current);
        resultRef.current = restored;
        setResult(restored);
        if (restored.signature === signatureRef.current)
          engine.current?.showBake(restored.bake?.root ?? null);
      })
      .catch((reason: unknown) => {
        if (active) setError(`Could not restore saved preparation: ${String(reason)}`);
      });
    return () => {
      active = false;
    };
  }, [projectId, ready, output, job, platform, release]);
  useEffect(() => {
    if (!scene || settingsLoaded !== scene.docId) return;
    const timer = setTimeout(() => {
      void platform.storage
        .set(settingsKey(scene.docId), JSON.stringify(settings))
        .catch(() => undefined);
      void platform.storage
        .set(preparationKey(scene.docId), JSON.stringify({ quality, output }))
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [settings, scene, settingsLoaded, quality, output, platform]);
  useEffect(() => {
    if (result && result.signature !== signature) {
      controller.current?.abort();
      engine.current?.showBake(null);
    }
  }, [result, signature]);
  useEffect(() => {
    engine.current?.setMode(preview === 'fast' ? 'realtime' : 'pathtrace');
  }, [preview]);

  const stops = scene ? vrStopsOf(scene.doc) : [];
  const fresh = Boolean(
    result &&
    result.signature === signature &&
    result.output === output &&
    result.docId === scene?.docId,
  );
  const prepare = useCallback(async () => {
    const instance = engine.current;
    if (!scene || !instance || !ready || job) return;
    locked.current = true;
    const captured = signature;
    // Scene updates must wait for an active GPU capture to restore its camera and targets.
    let finishOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    queue.current = queue.current.catch(() => undefined).then(() => operation);
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    setJob({
      label: output === 'baked' ? 'Baking the VR scene' : 'Rendering the 360 image',
      progress: 0,
      cancellable: true,
    });
    let prepared: Result | null = null;
    try {
      setPreview('fast');
      instance.setMode('realtime');
      const progress = (fraction: number) => {
        if (mounted.current)
          setJob((current) => (current ? { ...current, progress: fraction } : null));
      };
      if (output === 'baked')
        prepared = {
          signature: captured,
          output,
          docId: scene.docId,
          bake: await instance.bakeVr(quality, abort.signal, progress),
        };
      else {
        const camera = instance.getCamera();
        const blob = await instance.renderPanorama(quality, abort.signal, progress);
        prepared = {
          signature: captured,
          output,
          docId: scene.docId,
          blob,
          url: URL.createObjectURL(blob),
          camera,
        };
      }
      throwIfCancelled(abort.signal);
      if (captured !== signatureRef.current)
        throw new DOMException(
          'The scene changed during preparation. Prepare it again.',
          'AbortError',
        );
      try {
        setJob((current) =>
          current
            ? { ...current, label: 'Saving preparation for this project', cancellable: false }
            : null,
        );
        await platform.storage.set(settingsKey(scene.docId), JSON.stringify(settings));
        await platform.storage.set(
          preparationKey(scene.docId),
          JSON.stringify({ quality, output }),
        );
        await savePreparation(
          platform.storage,
          {
            signature: prepared.signature,
            docId: prepared.docId,
            output: prepared.output,
            camera: prepared.camera,
            ...(prepared.bake
              ? {
                  vertices: prepared.bake.vertices,
                  triangles: prepared.bake.triangles,
                  lightScale: prepared.bake.lightScale,
                }
              : {}),
          },
          prepared.bake?.model ?? (await prepared.blob!.arrayBuffer()),
        );
      } catch (reason) {
        setError(
          `Prepared successfully, but saving failed. Keep this window open and try baking again: ${String(reason)}`,
        );
      }
      throwIfCancelled(abort.signal);
      if (!mounted.current) throw new DOMException('Preparation cancelled', 'AbortError');
      instance.showBake(null);
      release(resultRef.current);
      resultRef.current = prepared;
      setResult(prepared);
      if (prepared.bake) instance.showBake(prepared.bake.root);
      prepared = null;
    } catch (reason) {
      release(prepared);
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      finishOperation();
      if (controller.current === abort) controller.current = null;
      unlock();
    }
  }, [scene, ready, job, signature, output, quality, platform, settings, release, unlock]);
  useEffect(() => {
    if (!autoBake || !scene || scene.docId !== autoBake) return;
    if (settingsLoaded !== scene.docId || job) return;
    // Schedule the external bake after React commits the loaded scene and preparation controls.
    const timer = setTimeout(() => {
      if (output !== 'baked') { setOutput('baked'); return; }
      if (!ready) return;
      setAutoBake(null);
      void prepare();
    }, 0);
    return () => clearTimeout(timer);
  }, [autoBake, scene, settingsLoaded, output, ready, job, prepare]);

  const publish = async () => {
    if (!scene || !result || !fresh || job || !ready) return;
    if (output === 'baked' && !stops.length) {
      setError('Add at least one VR stop in the 3D view, then bake again.');
      return;
    }
    const config = vrShareConfig();
    if (!config) {
      setError(VR_SIGN_IN_MESSAGE);
      return;
    }
    const captured = result,
      docId = scene.docId;
    locked.current = true;
    setError(null);
    setJob({ label: 'Publishing the link', progress: 0, cancellable: false });
    try {
      const previousId = await platform.storage.get(preparedLinkKey(docId, output));
      if (captured.signature !== signatureRef.current)
        throw new Error('The scene changed. Prepare it again before publishing.');
      const tour = vrTourJson(scene.doc);
      tour.mode = output;
      tour.lighting = 'baked';
      tour.exposure = 2 ** settings.exposure;
      tour.toneMapping = settings.toneMapping;
      if (captured.bake) {
        tour.bake = 'vertex';
        tour.bakeScale = captured.bake.lightScale;
      }
      if (captured.camera) {
        const [x, y, z] = captured.camera.position.map((value) => value / 1000) as [
          number,
          number,
          number,
        ];
        const [tx, , tz] = captured.camera.target.map((value) => value / 1000);
        tour.spaces = [
          {
            id: 'panorama',
            name: '360 image',
            center: [x, z],
            look: [tx ?? x + 1, tz ?? z],
            floor: y - 1.65,
          },
        ];
        tour.start = 'panorama';
      }
      const published = await uploadVrTour(
        config,
        {
          previousId,
          ...(captured.bake ? { model: captured.bake.model } : { panorama: captured.blob! }),
          tour,
          validate: () => {
            if (captured.signature !== signatureRef.current)
              throw new Error(
                'The scene changed during publishing. Prepare it again. The previous link is unchanged.',
              );
          },
        },
        (progress) => {
          if (mounted.current)
            setJob({ label: 'Publishing the link', progress, cancellable: false });
        },
      );
      await platform.storage.set(preparedLinkKey(docId, output), published.id);
      if (mounted.current && settingsDoc.current === docId)
        setLinks((current) => ({ ...current, [captured.output]: published.link }));
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      unlock();
    }
  };
  const download = async () => {
    if (!fresh || !result?.blob || !scene) return;
    try {
      await platform.files.saveBinary(
        new Uint8Array(await result.blob.arrayBuffer()),
        `${scene.name} 360.png`,
        'image/png',
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const chooseOutput = (next: PreparedOutput) => {
    setOutput(next);
    engine.current?.showBake(
      next === 'baked' && result?.bake && result.signature === signature ? result.bake.root : null,
    );
  };
  const selectStop = (stop: (typeof stops)[number]) => {
    const r = (stop.heading * Math.PI) / 180;
    engine.current?.setCamera({
      position: [stop.x, stop.elevation + 1650, stop.y],
      target: [stop.x + Math.cos(r) * 3000, stop.elevation + 1650, stop.y + Math.sin(r) * 3000],
    });
  };

  return (
    <div className={styles.studio} data-testid="render-studio" aria-busy={!!job}>
      <header className={styles.top} inert={!!job}>
        <div className={styles.brand}>
          <img src={BRAND_MARK} alt="" />
          <span>ArchAI VR Preparation</span>
        </div>
        <div className={styles.link} data-state={scene ? 'live' : 'waiting'}>
          <span className={styles.dot} />
          {scene ? `Live · ${scene.name}` : 'Waiting for ArchAI…'}
        </div>
        <div className={styles.modes} role="radiogroup" aria-label="Preview quality">
          <button
            type="button"
            role="radio"
            aria-checked={preview === 'fast'}
            disabled={!!job}
            onClick={() => setPreview('fast')}
          >
            Fast preview
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={preview === 'rendered'}
            disabled={!!job || (!!result?.bake && fresh)}
            onClick={() => setPreview('rendered')}
          >
            Rendered preview
          </button>
        </div>
        <button
          type="button"
          className={styles.ghost}
          disabled={!!job}
          onClick={() => engine.current?.frameAll()}
          title="Frame the scene"
        >
          <Maximize size={16} />
        </button>
      </header>
      <aside className={styles.library} aria-label="VR publishing" inert={!!job}>
        <div className={styles.libBody}>
          <Section title="Prepare and publish">
            <p className={styles.note}>
              Add elements, furniture and materials on the board or in the 3D view. Your project
              updates here automatically.
            </p>
            <Segmented
              value={output}
              options={[
                ['baked', 'Baked 3D VR'],
                ['panorama', '360 image'],
              ]}
              disabled={!!job}
              onChange={chooseOutput}
            />
            <label className={styles.field}>
              <span>Quality</span>
              <select
                aria-label="Quality"
                value={quality}
                disabled={!!job}
                onChange={(e) => {
                  setQuality(e.target.value as VrQuality);
                  engine.current?.showBake(null);
                }}
              >
                {Object.entries(VR_QUALITY).map(([id, preset]) => (
                  <option key={id} value={id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <p className={styles.note}>
              {output === 'baked'
                ? 'Walkable 3D with sampled static lighting. Glass and reflections are approximated.'
                : 'A path-traced 360 image from the current camera. Look around from this fixed viewpoint.'}
            </p>
            {result && (
              <p className={fresh ? styles.callout : styles.note}>
                {fresh
                  ? 'Prepared output is ready to preview and publish.'
                  : 'The prepared output is outdated or belongs to the other output. Prepare again before publishing.'}
              </p>
            )}
            {fresh && result?.bake && (
              <p className={styles.note}>
                {result.bake.triangles.toLocaleString()} triangles ·{' '}
                {(result.bake.model.byteLength / 1048576).toFixed(1)} MB
              </p>
            )}
            <button
              type="button"
              className={styles.wide}
              disabled={!ready || !!job}
              onClick={() => void prepare()}
            >
              {output === 'baked' ? 'Bake scene' : 'Render 360 image'}
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={!fresh || !ready || !!job || (output === 'baked' && !stops.length)}
              onClick={() => void publish()}
            >
              <Glasses size={15} />
              Publish {output === 'baked' ? 'VR' : '360'} link
            </button>
            {output === 'panorama' && (
              <button
                type="button"
                className={styles.wide}
                disabled={!fresh || !!job}
                onClick={() => void download()}
              >
                Download 360 image
              </button>
            )}
            {job && (
              <div role="status">
                <p>
                  {job.label} · {Math.round(job.progress * 100)}%
                </p>
                <progress max={1} value={job.progress} />
                {job.cancellable && (
                  <button
                    type="button"
                    className={styles.wide}
                    onClick={() => controller.current?.abort()}
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            {links[output] && (
              <div className={styles.published}>
                <label className={styles.field}>
                  <span>Published link</span>
                  <input readOnly value={links[output]} onFocus={(e) => e.currentTarget.select()} />
                </label>
                <button
                  type="button"
                  className={styles.wide}
                  onClick={() =>
                    void platform.clipboard
                      .writeText(links[output]!)
                      .catch(() => setError('Could not copy the link'))
                  }
                >
                  Copy link
                </button>
                <a href={links[output]} target="_blank" rel="noreferrer">
                  Open published link
                </a>
              </div>
            )}
          </Section>
          <Section title={`VR stops · ${stops.length}`}>
            {!stops.length && (
              <p className={styles.note}>
                Place VR stops on floors in the 3D view. A 360 image can use the current camera
                without stops.
              </p>
            )}
            {stops.map((stop) => (
              <button
                key={stop.id}
                type="button"
                className={styles.wide}
                disabled={!!job}
                onClick={() => selectStop(stop)}
              >
                <Camera size={14} />
                {stop.name}
              </button>
            ))}
            {settings.entourage.length > 0 && (
              <p className={styles.note}>
                {settings.entourage.length} saved placements from the previous Render workspace are
                preserved and included.
              </p>
            )}
          </Section>
          <Section title="Sky library">
            <div className={styles.hdris}>
              {(library?.hdris ?? []).map((h) => (
                <button
                  key={h.id}
                  type="button"
                  disabled={!!job}
                  aria-pressed={settings.sky === 'hdri' && settings.hdri === h.id}
                  onClick={() => update({ sky: 'hdri', hdri: h.id })}
                >
                  <img src={h.thumb} alt="" loading="lazy" />
                  <span>{h.name}</span>
                </button>
              ))}
            </div>
          </Section>
        </div>
      </aside>
      <main className={styles.viewport}>
        <div ref={viewport} className={styles.canvas} inert={!!job} />
        {job && (
          <div className={styles.preparingOverlay} role="status" data-testid="preparation-lock">
            <strong>
              {job.label} · {Math.round(job.progress * 100)}%
            </strong>
            <p>Preparation is locked. Model updates will resume when this finishes.</p>
            <progress max={1} value={job.progress} />
            {job.cancellable && (
              <button
                type="button"
                className={styles.wide}
                onClick={() => controller.current?.abort()}
              >
                Cancel preparation
              </button>
            )}
          </div>
        )}
        {!scene && (
          <div className={styles.empty}>
            <CloudSun size={32} />
            <h2>Prepare your VR scene</h2>
            <p>Open a project, then choose VR → Prepare Rendered VR Link in the 3D view.</p>
          </div>
        )}
        {!job && fresh && output === 'panorama' && result?.url && (
          <div className={styles.panoramaPreview}>
            <img src={result.url} alt="Prepared equirectangular 360 image" />
            <button
              type="button"
              className={styles.ghost}
              onClick={() => {
                engine.current?.showBake(null);
                setOutput('baked');
              }}
            >
              Back to scene
            </button>
          </div>
        )}
        {status && !job && <div className={styles.status}>{status}</div>}
        {preview === 'rendered' && samples !== null && (
          <div className={styles.samples}>{samples} samples</div>
        )}
      </main>
      <aside className={styles.inspector} aria-label="Scene preparation settings" inert={!!job}>
        <fieldset className={styles.preparationSettings} disabled={!!job || !scene}>
          <Section title="Environment">
            <Segmented
              value={settings.sky}
              options={[
                ['sun', 'Sun & sky'],
                ['hdri', 'HDRI'],
              ]}
              onChange={(sky) => update({ sky })}
            />
            {settings.sky === 'hdri' && (
              <Slider
                label="HDRI rotation"
                value={settings.hdriRotation}
                min={-180}
                max={180}
                step={1}
                onChange={(hdriRotation) => update({ hdriRotation })}
              />
            )}
            <Slider
              label="Sky light"
              value={settings.skyIntensity}
              min={0}
              max={3}
              step={0.05}
              onChange={(skyIntensity) => update({ skyIntensity })}
            />
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={settings.sunEnabled}
                onChange={(e) => update({ sunEnabled: e.target.checked })}
              />
              Sun light and shadows
            </label>
            <Segmented
              value={settings.sunMode}
              options={[
                ['time', 'Date & time'],
                ['manual', 'Manual'],
              ]}
              onChange={(sunMode) => update({ sunMode })}
            />
            {settings.sunMode === 'time' ? (
              <>
                <label className={styles.field}>
                  <span>Date</span>
                  <input
                    type="date"
                    value={settings.date}
                    onChange={(e) => e.target.value && update({ date: e.target.value })}
                  />
                </label>
                <Slider
                  label="Time"
                  value={settings.time}
                  min={0}
                  max={24}
                  step={0.25}
                  onChange={(time) => update({ time })}
                />
                <NumberField
                  label="Latitude"
                  value={settings.latitude}
                  onChange={(latitude) =>
                    update({ latitude: Math.max(-90, Math.min(90, latitude)) })
                  }
                />
                <NumberField
                  label="Longitude"
                  value={settings.longitude}
                  onChange={(longitude) =>
                    update({ longitude: Math.max(-180, Math.min(180, longitude)) })
                  }
                />
                <NumberField
                  label="UTC offset"
                  value={settings.utcOffset}
                  onChange={(utcOffset) =>
                    update({ utcOffset: Math.max(-14, Math.min(14, utcOffset)) })
                  }
                />
                <NumberField
                  label="North angle"
                  value={settings.northAngle}
                  onChange={(northAngle) => update({ northAngle })}
                />
              </>
            ) : (
              <>
                <Slider
                  label="Direction"
                  value={settings.azimuth}
                  min={0}
                  max={360}
                  step={1}
                  onChange={(azimuth) => update({ azimuth })}
                />
                <Slider
                  label="Height"
                  value={settings.altitude}
                  min={-10}
                  max={90}
                  step={0.5}
                  onChange={(altitude) => update({ altitude })}
                />
              </>
            )}
            <Slider
              label="Sun strength"
              value={settings.sunIntensity}
              min={0}
              max={8}
              step={0.1}
              onChange={(sunIntensity) => update({ sunIntensity })}
            />
          </Section>
          <Section title="Ground">
            <div className={styles.swatches}>
              {(Object.keys(GROUNDS) as Ground[]).map((ground) => (
                <button
                  key={ground}
                  type="button"
                  aria-pressed={settings.ground === ground}
                  onClick={() => update({ ground })}
                >
                  <span style={{ background: GROUNDS[ground] || '#333' }} />
                  {ground}
                </button>
              ))}
            </div>
          </Section>
          <Section title="Look">
            <Segmented
              value={settings.toneMapping}
              options={[
                ['agx', 'AgX'],
                ['aces', 'ACES'],
                ['neutral', 'Neutral'],
              ]}
              onChange={(toneMapping) => update({ toneMapping })}
            />
            <Slider
              label="Exposure"
              value={settings.exposure}
              min={-3}
              max={3}
              step={0.05}
              onChange={(exposure) => update({ exposure })}
            />
            <Slider
              label="Ambient occlusion (preview)"
              value={settings.ambientOcclusion}
              min={0}
              max={2}
              step={0.05}
              onChange={(ambientOcclusion) => update({ ambientOcclusion })}
            />
            <Slider
              label="Bloom (preview)"
              value={settings.bloom}
              min={0}
              max={1.5}
              step={0.01}
              onChange={(bloom) => update({ bloom })}
            />
            <Slider
              label="Light bounces (360)"
              value={settings.bounces}
              min={1}
              max={12}
              step={1}
              onChange={(bounces) => update({ bounces })}
            />
          </Section>
        </fieldset>
      </aside>
      <footer className={styles.scenes} aria-label="Project cameras" inert={!!job}>
        <button
          type="button"
          className={styles.sceneCard}
          disabled={!!job}
          onClick={() => engine.current?.frameAll()}
        >
          <Maximize size={18} />
          <span>Whole model</span>
        </button>
        {Object.values(scene?.doc.elements ?? {}).flatMap((element) => {
          const view = element.meta?.['view3d'] as { camera?: CameraState } | undefined;
          return view?.camera
            ? [
                <button
                  key={element.id}
                  type="button"
                  className={styles.sceneCard}
                  disabled={!!job}
                  onClick={() => engine.current?.setCamera(view.camera!)}
                >
                  <Camera size={18} />
                  <span>{element.name || '3D view'}</span>
                </button>,
              ]
            : [];
        })}
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.segmented}>
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.slider}>
      <span>
        {label}
        <em>{Number.isInteger(step) ? value : value.toFixed(2)}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        step={0.25}
        onChange={(e) =>
          Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)
        }
      />
    </label>
  );
}
