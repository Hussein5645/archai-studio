import { Aperture, Brush, Camera, CloudSun, Crosshair, Image as ImageIcon, Maximize, MousePointer2, Move3d, Palette, Pipette, RotateCw, Scaling, Sparkles, Sun, Trash2, Trees, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetCatalog } from '@/catalog';
import type { ArchaiDocument } from '@/document';
import { locationOf } from '@/analysis/model';
import type { Platform } from '@/platform/types';
import type { CameraState, SurfaceTarget } from '@/view3d/SceneView';
import { materialById } from '@/materials/slots';
import { MaterialAdjust } from '@/ui/MaterialAdjust';
import { StudioEngine, type ClickMode, type RenderMode } from './engine';
import { catalogEntourage, loadLibrary, type LibraryModel, type RenderLibrary } from './library';
import { LIBRARY_SIGN_IN_MESSAGE } from '@/cloud/library';
import { account } from '@/cloud/account';
import type { PaintMessage, SceneMessage } from './link';
import { loadMaterialLibrary, projectCopy, searchLibrary, type MaterialLibrary } from '@/materials/library';
import { DEFAULT_MATERIAL_IDS } from '@/materials/builtin';
import { swatchUrl } from '@/materials/swatch';
import type { PaintScope } from '@/materials/uiStore';
import type { Material } from '@/document';
import { defaultSettings, GROUNDS, parseSettings, settingsKey, type Ground, type RenderSettings } from './settings';
import styles from './RenderStudio.module.css';
import { BRAND_MARK } from '@/ui/brand';

/** The studio's click tools (D5-style top bar). */
type Tool = 'select' | 'paint' | 'pick' | 'focus';
/** The material in hand in the studio: one of the project's, or a library material (added on first use). */
type Brush = { kind: 'project'; id: string; name: string } | { kind: 'library'; id: string; name: string };

const SCOPES: [PaintScope, string, string][] = [
  ['face', 'Face', 'One face (a wall side, a slab top…)'],
  ['part', 'Part', 'The whole part (a wall layer, a door leaf, one model material)'],
  ['object', 'Object', 'Every part of the clicked object'],
  ['everywhere', 'Replace all', 'The clicked material everywhere it is used'],
];
type Still = { kind: 'setup' } | { kind: 'rendering'; progress: number } | { kind: 'done'; url: string; blob: Blob; width: number; height: number };

const RESOLUTIONS = [
  { label: 'HD 1280 × 720', width: 1280, height: 720 },
  { label: 'Full HD 1920 × 1080', width: 1920, height: 1080 },
  { label: 'QHD 2560 × 1440', width: 2560, height: 1440 },
  { label: '4K 3840 × 2160', width: 3840, height: 2160 },
  { label: 'Square 2048 × 2048', width: 2048, height: 2048 },
  { label: 'Portrait 1440 × 1920', width: 1440, height: 1920 },
];

let nextId = 0;
const newId = () => `e${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** Saved 3D views of the document: name and camera (millimetres). */
function documentViews(doc: ArchaiDocument | null): { id: string; name: string; camera: CameraState }[] {
  if (!doc) return [];
  const views: { id: string; name: string; camera: CameraState }[] = [];
  for (const element of Object.values(doc.elements)) {
    const view = element.meta?.['view3d'] as { camera?: CameraState | null; cameraMode?: boolean } | undefined;
    if (!view?.camera || !Array.isArray(view.camera.position)) continue;
    views.push({ id: element.id, name: element.name?.trim() || (view.cameraMode ? 'Camera' : '3D view'), camera: view.camera });
  }
  return views.sort((a, b) => a.name.localeCompare(b.name));
}

/** The site's location (map element) as sun defaults. */
function siteOf(doc: ArchaiDocument): Partial<RenderSettings> {
  for (const element of Object.values(doc.elements)) {
    const location = locationOf(element);
    if (location) return { latitude: location.lat, longitude: location.lon, utcOffset: location.utcOffset };
  }
  return {};
}

export function RenderStudio({ platform, catalog }: { platform: Platform; catalog: AssetCatalog }) {
  const viewport = useRef<HTMLDivElement>(null);
  const engine = useRef<StudioEngine | null>(null);
  const [scene, setScene] = useState<SceneMessage | null>(null);
  const [settings, setSettings] = useState<RenderSettings>(defaultSettings);
  const [library, setLibrary] = useState<RenderLibrary | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [catalogModels, setCatalogModels] = useState<LibraryModel[]>([]);
  const [materials, setMaterials] = useState<MaterialLibrary | null>(null);
  const [materialGroup, setMaterialGroup] = useState<string | null>(null);
  const [materialQuery, setMaterialQuery] = useState('');
  const [brush, setBrush] = useState<Brush | null>(null);
  const [scope, setScope] = useState<PaintScope>('face');
  const paintRef = useRef<{ brush: Brush | null; scope: PaintScope }>({ brush: null, scope: 'face' });
  useEffect(() => {
    paintRef.current = { brush, scope };
  }, [brush, scope]);
  const [mode, setMode] = useState<RenderMode>('realtime');
  const [samples, setSamples] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [libTab, setLibTab] = useState<'models' | 'materials' | 'sky'>('models');
  const [sceneTab, setSceneTab] = useState<'environment' | 'camera' | 'effects'>('environment');
  const [tool, setTool] = useState<Tool>('select');
  const [modelQuery, setModelQuery] = useState('');
  const [modelCategory, setModelCategory] = useState<string | null>(null);
  /** The material whose quick panel is open (picked from the model), or a copy being made for the picked part (nonce). */
  const [adjust, setAdjust] = useState<{ target: SurfaceTarget | null; materialId: string | null; nonce?: string } | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [gizmo, setGizmo] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [still, setStill] = useState<Still | null>(null);
  const [resolution, setResolution] = useState(1);
  const [stillSamples, setStillSamples] = useState(512);
  const [stillPathTraced, setStillPathTraced] = useState(true);
  const loadedDoc = useRef<string | null>(null);
  const connected = useRef(false);
  const settingsReady = useRef(false);
  const placingRef = useRef<string | null>(null);
  useEffect(() => {
    placingRef.current = placing;
  }, [placing]);

  // The board's catalog models first; render-only library models fill in ids the catalog lacks.
  const models = useMemo(() => {
    const map = new Map<string, LibraryModel>(catalogModels.map((m) => [m.id, m]));
    for (const m of library?.entourage ?? []) if (!map.has(m.id)) map.set(m.id, m);
    return map;
  }, [library, catalogModels]);
  const hdriUrl = useMemo(() => library?.hdris.find((h) => h.id === settings.hdri)?.url ?? null, [library, settings.hdri]);

  const update = useCallback((patch: Partial<RenderSettings>) => setSettings((s) => ({ ...s, ...patch })), []);

  // The engine, once.
  useEffect(() => {
    if (!viewport.current) return;
    const instance = new StudioEngine(viewport.current, {
      onSamples: setSamples,
      onStatus: setStatus,
      onSelect: setSelected,
      onFocus: (distance) => {
        update({ focusDistance: Math.round(distance * 100) / 100, depthOfField: true });
        setTool('select');
      },
      onPick: (target) => {
        if (!target.materialId) {
          setStatus("This part shows its model's own material: paint it first to adjust it");
          setTimeout(() => setStatus(null), 2500);
          return;
        }
        setAdjust({ target, materialId: target.materialId });
      },
      onPlace: (point) => {
        const asset = placingRef.current;
        if (!asset) return;
        // A random turn so rows of trees do not look stamped.
        setSettings((s) => ({ ...s, entourage: [...s.entourage, { id: newId(), asset, position: point, rotation: Math.random() * Math.PI * 2, scale: 1 }] }));
      },
      onEntourageChange: (id, position, rotation, scale) =>
        setSettings((s) => ({ ...s, entourage: s.entourage.map((item) => (item.id === id ? { ...item, position, rotation, scale } : item)) })),
      onPaint: (target, assetSlots, modifiers) => {
        const { brush: held, scope: chosen } = paintRef.current;
        if (!held || !platform.studio) return;
        const message: PaintMessage = {
          type: 'paint',
          target,
          scope: modifiers.shiftKey ? 'part' : modifiers.ctrlKey || modifiers.metaKey ? 'object' : chosen,
          material: held.kind === 'project' ? { id: held.id } : { library: held.id },
          assetSlots,
        };
        platform.studio.send(message as unknown as { type: string } & Record<string, unknown>);
        setStatus(`Painting with ${held.name}…`);
        setTimeout(() => setStatus((s) => (s?.startsWith('Painting') ? null : s)), 1500);
      },
    });
    engine.current = instance;
    // For debugging and end-to-end checks in development builds.
    if (import.meta.env.DEV) (window as unknown as { __studio?: StudioEngine }).__studio = instance;
    return () => {
      instance.dispose();
      engine.current = null;
    };
  }, [update, platform]);

  // The live link: say hello until the board answers, then follow its edits.
  useEffect(() => {
    if (!platform.studio) return;
    const unsubscribe = platform.studio.subscribe((message) => {
      if (message.type !== 'scene') return;
      connected.current = true;
      setScene(message as unknown as SceneMessage);
    });
    platform.studio.send({ type: 'hello' });
    // Until the board answers (it may still be starting, or have no project open).
    const hello = setInterval(() => {
      if (!connected.current) platform.studio?.send({ type: 'hello' });
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
    if (!scene) return;
    document.title = `${scene.name} · ArchAI Render`;
  }, [scene]);

  useEffect(() => {
    // The libraries need the account (shared with the board through host storage).
    void account().restore().then(() => {
      loadLibrary().then(setLibrary, (error: unknown) => setLibraryError(error instanceof Error ? error.message : String(error)));
      catalogEntourage(catalog).then(setCatalogModels, (error: unknown) => console.warn('Asset catalog unavailable in the studio', error));
      loadMaterialLibrary().then(setMaterials, (error: unknown) => console.warn('Material library unavailable', error));
    });
  }, [catalog]);

  // A new document: its saved settings (or site-based defaults); then the model.
  useEffect(() => {
    if (!scene || !engine.current) return;
    const first = loadedDoc.current !== scene.docId;
    if (first) {
      settingsReady.current = false;
      void platform.storage.get(settingsKey(scene.docId)).then((text) => {
        setSettings(text ? parseSettings(text) : { ...defaultSettings(), ...siteOf(scene.doc) });
        settingsReady.current = true;
      });
    }
    loadedDoc.current = scene.docId;
    setStatus('Building the model…');
    void engine.current.setDocument(scene.doc, catalog).then(() => {
      setStatus(null);
      if (scene.camera) engine.current?.setCamera(scene.camera);
      else if (first) engine.current?.frameAll();
    });
  }, [scene, catalog, platform]);

  useEffect(() => {
    void engine.current?.applySettings(settings, hdriUrl);
  }, [settings, hdriUrl]);
  useEffect(() => {
    void engine.current?.syncEntourage(settings.entourage, models);
  }, [settings.entourage, models]);
  // Saved a moment after each change.
  useEffect(() => {
    if (!scene || !settingsReady.current) return;
    const timer = setTimeout(() => void platform.storage.set(settingsKey(scene.docId), JSON.stringify(settings)), 500);
    return () => clearTimeout(timer);
  }, [settings, scene, platform]);

  useEffect(() => engine.current?.setMode(mode), [mode]);
  useEffect(() => {
    const mode: ClickMode = placing ? 'place' : tool === 'paint' && brush ? 'paint' : tool === 'pick' ? 'pick' : tool === 'focus' ? 'focus' : 'select';
    engine.current?.setClickMode(mode);
  }, [tool, placing, brush]);
  const takeBrush = (next: Brush) => {
    setBrush(next);
    setPlacing(null);
    setTool('paint');
  };
  useEffect(() => engine.current?.setGizmoMode(gizmo), [gizmo]);

  const removeSelected = useCallback(() => {
    if (!selected) return;
    setSettings((s) => ({ ...s, entourage: s.entourage.filter((item) => item.id !== selected) }));
  }, [selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
      if (event.key === 'Escape') {
        setPlacing(null);
        setBrush(null);
        setTool('select');
        setAdjust(null);
        engine.current?.select(null);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) removeSelected();
      else if (event.key === 'w' || event.key === 'W') setGizmo('translate');
      else if (event.key === 'e' || event.key === 'E') setGizmo('rotate');
      else if (event.key === 'r' || event.key === 'R') setGizmo('scale');
      else if (event.key === 'f' || event.key === 'F') engine.current?.frameAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, removeSelected]);

  const startStill = async () => {
    const preset = RESOLUTIONS[resolution]!;
    setStill({ kind: 'rendering', progress: 0 });
    try {
      const blob = await engine.current!.renderStill({ width: preset.width, height: preset.height, samples: stillSamples, pathTraced: stillPathTraced }, (progress) => setStill({ kind: 'rendering', progress }));
      setStill({ kind: 'done', url: URL.createObjectURL(blob), blob, width: preset.width, height: preset.height });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setStill(null);
    }
  };

  const saveStill = async () => {
    if (still?.kind !== 'done') return;
    const bytes = new Uint8Array(await still.blob.arrayBuffer());
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    await platform.files.saveBinary(bytes, `${scene?.name ?? 'ArchAI'} render ${stamp}.png`, 'image/png');
  };

  const closeStill = () => {
    if (still?.kind === 'done') URL.revokeObjectURL(still.url);
    setStill(null);
  };

  const views = documentViews(scene?.doc ?? null);
  const categories = useMemo(() => {
    const groups = new Map<string, LibraryModel[]>();
    for (const model of models.values()) groups.set(model.category, [...(groups.get(model.category) ?? []), model]);
    return [...groups.entries()];
  }, [models]);
  const projectMaterials = useMemo(() => Object.values(scene?.doc.materials ?? {}).filter((m) => !DEFAULT_MATERIAL_IDS.includes(m.id)), [scene]);
  const libraryShown = materials ? searchLibrary(materials.materials, materialQuery, materialGroup) : [];
  const pickLibrary = (id: string, name: string) => {
    const copy = scene ? projectCopy(scene.doc, `library:${id}`) : null;
    takeBrush(copy ? { kind: 'project', id: copy.id, name: copy.name } : { kind: 'library', id, name });
  };

  const modelList = [...models.values()].filter((m) => (!modelCategory || m.category === modelCategory) && (!modelQuery.trim() || `${m.name} ${m.category}`.toLowerCase().includes(modelQuery.trim().toLowerCase())));
  // After "Make unique" the board's copy arrives with the next scene (found by its nonce).
  const adjustId = adjust?.materialId ?? (adjust?.nonce && scene ? (Object.values(scene.doc.materials).find((m) => m.source === `unique:${adjust.nonce}`)?.id ?? null) : null);
  const adjustMaterial = adjustId && scene ? materialById(scene.doc, adjustId) : null;
  const selectedItem = selected ? settings.entourage.find((item) => item.id === selected) : undefined;
  const tools: [Tool, typeof MousePointer2, string, string][] = [
    ['select', MousePointer2, 'Select', 'Select and move entourage (W move, E turn, R scale)'],
    ['paint', Brush, 'Paint', 'Paint materials onto the model: pick one in the library first (Shift part, Ctrl object)'],
    ['pick', Pipette, 'Pick', 'Pick a material from the model to adjust its scale, rotation, colour…'],
    ['focus', Crosshair, 'Focus', 'Click the point to keep in focus (depth of field)'],
  ];
  const chooseTool = (next: Tool) => {
    setPlacing(null);
    if (next === 'paint' && !brush) setLibTab('materials');
    setTool(next);
  };

  return (
    <div className={styles.studio} data-testid="render-studio">
      <header className={styles.top}>
        <div className={styles.brand}>
          <img src={BRAND_MARK} alt="" aria-hidden="true" />
          <span>ArchAI Render</span>
        </div>
        <div className={styles.link} data-state={scene ? 'live' : 'waiting'} title={scene ? 'Edits in ArchAI appear here automatically' : 'Open a project in ArchAI and press Render in a 3D view'}>
          <span className={styles.dot} />
          {scene ? `Live · ${scene.name}` : 'Waiting for ArchAI…'}
        </div>
        <nav className={styles.tools} aria-label="Tools">
          {tools.map(([id, Icon, label, title]) => (
            <button key={id} type="button" aria-pressed={tool === id && !placing} onClick={() => chooseTool(id)} title={title} data-testid={`studio-tool-${id}`}>
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className={styles.modes} role="radiogroup" aria-label="Render mode">
          <button type="button" role="radio" aria-checked={mode === 'realtime'} onClick={() => setMode('realtime')}>
            Real-time
          </button>
          <button type="button" role="radio" aria-checked={mode === 'pathtrace'} onClick={() => setMode('pathtrace')}>
            Path traced{mode === 'pathtrace' && samples !== null ? ` · ${samples}` : ''}
          </button>
        </div>
        <div className={styles.topActions}>
          <button type="button" className={styles.ghost} onClick={() => engine.current?.frameAll()} title="Frame the model (F)">
            <Maximize size={15} />
          </button>
          <button type="button" className={styles.primary} onClick={() => setStill({ kind: 'setup' })} disabled={!scene}>
            <ImageIcon size={15} /> Render
          </button>
        </div>
      </header>

      {/* Left: the asset library, as in D5 (models, materials, skies). */}
      <aside className={styles.library} aria-label="Library">
        <nav className={styles.libTabs}>
          {(
            [
              ['models', Trees, 'Models'],
              ['materials', Palette, 'Materials'],
              ['sky', CloudSun, 'Sky'],
            ] as const
          ).map(([id, Icon, label]) => (
            <button key={id} type="button" aria-pressed={libTab === id} onClick={() => setLibTab(id)}>
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className={styles.libBody}>
          {libTab === 'models' && (
            <>
              <input className={styles.search} type="search" placeholder="Search models: tree, sofa, lamp…" value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} />
              <div className={styles.chips}>
                <button type="button" aria-pressed={modelCategory === null} onClick={() => setModelCategory(null)}>
                  All
                </button>
                {categories.map(([category]) => (
                  <button key={category} type="button" aria-pressed={modelCategory === category} onClick={() => setModelCategory(modelCategory === category ? null : category)}>
                    {category}
                  </button>
                ))}
              </div>
              {placing && <p className={styles.callout}>Click in the scene to place <b>{models.get(placing)?.name}</b>. Keep clicking for more · <kbd>Esc</kbd> to stop.</p>}
              {libraryError && <p className={styles.note}>{libraryError === LIBRARY_SIGN_IN_MESSAGE ? 'Sign in to ArchAI on the board, then reopen ArchAI Render, to use the render library.' : `The render library could not be loaded (${libraryError}).`}</p>}
              <div className={styles.cards}>
                {modelList.map((m) => (
                  <button key={m.id} type="button" aria-pressed={placing === m.id} onClick={() => setPlacing((p) => (p === m.id ? null : m.id))} title={m.widthMm ? `${m.name} · ${(m.widthMm / 1000).toFixed(1)} m wide` : m.name}>
                    <img src={m.thumb} alt="" loading="lazy" />
                    <span>{m.name}</span>
                  </button>
                ))}
              </div>
              {settings.entourage.length > 0 && (
                <button type="button" className={styles.wide} onClick={() => setSettings((s) => ({ ...s, entourage: [] }))}>
                  <Trash2 size={14} /> Remove all placed ({settings.entourage.length})
                </button>
              )}
              <p className={styles.note}>The board's Assets library: Poly Haven (CC0) and your own .CAI packages.</p>
            </>
          )}
          {libTab === 'materials' && (
            <>
              <input className={styles.search} type="search" placeholder="Search: brick, oak, marble…" value={materialQuery} onChange={(e) => setMaterialQuery(e.target.value)} />
              <div className={styles.chips}>
                <button type="button" aria-pressed={materialGroup === null} onClick={() => setMaterialGroup(null)}>
                  All
                </button>
                {(materials?.groups ?? []).map((g) => (
                  <button key={g} type="button" aria-pressed={materialGroup === g} onClick={() => setMaterialGroup(materialGroup === g ? null : g)}>
                    {g}
                  </button>
                ))}
              </div>
              {projectMaterials.length > 0 && scene && (
                <>
                  <h4 className={styles.libHeading}>In this project</h4>
                  <div className={styles.cards}>
                    {projectMaterials.map((m) => (
                      <button key={m.id} type="button" aria-pressed={brush?.kind === 'project' && brush.id === m.id} onClick={() => takeBrush({ kind: 'project', id: m.id, name: m.name })} title={m.name}>
                        <ProjectSwatch material={m} doc={scene.doc} />
                        <span>{m.name}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <h4 className={styles.libHeading}>Library</h4>
              {!materials && <p className={styles.note}>Loading the material library…</p>}
              <div className={styles.cards}>
                {libraryShown.map((m) => (
                  <button key={m.id} type="button" aria-pressed={brush?.name === m.name && (brush.kind === 'library' ? brush.id === m.id : projectCopy(scene?.doc ?? { materials: {} }, `library:${m.id}`)?.id === brush.id)} onClick={() => pickLibrary(m.id, m.name)} title={`${m.name} · ${m.group}`}>
                    <img src={m.thumb} alt="" loading="lazy" />
                    <span>{m.name}</span>
                  </button>
                ))}
              </div>
              <p className={styles.note}>Materials: Poly Haven (CC0). Changes go to the ArchAI project (Ctrl+Z there undoes them).</p>
            </>
          )}
          {libTab === 'sky' && (
            <>
              <Segmented value={settings.sky} options={[['sun', 'Sun & sky'], ['hdri', 'HDRI']]} onChange={(sky) => update({ sky })} />
              <div className={styles.hdris}>
                {(library?.hdris ?? []).map((h) => (
                  <button key={h.id} type="button" aria-pressed={settings.sky === 'hdri' && settings.hdri === h.id} onClick={() => update({ sky: 'hdri', hdri: h.id })} title={h.name}>
                    <img src={h.thumb} alt="" loading="lazy" />
                    <span>{h.name}</span>
                  </button>
                ))}
              </div>
              <p className={styles.note}>Skies: Poly Haven (CC0). Sun & sky follows the date, time and site in Environment.</p>
            </>
          )}
        </div>
      </aside>

      <main className={styles.viewport}>
        <div ref={viewport} className={styles.canvas} />
        {!scene && (
          <div className={styles.empty}>
            <img src={BRAND_MARK} alt="" />
            <h2>ArchAI Render</h2>
            <p>Open a project in ArchAI and press <b>Render</b> in any 3D view. The model appears here and follows your edits.</p>
          </div>
        )}
        {tool === 'paint' && brush && !placing && (
          <div className={styles.paintBar} role="toolbar" aria-label="Paint">
            <span className={styles.brushName}>
              <Brush size={14} /> {brush.name}
            </span>
            <div className={styles.segmented}>
              {SCOPES.map(([id, label, title]) => (
                <button key={id} type="button" aria-pressed={scope === id} onClick={() => setScope(id)} title={title}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {status && <div className={styles.status}>{status}</div>}
        {mode === 'pathtrace' && samples !== null && <div className={styles.samples}>{samples} samples</div>}
      </main>

      {/* Right: what is selected (an entourage item, a picked material), else the scene settings. */}
      <aside className={styles.inspector} aria-label="Properties">
        {adjustMaterial && scene && adjust ? (
          <div className={styles.inspectorBody}>
            <MaterialAdjust
              tone="dark"
              material={adjustMaterial}
              swatch={swatchUrl(adjustMaterial, scene.doc)}
              users={Object.values(scene.doc.elements).filter((element) => JSON.stringify(element.meta ?? {}).includes(`"${adjustMaterial.id}"`)).length}
              onPatch={(patch, commit) => commit && platform.studio?.send({ type: 'material-update', id: adjustMaterial.id, patch })}
              onMakeUnique={
                adjust.target
                  ? () => {
                      const nonce = Math.random().toString(36).slice(2, 10);
                      platform.studio?.send({ type: 'material-unique', target: adjust.target, materialId: adjustMaterial.id, nonce } as unknown as { type: string } & Record<string, unknown>);
                      setAdjust({ target: adjust.target, materialId: null, nonce });
                    }
                  : undefined
              }
              onClose={() => setAdjust(null)}
            />
          </div>
        ) : selectedItem ? (
          <div className={styles.inspectorBody}>
            <Section title={models.get(selectedItem.asset)?.name ?? 'Entourage'}>
              <div className={styles.row}>
                <button type="button" aria-pressed={gizmo === 'translate'} onClick={() => setGizmo('translate')} title="Move (W)">
                  <Move3d size={14} /> Move
                </button>
                <button type="button" aria-pressed={gizmo === 'rotate'} onClick={() => setGizmo('rotate')} title="Turn (E)">
                  <RotateCw size={14} /> Turn
                </button>
                <button type="button" aria-pressed={gizmo === 'scale'} onClick={() => setGizmo('scale')} title="Scale (R)">
                  <Scaling size={14} /> Scale
                </button>
              </div>
              <Slider label="Turn" value={Math.round(((selectedItem.rotation * 180) / Math.PI) % 360)} min={-180} max={180} step={1} unit="°" onChange={(deg) => setSettings((s) => ({ ...s, entourage: s.entourage.map((item) => (item.id === selectedItem.id ? { ...item, rotation: (deg * Math.PI) / 180 } : item)) }))} />
              <Slider label="Scale" value={selectedItem.scale} min={0.2} max={3} step={0.05} onChange={(scale) => setSettings((s) => ({ ...s, entourage: s.entourage.map((item) => (item.id === selectedItem.id ? { ...item, scale } : item)) }))} />
              <button type="button" className={styles.wide} onClick={removeSelected}>
                <Trash2 size={14} /> Delete
              </button>
            </Section>
          </div>
        ) : (
          <>
            <nav className={styles.sceneTabs}>
              {(
                [
                  ['environment', Sun, 'Environment'],
                  ['camera', Camera, 'Camera'],
                  ['effects', Sparkles, 'Effects'],
                ] as const
              ).map(([id, Icon, label]) => (
                <button key={id} type="button" aria-pressed={sceneTab === id} onClick={() => setSceneTab(id)}>
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </nav>
            <div className={styles.inspectorBody}>
              {sceneTab === 'environment' && (
                <>
                  <Section title="Sky">
                    <Segmented value={settings.sky} options={[['sun', 'Sun & sky'], ['hdri', 'HDRI']]} onChange={(sky) => update({ sky })} />
                    {settings.sky === 'hdri' && <Slider label="HDRI rotation" value={settings.hdriRotation} min={-180} max={180} step={1} unit="°" onChange={(hdriRotation) => update({ hdriRotation })} />}
                    <Slider label="Sky light" value={settings.skyIntensity} min={0} max={3} step={0.05} onChange={(skyIntensity) => update({ skyIntensity })} />
                  </Section>
                  <Section title="Sun">
                    <label className={styles.check}>
                      <input type="checkbox" checked={settings.sunEnabled} onChange={(e) => update({ sunEnabled: e.target.checked })} /> Sun light and shadows
                    </label>
                    <Segmented value={settings.sunMode} options={[['time', 'Date & time'], ['manual', 'Manual']]} onChange={(sunMode) => update({ sunMode })} />
                    {settings.sunMode === 'time' ? (
                      <>
                        <label className={styles.field}>
                          <span>Date</span>
                          <input type="date" value={settings.date} onChange={(e) => e.target.value && update({ date: e.target.value })} />
                        </label>
                        <Slider label="Time" value={settings.time} min={4} max={21} step={0.25} format={(v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`} onChange={(time) => update({ time })} />
                        <div className={styles.row}>
                          <NumberField label="Latitude" value={settings.latitude} step={0.0001} onChange={(latitude) => update({ latitude })} />
                          <NumberField label="Longitude" value={settings.longitude} step={0.0001} onChange={(longitude) => update({ longitude })} />
                        </div>
                        <div className={styles.row}>
                          <NumberField label="UTC offset" value={settings.utcOffset} step={0.5} onChange={(utcOffset) => update({ utcOffset })} />
                          <NumberField label="North (°)" value={settings.northAngle} step={1} onChange={(northAngle) => update({ northAngle })} />
                        </div>
                      </>
                    ) : (
                      <>
                        <Slider label="Direction" value={settings.azimuth} min={0} max={360} step={1} unit="°" onChange={(azimuth) => update({ azimuth })} />
                        <Slider label="Height" value={settings.altitude} min={-5} max={90} step={0.5} unit="°" onChange={(altitude) => update({ altitude })} />
                      </>
                    )}
                    <Slider label="Strength" value={settings.sunIntensity} min={0} max={8} step={0.1} onChange={(sunIntensity) => update({ sunIntensity })} />
                  </Section>
                  <Section title="Ground">
                    <div className={styles.swatches}>
                      {(Object.keys(GROUNDS) as Ground[]).map((g) => (
                        <button key={g} type="button" aria-pressed={settings.ground === g} onClick={() => update({ ground: g })} title={g}>
                          <span style={{ background: GROUNDS[g] || 'repeating-linear-gradient(45deg,#555 0 4px,#333 4px 8px)' }} />
                          {g}
                        </button>
                      ))}
                    </div>
                  </Section>
                </>
              )}
              {sceneTab === 'camera' && (
                <>
                  <Section title="Lens">
                    <Slider label="Field of view" value={settings.fov} min={15} max={110} step={1} unit="°" onChange={(fov) => update({ fov })} />
                  </Section>
                  <Section title="Depth of field (path traced)">
                    <label className={styles.check}>
                      <input type="checkbox" checked={settings.depthOfField} onChange={(e) => update({ depthOfField: e.target.checked })} /> Depth of field
                    </label>
                    <Slider label="Focus distance" value={settings.focusDistance} min={0.3} max={150} step={0.1} unit=" m" onChange={(focusDistance) => update({ focusDistance })} />
                    <Slider label="Aperture" value={settings.fStop} min={1} max={22} step={0.1} format={(v) => `f/${v.toFixed(1)}`} onChange={(fStop) => update({ fStop })} />
                    <button type="button" className={styles.wide} aria-pressed={tool === 'focus'} onClick={() => chooseTool(tool === 'focus' ? 'select' : 'focus')}>
                      <Crosshair size={14} /> {tool === 'focus' ? 'Click the point to focus on…' : 'Pick focus point'}
                    </button>
                  </Section>
                </>
              )}
              {sceneTab === 'effects' && (
                <Section title="Look">
                  <Segmented value={settings.toneMapping} options={[['agx', 'AgX'], ['aces', 'ACES'], ['neutral', 'Neutral']]} onChange={(toneMapping) => update({ toneMapping })} />
                  <Slider label="Exposure" value={settings.exposure} min={-3} max={3} step={0.05} unit=" EV" onChange={(exposure) => update({ exposure })} />
                  <Slider label="Ambient occlusion" value={settings.ambientOcclusion} min={0} max={2} step={0.05} onChange={(ambientOcclusion) => update({ ambientOcclusion })} />
                  <Slider label="Bloom" value={settings.bloom} min={0} max={1.5} step={0.01} onChange={(bloom) => update({ bloom })} />
                  <Slider label="Light bounces (path traced)" value={settings.bounces} min={1} max={12} step={1} onChange={(bounces) => update({ bounces })} />
                </Section>
              )}
            </div>
          </>
        )}
      </aside>

      {/* Bottom: the scenes (the document's saved 3D views), as D5's scene bar. */}
      <footer className={styles.scenes} aria-label="Scenes">
        <button type="button" className={styles.sceneCard} onClick={() => engine.current?.frameAll()} title="Frame the whole model (F)">
          <Maximize size={18} />
          <span>Whole model</span>
        </button>
        {views.map((v) => (
          <button key={v.id} type="button" className={styles.sceneCard} onClick={() => engine.current?.setCamera(v.camera)} title={`Look through ${v.name}`}>
            <Aperture size={18} />
            <span>{v.name}</span>
          </button>
        ))}
        {views.length === 0 && <p className={styles.note}>Save cameras in ArchAI's 3D views and they appear here as scenes.</p>}
      </footer>

      {still && (
        <div className={styles.overlay} role="dialog" aria-label="Render image">
          <div className={styles.dialog}>
            <header>
              <h3>Render image</h3>
              {still.kind !== 'rendering' && (
                <button type="button" className={styles.ghost} onClick={closeStill} aria-label="Close">
                  <X size={16} />
                </button>
              )}
            </header>
            {still.kind === 'setup' && (
              <>
                <label className={styles.field}>
                  <span>Size</span>
                  <select value={resolution} onChange={(e) => setResolution(Number(e.target.value))}>
                    {RESOLUTIONS.map((r, i) => (
                      <option key={r.label} value={i}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Segmented value={stillPathTraced ? 'pt' : 'rt'} options={[['pt', 'Path traced'], ['rt', 'Real-time']]} onChange={(v) => setStillPathTraced(v === 'pt')} />
                {stillPathTraced && (
                  <label className={styles.field}>
                    <span>Quality</span>
                    <select value={stillSamples} onChange={(e) => setStillSamples(Number(e.target.value))}>
                      <option value={128}>Draft · 128 samples</option>
                      <option value={512}>Good · 512 samples</option>
                      <option value={1500}>High · 1500 samples</option>
                      <option value={4000}>Final · 4000 samples</option>
                    </select>
                  </label>
                )}
                <p className={styles.note}>The image uses the current camera. Path traced images take from seconds to minutes depending on size, quality and your GPU.</p>
                <div className={styles.dialogActions}>
                  <button type="button" className={styles.primary} onClick={() => void startStill()}>
                    <ImageIcon size={15} /> Render
                  </button>
                </div>
              </>
            )}
            {still.kind === 'rendering' && (
              <>
                <div className={styles.progress}>
                  <span style={{ width: `${Math.round(still.progress * 100)}%` }} />
                </div>
                <p className={styles.note}>Rendering… {Math.round(still.progress * 100)}%</p>
              </>
            )}
            {still.kind === 'done' && (
              <>
                <img className={styles.preview} src={still.url} alt="Rendered image" />
                <p className={styles.note}>
                  {still.width} × {still.height}
                </p>
                <div className={styles.dialogActions}>
                  <button type="button" className={styles.ghost} onClick={() => setStill({ kind: 'setup' })}>
                    Render again
                  </button>
                  <button type="button" className={styles.primary} onClick={() => void saveStill()}>
                    Save PNG…
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A project material's swatch (its textures come with the document). */
function ProjectSwatch({ material, doc }: { material: Material; doc: ArchaiDocument }) {
  const [, redraw] = useState(0);
  const url = swatchUrl(material, doc, () => redraw((n) => n + 1));
  return url ? <img src={url} alt="" /> : <img alt="" style={{ background: material.color }} />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  return (
    <div className={styles.segmented}>
      {options.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, value, min, max, step, unit = '', format, onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; format?: (value: number) => string; onChange: (value: number) => void }) {
  return (
    <label className={styles.slider}>
      <span>
        {label}
        <em>{format ? format(value) : `${Number.isInteger(step) ? value : value.toFixed(2)}${unit}`}</em>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function NumberField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input type="number" value={value} step={step} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)} />
    </label>
  );
}
