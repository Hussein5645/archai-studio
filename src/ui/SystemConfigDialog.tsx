import { ArrowDown, ArrowUp, GripHorizontal, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useApp, useAppState, useDispatch } from '@/app/context';
import { instanceParameterKeys, systemDimensionParameters, mandatoryInstanceParameterKeys, SYSTEM_PARAMETER_DEFINITIONS, resolveSystemParameters, type SystemParameterValue } from '@/assets/system-assets';
import { doorTemplate, windowTemplate, wallSectionSvg } from '@/assets/system-geometry';
import { LINE_SYSTEM_TYPES, localPresetsId, parseSystemParameters, wallThickness, type CatalogAsset, type SystemAssetType, type WallLayer } from '@/catalog';
import type { Element } from '@/document';
import { WALL_PATH_KEYS } from '@/assets/wall-path';
import { hostOf, elementLod, wallEndsJoined } from '@/assets/arch-meta';
import { elementGraphicOverrides } from '@/graphics';
import { PathGeometryFields } from './PathGeometryFields';
import { localBounds } from '@/geometry';
import { instanceElevationOf } from '@/view3d/geometry';
import { Field, FieldRow, NumberField, SelectField, TextButton, TextField, ToggleRow } from './primitives';
import styles from './SystemConfigDialog.module.css';

function title(type: SystemAssetType): string {
  return type.replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function archData(element: Element): Record<string, unknown> {
  const value = element.meta?.['arch'];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function draftSignature(selectedId: string, parameters: Record<string, SystemParameterValue>, instanceEditable: string[] = []): string {
  return JSON.stringify([selectedId, parameters, [...instanceEditable].sort()]);
}

function pickFile(accept = '.cai,application/zip,application/x-zip-compressed'): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      resolve(file ? new Uint8Array(await file.arrayBuffer()) : null);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}

function View({ label, url, className }: { label: string; url?: string; className?: string }) {
  return (
    <div className={`${styles.view} ${className ?? ''}`}>
      <span>{label}</span>
      {url ? <img src={url} alt={`${label} view`} /> : <div className={styles.placeholder}><div /><div /></div>}
    </div>
  );
}

export function isLayerList(value: unknown): value is WallLayer[] {
  return Array.isArray(value) && value.every((layer) => layer && typeof layer === 'object' && typeof (layer as WallLayer).thickness === 'number');
}

export type ProfilePoint = [number, number];
export function isProfile(value: unknown): value is ProfilePoint[] {
  // Partial profiles (0–2 points) must remain valid editor state while the user is drawing.
  // The system schema still requires at least three points when Apply is pressed.
  return Array.isArray(value) && value.every((point) => Array.isArray(point) && point.length === 2 && typeof point[0] === 'number' && typeof point[1] === 'number');
}

export function ProfileEditor({ value, onChange, spatial = false, disabled = false }: { value: ProfilePoint[]; onChange: (points: ProfilePoint[]) => void; spatial?: boolean; disabled?: boolean }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ index: number; pointerId: number } | null>(null);
  const [snapping, setSnapping] = useState(true);
  const [activePoint, setActivePoint] = useState<number | null>(null);
  const [draggingPoint, setDraggingPoint] = useState(false);
  const [cursor, setCursor] = useState<{ point: ProfilePoint; alignX: boolean; alignY: boolean; segment?: number } | null>(null);
  const snapPoint = (raw: ProfilePoint, ignoredIndex = -1, disable = false): { point: ProfilePoint; alignX: boolean; alignY: boolean } => {
    if (disable) return { point: raw, alignX: false, alignY: false };
    const grid = 0.05;
    const threshold = 0.025;
    let x = Math.round(raw[0] / grid) * grid;
    let y = Math.round(raw[1] / grid) * grid;
    let alignX = false;
    let alignY = false;
    for (let index = 0; index < value.length; index++) {
      if (index === ignoredIndex) continue;
      const candidate = value[index]!;
      if (Math.abs(candidate[0] - raw[0]) <= threshold && (!alignX || Math.abs(candidate[0] - raw[0]) < Math.abs(x - raw[0]))) {
        x = candidate[0];
        alignX = true;
      }
      if (Math.abs(candidate[1] - raw[1]) <= threshold && (!alignY || Math.abs(candidate[1] - raw[1]) < Math.abs(y - raw[1]))) {
        y = candidate[1];
        alignY = true;
      }
    }
    return { point: [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))], alignX, alignY };
  };
  const nearestSegment = (point: ProfilePoint): { point: ProfilePoint; segment: number } => {
    let best = { point, segment: 0, distance: Number.POSITIVE_INFINITY };
    for (let index = 0; index < value.length; index++) {
      const a = value[index]!;
      const b = value[(index + 1) % value.length]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length2 = dx * dx + dy * dy;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2)) : 0;
      const projected: ProfilePoint = [a[0] + dx * t, a[1] + dy * t];
      const distance = Math.hypot(point[0] - projected[0], point[1] - projected[1]);
      if (distance < best.distance) best = { point: projected, segment: index, distance };
    }
    return { point: best.point, segment: best.segment };
  };
  const canvasPoint = (point: ProfilePoint) => [16 + point[0] * 208, 16 + point[1] * 148] as const;
  const profilePoint = (clientX: number, clientY: number): ProfilePoint => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const box = svg.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return [0, 0];
    // preserveAspectRatio="none" maps this box directly to the 240 × 180 viewBox.
    const localX = ((clientX - box.left) / box.width) * 240;
    const localY = ((clientY - box.top) / box.height) * 180;
    return [Math.max(0, Math.min(1, (localX - 16) / 208)), Math.max(0, Math.min(1, (localY - 16) / 148))];
  };
  const points = value.map((point) => canvasPoint(point).join(',')).join(' ');
  const closed = value.length >= 3;
  const beginPointDrag = (event: ReactPointerEvent<SVGCircleElement>, index: number) => {
    if (disabled) return;
    event.stopPropagation();
    setActivePoint(index);
    setDraggingPoint(true);
    dragRef.current = { index, pointerId: event.pointerId };
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
  };
  useEffect(() => {
    const removeActivePoint = (event: KeyboardEvent) => {
      if (disabled || (event.key !== 'Delete' && event.key !== 'Backspace') || activePoint === null) return;
      event.preventDefault();
      event.stopPropagation();
      onChange(value.filter((_, index) => index !== activePoint));
      dragRef.current = null;
      setDraggingPoint(false);
      setActivePoint(null);
    };
    window.addEventListener('keydown', removeActivePoint, true);
    return () => window.removeEventListener('keydown', removeActivePoint, true);
  }, [activePoint, disabled, onChange, value]);
  const movePointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const raw = profilePoint(event.clientX, event.clientY);
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      const snapped = snapPoint(raw, drag.index, !snapping || event.altKey);
      setCursor(snapped);
      onChange(value.map((point, index) => index === drag.index ? snapped.point : point));
      return;
    }
    const snapped = snapPoint(raw, -1, !snapping || event.altKey);
    if (closed) {
      const insertion = nearestSegment(snapped.point);
      setCursor({ ...snapped, point: insertion.point, segment: insertion.segment });
    } else setCursor(snapped);
  };
  const finishPointDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDraggingPoint(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div className={styles.profileEditor}>
      <svg
        ref={svgRef}
        viewBox="0 0 240 180"
        preserveAspectRatio="none"
        role="application"
        aria-label="Custom profile drawing area"
        aria-disabled={disabled}
        className={styles.profileCanvas}
        data-spatial={spatial || undefined}
        data-disabled={disabled || undefined}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          setActivePoint(null);
          const snapped = snapPoint(profilePoint(event.clientX, event.clientY), -1, !snapping || event.altKey);
          if (closed) {
            const insertion = nearestSegment(snapped.point);
            const a = value[insertion.segment]!;
            const b = value[(insertion.segment + 1) % value.length]!;
            if (Math.hypot(insertion.point[0] - a[0], insertion.point[1] - a[1]) < 0.015 || Math.hypot(insertion.point[0] - b[0], insertion.point[1] - b[1]) < 0.015) return;
            onChange([...value.slice(0, insertion.segment + 1), insertion.point, ...value.slice(insertion.segment + 1)]);
            return;
          }
          const next = snapped.point;
          const first = value[0];
          if (value.length >= 3 && first && Math.hypot(next[0] - first[0], next[1] - first[1]) < 0.055) return;
          onChange([...value, next]);
        }}
        onPointerMove={movePointer}
        onPointerUp={finishPointDrag}
        onPointerCancel={finishPointDrag}
        onPointerLeave={() => { if (!dragRef.current) setCursor(null); }}
      >
        <defs><pattern id="profile-grid" width="20.8" height="14.8" patternUnits="userSpaceOnUse"><path d="M20.8 0H0V14.8" fill="none" stroke="#dfe3e9" strokeWidth="0.7" /></pattern></defs>
        <rect x="16" y="16" width="208" height="148" fill="url(#profile-grid)" />
        {spatial && closed && <polygon points={value.map((point) => { const [x, y] = canvasPoint(point); return `${x + 8},${y - 7}`; }).join(' ')} fill="#9cc5e8" opacity="0.16" />}
        {closed ? (
          <polygon points={points} fill={spatial ? '#b9d8ee' : '#dde6f5'} fillOpacity="0.65" stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ) : (
          <polyline points={points} fill="none" stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        )}
        {cursor?.alignX && (() => { const [x] = canvasPoint(cursor.point); return <line x1={x} y1="16" x2={x} y2="164" stroke="#f59e0b" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />; })()}
        {cursor?.alignY && (() => { const [, y] = canvasPoint(cursor.point); return <line x1="16" y1={y} x2="224" y2={y} stroke="#f59e0b" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />; })()}
        {closed && cursor?.segment !== undefined && (() => {
          const a = canvasPoint(value[cursor.segment]!);
          const b = canvasPoint(value[(cursor.segment + 1) % value.length]!);
          const candidate = canvasPoint(cursor.point);
          return <><line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#f59e0b" strokeWidth="3" opacity="0.8" vectorEffect="non-scaling-stroke" /><circle cx={candidate[0]} cy={candidate[1]} r="4" fill="#fef3c7" stroke="#d97706" strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none" /></>;
        })()}
        {value.length > 0 && cursor && !draggingPoint && !closed && (() => {
          const [x, y] = canvasPoint(value.at(-1)!);
          const [cx, cy] = canvasPoint(cursor.point);
          return <line x1={x} y1={y} x2={cx} y2={cy} stroke="#77a2ee" strokeWidth="1.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />;
        })()}
        {value.map((point, index) => {
          const [x, y] = canvasPoint(point);
          return <circle key={index} cx={x} cy={y} r={activePoint === index ? 6 : index === 0 ? 5 : 4} fill={activePoint === index ? '#fef3c7' : index === 0 ? '#dbeafe' : '#fff'} stroke={activePoint === index ? '#d97706' : '#2563eb'} strokeWidth="2" vectorEffect="non-scaling-stroke" className={styles.profilePoint} onPointerDown={(event) => beginPointDrag(event, index)} />;
        })}
      </svg>
      <div className={styles.profileActions}>
        <TextButton disabled={disabled} onClick={() => onChange([])}>Clear</TextButton>
        <TextButton disabled={disabled} onClick={() => onChange([[0, 0], [1, 0], [1, 1], [0, 1]])}>Rectangle</TextButton>
        {value.length > 0 && <TextButton disabled={disabled} onClick={() => onChange(value.slice(0, -1))}>Undo point</TextButton>}
        <label className={styles.profileSnapToggle}>
          <input type="checkbox" checked={snapping} disabled={disabled} onChange={(event) => setSnapping(event.target.checked)} />
          Snap to grid and align
        </label>
      </div>
      <small>{value.length < 3 ? `${value.length} of at least 3 points · clicks snap to the grid and align with points` : 'Profile closed · click an edge to insert · drag a point to reshape · Delete removes the active point · Alt bypasses snapping'}</small>
    </div>
  );
}

function generatedPreview(type: SystemAssetType, parameters: Record<string, SystemParameterValue>, view: 'top' | 'front' | 'side'): string {
  if (view === 'top' && (type === 'door' || type === 'window')) {
    const template = type === 'door' ? doorTemplate(parseSystemParameters('door', parameters)) : windowTemplate(parseSystemParameters('window', parameters), 150);
    const margin = Math.max(template.width, template.height) * 0.08;
    const lines = template.elements.flatMap((element) => element.kind === 'line' ? [`<polyline points="${element.points.map(([x, y]) => `${x + element.x},${y + element.y}`).join(' ')}" fill="none" stroke="#333842" stroke-width="${element.style.strokeWidth}"/>`] : []).join('');
    return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-margin} ${-margin} ${template.width + margin * 2} ${template.height + margin * 2}">${lines}</svg>`)}`;
  }
  const circular = type === 'column' && parameters['shape'] === 'circle';
  const width = Number(circular ? parameters['diameter'] : parameters['width'] ?? parameters['mullionSpacing'] ?? 1000);
  const depth = Number(circular ? parameters['diameter'] : parameters['depth'] ?? parameters['thickness'] ?? parameters['treadDepth'] ?? 200);
  const height = Number(parameters['height'] ?? parameters['totalRise'] ?? parameters['panelSpacing'] ?? parameters['thickness'] ?? 3000);
  const horizontal = view === 'side' ? depth : width;
  const vertical = view === 'top' ? depth : height;
  const scale = Math.min(230 / Math.max(1, horizontal), 150 / Math.max(1, vertical));
  const w = Math.max(1, horizontal * scale), h = Math.max(1, vertical * scale);
  const x = (300 - w) / 2, y = (180 - h) / 2;
  const candidate = parameters[type === 'curtain-wall' ? 'panelProfile' : 'profile'];
  const profile = isProfile(candidate) && candidate.length >= 3 ? candidate : [[0, 0], [1, 0], [1, 1], [0, 1]];
  const polygon = profile.map((point) => `${x + (point[0] ?? 0) * w},${y + (point[1] ?? 0) * h}`).join(' ');
  const paint = 'fill="#dfe7f3" stroke="#333842" stroke-width="2"';
  const body = view === 'top' && circular
    ? `<ellipse cx="150" cy="90" rx="${w / 2}" ry="${h / 2}" ${paint}/>`
    : view === 'top' && (type === 'facade-element' || type === 'column' && parameters['shape'] === 'custom')
      ? `<polygon points="${polygon}" ${paint}/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${paint}/>`;
  const caption = `${title(type)} · ${view} · ${Math.round(horizontal)} × ${Math.round(vertical)} mm`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 210">${body}<text x="150" y="200" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#596273">${caption}</text></svg>`)}`;
}

/** Editable list of wall layers, outside → inside. */
export function LayersEditor({ value, onChange }: { value: WallLayer[]; onChange: (layers: WallLayer[]) => void }) {
  const workspace = useAppState((state) => state.doc.workspace);
  const library = useAppState((state) => state.doc.materials);
  // Layer materials: the project's library plus "the default finish / core material".
  const materialOptions = [{ value: '', label: 'Default material' }, ...Object.values(library).map((material) => ({ value: material.id, label: material.name }))];
  const update = (index: number, patch: Partial<WallLayer>) => onChange(value.map((layer, i) => (i === index ? { ...layer, ...patch } : layer)));
  const move = (index: number, delta: number) => {
    const next = [...value];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <div className={styles.layers} data-testid="wall-layers">
      {value.map((layer, index) => (
        <div key={index} className={styles.layerRow} data-role={layer.role}>
          <TextField value={layer.name} onCommit={(name) => update(index, { name: name || layer.name })} ariaLabel={`Layer ${index + 1} name`} />
          <SelectField value={layer.role} options={[{ value: 'core', label: 'Core' }, { value: 'finish', label: 'Finish' }]} onChange={(role) => update(index, { role })} ariaLabel={`Layer ${index + 1} role`} />
          <NumberField value={layer.thickness} unit={workspace.unit} precision={workspace.precision} min={1} onCommit={(thickness) => update(index, { thickness })} ariaLabel={`Layer ${index + 1} thickness`} />
          <select
            className={styles.layerMaterial}
            value={layer.material && (library[layer.material] || layer.material.startsWith('default:')) ? layer.material : ''}
            onChange={(event) => update(index, { material: event.target.value || undefined })}
            aria-label={`Layer ${index + 1} material`}
            title="Layer material (3D)"
          >
            {materialOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            {layer.material?.startsWith('default:') && !library[layer.material] && <option value={layer.material}>{layer.material.slice(8)}</option>}
          </select>
          <span className={styles.layerTools}>
            <button type="button" aria-label="Move layer out" title="Move outwards" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
            <button type="button" aria-label="Move layer in" title="Move inwards" disabled={index === value.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
            <button type="button" aria-label="Remove layer" title="Remove" disabled={value.length <= 1} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={12} /></button>
          </span>
        </div>
      ))}
      <div className={styles.layerFooter}>
        <button type="button" className={styles.addLayer} onClick={() => onChange([...value, { name: 'Finish', role: 'finish', thickness: 13 }])}>
          <Plus size={12} /> Add layer
        </button>
        <span>Total {wallThickness(value)} mm</span>
      </div>
    </div>
  );
}

export function SystemConfigDialog({ element, type, onClose, applyTo = 'type' }: { element: Element; type: SystemAssetType; onClose: () => void; applyTo?: 'type' | 'instance' }) {
  const { catalog, toasts } = useApp();
  const dispatch = useDispatch();
  const workspace = useAppState((state) => state.doc.workspace);
  const doc = useAppState((state) => state.doc);
  const initialArch = archData(element);
  const pathBased = element.kind === 'line' && (type === 'wall' || type === 'curtain-wall');
  const constraint = element.meta?.['levelConstraint'];
  const levelLink = constraint && typeof constraint === 'object' && !Array.isArray(constraint) ? constraint : null;
  const hostId = hostOf(element);
  const definition = element.kind === 'instance' ? doc.definitions[element.definitionId] : null;
  const bounds = localBounds(doc.elements, element);
  const [assets, setAssets] = useState<CatalogAsset[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState(typeof initialArch['systemAssetId'] === 'string' ? initialArch['systemAssetId'] : '');
  const [parameters, setParameters] = useState<Record<string, SystemParameterValue>>(() => resolveSystemParameters(type, initialArch['parameters']));
  const mandatoryEditable = mandatoryInstanceParameterKeys(type);
  const initialEditable = instanceParameterKeys(type, initialArch['instanceEditable']);
  const [instanceEditable, setInstanceEditable] = useState<string[]>(initialEditable);
  const [appliedSignature, setAppliedSignature] = useState(() => draftSignature(typeof initialArch['systemAssetId'] === 'string' ? initialArch['systemAssetId'] : '', resolveSystemParameters(type, initialArch['parameters']), initialEditable));
  const [applying, setApplying] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [position, setPosition] = useState(() => ({ x: Math.max(16, window.innerWidth - Math.min(960, window.innerWidth - 32) - 20), y: 68 }));
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const lineBased = LINE_SYSTEM_TYPES.includes(type);
  const chosenForTool = useAppState((state) => state.ui.systemAssets[type]?.id ?? '');
  const dirty = draftSignature(selectedId, parameters, instanceEditable) !== appliedSignature;
  const incompleteProfile = SYSTEM_PARAMETER_DEFINITIONS[type].some((definition) => {
    if (definition.kind !== 'profile' || (definition.visibleWhen && !definition.visibleWhen(parameters))) return false;
    const value = parameters[definition.key];
    const minimum = definition.key === 'bezierHandles' ? 2 : 3;
    return isProfile(value) && value.length > 0 && value.length < minimum;
  });
  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('You have unapplied changes. Close without applying them?')) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    let cancelled = false;
    const load = catalog.loadSystemTypes ? catalog.loadSystemTypes(type) : Promise.resolve<CatalogAsset[]>([]);
    void load.then((list) => !cancelled && setAssets(list)).catch(() => !cancelled && setAssets([]));
    return () => {
      cancelled = true;
    };
  }, [catalog, type, reloadKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [requestClose]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const selected = useMemo(() => assets.find((asset) => asset.id === selectedId), [assets, selectedId]);
  const view = selected?.views;
  const choose = (id: string) => {
    setSelectedId(id);
    const asset = assets.find((candidate) => candidate.id === id);
    setParameters(resolveSystemParameters(type, asset?.systemParameters ?? {}));
    setInstanceEditable(instanceParameterKeys(type, asset?.instanceEditable));
  };
  const importPresets = async () => {
    const file = await pickFile('.json,.cai,application/json,application/zip');
    if (!file) return;
    const result = await dispatch('import-system-presets', { type, bytes: file });
    if (!result.ok) {
      toasts.push({ kind: 'error', message: result.error.message });
      return;
    }
    toasts.push({ kind: 'success', message: `Imported ${String(result.value)} ${title(type).toLowerCase()} preset(s)` });
    setReloadKey((key) => key + 1);
  };
  const importType = async () => {
    const bytes = await pickFile();
    if (!bytes) return;
    const result = await dispatch('import-cai-package', { bytes });
    if (!result.ok) return;
    const asset = result.value as CatalogAsset | null;
    if (!asset || asset.kind !== 'system' || asset.systemType !== type) {
      toasts.push({ kind: 'error', message: `That package is not a ${title(type).toLowerCase()} type` });
      return;
    }
    setReloadKey((key) => key + 1);
    setSelectedId(asset.id);
    setParameters(resolveSystemParameters(type, asset.systemParameters ?? {}));
    setInstanceEditable(instanceParameterKeys(type, asset.instanceEditable));
  };
  const apply = async () => {
    setApplying(true);
    const result = selectedId && !selected
      ? await dispatch('set-system-configuration', { id: element.id, assetId: selectedId, assetName: initialArch['systemAssetName'], parameters, instanceEditable, applyTo })
      : await dispatch('apply-system-asset', { id: element.id, asset: selected ?? null, parameters, instanceEditable, applyTo });
    setApplying(false);
    if (result.ok) setAppliedSignature(draftSignature(selectedId, parameters, instanceEditable));
  };

  const set = (key: string, value: SystemParameterValue) => {
    if (instanceEditable.includes(key)) return;
    setParameters((current) => ({ ...current, [key]: value }));
  };
  const mineId = localPresetsId(type);
  const mine = assets.filter((asset) => asset.packageId === mineId);
  const remote = assets.filter((asset) => !asset.isLocal);
  const local = assets.filter((asset) => asset.isLocal && asset.packageId !== mineId);
  const currentInstanceParameters = resolveSystemParameters(type, initialArch['parameters']);
  const previewParameters = { ...parameters, ...Object.fromEntries(instanceEditable.map((key) => [key, currentInstanceParameters[key]!])) };
  const dimensions = systemDimensionParameters(type, previewParameters);
  const layers = isLayerList(previewParameters['layers']) ? previewParameters['layers'] : null;
  const liveSection = type === 'wall' && layers ? `data:image/svg+xml;utf8,${encodeURIComponent(wallSectionSvg(layers))}` : undefined;
  const liveTop = generatedPreview(type, previewParameters, 'top');
  const liveFront = generatedPreview(type, previewParameters, 'front');
  const liveSide = generatedPreview(type, previewParameters, 'side');
  const savePreset = async () => {
    const name = presetName.trim() || selected?.name || 'Preset';
    const result = await dispatch('save-system-preset', { type, name, parameters, instanceEditable });
    if (!result.ok) return;
    setPresetName('');
    setReloadKey((key) => key + 1);
    setSelectedId(String(result.value));
  };
  const updatePreset = async () => {
    if (!selected || selected.packageId !== mineId) return;
    const result = await dispatch('save-system-preset', { type, name: selected.name, parameters, instanceEditable });
    if (!result.ok) return;
    setReloadKey((key) => key + 1);
    setSelectedId(String(result.value));
    toasts.push({ kind: 'success', message: `${selected.name} preset updated` });
  };
  const deletePreset = async () => {
    if (!selected?.presetId) return;
    const result = await dispatch('delete-system-preset', { type, presetId: selected.presetId });
    if (!result.ok) return;
    setSelectedId('');
    setReloadKey((key) => key + 1);
  };
  const chooseForTool = async () => {
    await dispatch('select-system-asset', { systemType: type, asset: selected ?? null });
    await dispatch('set-tool', { tool: 'select' });
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, select')) return;
    dragRef.current = { pointerId: event.pointerId, dx: event.clientX - position.x, dy: event.clientY - position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setPosition({
      x: Math.max(8, Math.min(window.innerWidth - 280, event.clientX - current.dx)),
      y: Math.max(8, Math.min(window.innerHeight - 72, event.clientY - current.dy)),
    });
  };
  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return createPortal(
    <div className={styles.floatingLayer} role="presentation">
      <section className={styles.dialog} style={{ left: position.x, top: position.y }} role="dialog" aria-modal="false" aria-label={`${title(type)} configuration`} data-testid="system-config-dialog">
        <header className={styles.header} onPointerDown={startDrag} onPointerMove={drag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
          <h2><GripHorizontal size={15} aria-hidden="true" /> {title(type)}{applyTo === 'instance' ? ' · This instance' : ''}</h2>
          <button type="button" onClick={requestClose} aria-label="Close configuration"><X size={19} /></button>
        </header>
        <div className={`${styles.body} ${type === 'stair' ? styles.bodyNoPreview : ''}`}>
          {type !== 'stair' && <div className={lineBased ? styles.previewsLine : styles.previews}>
            {lineBased ? (
              <View label="Section" url={liveSection ?? liveFront} className={styles.section} />
            ) : (
              <>
                <View label="Side" url={liveSide} className={styles.side} />
                <View label="Top" url={liveTop} className={styles.top} />
                <View label="Front" url={liveFront} className={styles.front} />
              </>
            )}
          </div>}
          <aside className={styles.controls}>
            <div className={styles.configuration}>
              <span>Type · shared parameters</span>
              <select className={styles.typeSelect} value={selectedId} aria-label="System configuration" onChange={(event) => choose(event.target.value)}>
                <option value="">Default {title(type)}</option>
                {selectedId && !selected && <option value={selectedId}>{String(initialArch['systemAssetName'] ?? 'Current type')}</option>}
                {mine.length > 0 && (
                  <optgroup label="My presets">
                    {mine.map((asset) => (
                      <option key={asset.id} value={asset.id}>{asset.name}</option>
                    ))}
                  </optgroup>
                )}
                {remote.length > 0 && (
                  <optgroup label="Library">
                    {remote.map((asset) => (
                      <option key={asset.id} value={asset.id}>{asset.name}</option>
                    ))}
                  </optgroup>
                )}
                {local.length > 0 && (
                  <optgroup label="Local">
                    {local.map((asset) => (
                      <option key={asset.id} value={asset.id}>{asset.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <div className={styles.configCard}>
                {view?.top?.url || view?.section?.url || selected?.image.url ? <img src={view?.top?.url ?? view?.section?.url ?? selected?.image.url} alt="Selected type" /> : <div className={styles.lineIcon} />}
                <div><strong>{selected?.name ?? `Default ${title(type)}`}</strong><small>{selected ? (selected.packageId === mineId ? 'My preset' : selected.isLocal ? 'Local package' : 'Library package') : 'Built-in geometry'}</small></div>
              </div>
              <div className={styles.typeActions}>
                <TextButton onClick={() => void importType()}>Import…</TextButton>
                <TextButton onClick={() => void chooseForTool()} disabled={chosenForTool === selectedId}>{chosenForTool === selectedId ? 'Used for new' : 'Use for new'}</TextButton>
                {selected?.packageId === mineId && <TextButton onClick={() => void deletePreset()}>Delete</TextButton>}
              </div>
              <div className={styles.presetRow} data-testid="preset-row">
                <TextField value={presetName} placeholder="Preset name" onCommit={setPresetName} ariaLabel="Preset name" />
                <TextButton onClick={() => void savePreset()}>Save preset</TextButton>
                <TextButton onClick={() => void updatePreset()} disabled={!selected || selected.packageId !== mineId}>Update preset</TextButton>
                <TextButton onClick={() => void importPresets()}>Import presets</TextButton>
                <TextButton onClick={() => void dispatch('export-system-presets', { type })} disabled={mine.length === 0}>Export presets</TextButton>
              </div>
            </div>
            <div className={styles.parameterGroup}>
              <h3>Instance · identity and placement</h3>
              <p>Always editable per instance. These fields are intentionally locked in the shared type.</p>
              <div className={styles.lockedInstanceGrid}>
                <label><span>Name</span><input value={element.name ?? ''} disabled /></label>
                {!pathBased && <label><span>Location X</span><input value={element.x} disabled /></label>}
                {!pathBased && <label><span>Location Y</span><input value={element.y} disabled /></label>}
                {!pathBased && <label><span>Rotation</span><input value={element.rotation} disabled /></label>}
                {!pathBased && !dimensions.width && <label><span>Width · 2D</span><NumberField value={'width' in element ? element.width : bounds.width} unit={workspace.unit} precision={workspace.precision} disabled onCommit={() => {}} /></label>}
                {!pathBased && !dimensions.height && <label><span>Length · 2D</span><NumberField value={'height' in element ? element.height : bounds.height} unit={workspace.unit} precision={workspace.precision} disabled onCommit={() => {}} /></label>}
                <label><span>Elevation type</span><input value={element.meta?.['levelConstraint'] ? 'Level + offset' : 'Free'} disabled /></label>
                {mandatoryEditable.length === 0 && <label><span>Elevation · 3D</span><input value={instanceElevationOf(element)} disabled /></label>}
                {levelLink && <>
                  <label><span>Linked level</span><input value={typeof levelLink['levelId'] === 'string' ? doc.elements[levelLink['levelId']]?.name ?? levelLink['levelId'] : ''} disabled /></label>
                  <label><span>Level offset</span><NumberField value={Number(levelLink['offset'] ?? 0)} unit={workspace.unit} precision={workspace.precision} disabled ariaLabel="Level offset" onCommit={() => {}} /></label>
                </>}
                {hostId && <label><span>Host</span><input value={doc.elements[hostId]?.name ?? hostId} disabled /></label>}
                {Boolean(element.meta?.['stairSide']) && <label><span>Stair railing side</span><input value={String(element.meta?.['stairSide'])} disabled /></label>}
                {definition && type !== 'door' && <label><span>Uniform scale</span><NumberField value={element.kind === 'instance' && definition.width ? element.width / definition.width * 100 : 100} suffix="%" disabled ariaLabel="Uniform scale" onCommit={() => {}} /></label>}
                {element.kind === 'instance' && type !== 'door' && type !== 'window' && <label><span>Element level of detail</span><input value={elementLod(element) ?? 'Follow the view'} disabled /></label>}
                {type === 'wall' && <label><span>Join with neighbouring walls</span><input value={wallEndsJoined(element) ? 'On' : 'Off'} disabled /></label>}
                <label><span>Pinned</span><input type="checkbox" checked={element.locked} disabled /></label>
                <label><span>Visible</span><input type="checkbox" checked={element.visible} disabled /></label>
                <label><span>Display settings</span><input value={Object.keys(elementGraphicOverrides(element)).length ? 'Instance overrides' : 'Type defaults'} disabled /></label>
              </div>
              {pathBased && element.kind === 'line' && <PathGeometryFields element={element} readOnly />}
            </div>
            <div className={styles.parameterGroup}><h3>Parameter ownership</h3><p>Check a parameter to edit it independently in the instance inspector. Uncheck it to share its value across this type. Instance-only parameters cannot become type parameters.</p></div>
            <div className={styles.parameterList}>
              {SYSTEM_PARAMETER_DEFINITIONS[type].map((parameter) => {
                if (type === 'wall' && (WALL_PATH_KEYS as readonly string[]).includes(parameter.key)) return null;
                if (parameter.visibleWhen && !parameter.visibleWhen(previewParameters)) return null;
                const value = (instanceEditable.includes(parameter.key) ? currentInstanceParameters[parameter.key] : parameters[parameter.key]) ?? parameter.defaultValue;
                const label = parameter.note ? `${parameter.label} (${parameter.note})` : parameter.label;
                const editableFlag = (
                  <label className={styles.editableFlag} title={mandatoryEditable.includes(parameter.key) ? 'This parameter is always editable per instance' : 'Allow this parameter to be changed per instance'}>
                    <span>{mandatoryEditable.includes(parameter.key) ? 'Instance only · locked' : instanceEditable.includes(parameter.key) ? 'Instance · edit in inspector' : 'Type · shared'}</span>
                    <input
                      type="checkbox"
                      aria-label={`Edit ${parameter.label} per instance`}
                      checked={instanceEditable.includes(parameter.key)}
                      disabled={mandatoryEditable.includes(parameter.key)}
                      onChange={(event) => {
                        if (!event.target.checked) setParameters((current) => ({ ...current, [parameter.key]: currentInstanceParameters[parameter.key] ?? parameter.defaultValue }));
                        setInstanceEditable((current) => event.target.checked ? [...new Set([...current, parameter.key])] : current.filter((key) => key !== parameter.key));
                      }}
                    />
                  </label>
                );
                if (parameter.kind === 'layers') {
                  return (
                    <fieldset key={parameter.key} className={styles.parameter} disabled={instanceEditable.includes(parameter.key)} data-instance-editable={instanceEditable.includes(parameter.key) || undefined}><legend>{editableFlag}</legend><Field label={label}>
                      <LayersEditor value={isLayerList(value) ? value : []} onChange={(layers) => set(parameter.key, layers as unknown as SystemParameterValue)} />
                    </Field></fieldset>
                  );
                }
                if (parameter.kind === 'boolean') {
                  return <fieldset key={parameter.key} className={styles.parameter} disabled={instanceEditable.includes(parameter.key)} data-instance-editable={instanceEditable.includes(parameter.key) || undefined}><legend>{editableFlag}</legend><ToggleRow label={label} value={Boolean(value)} onChange={(next) => set(parameter.key, next)} /></fieldset>;
                }
                if (parameter.kind === 'profile') {
                  const profile = isProfile(value) ? value : [];
                  return (
                    <fieldset key={parameter.key} className={styles.parameter} disabled={instanceEditable.includes(parameter.key)} data-instance-editable={instanceEditable.includes(parameter.key) || undefined}><legend>{editableFlag}</legend><div className={styles.compositeField}>
                      <span className={styles.parameterLabel}>{label}</span>
                      <ProfileEditor disabled={instanceEditable.includes(parameter.key)} value={profile} spatial={type === 'curtain-wall'} onChange={(next) => set(parameter.key, next as unknown as SystemParameterValue)} />
                    </div></fieldset>
                  );
                }
                return (
                  <fieldset key={parameter.key} className={styles.parameter} disabled={instanceEditable.includes(parameter.key)} data-instance-editable={instanceEditable.includes(parameter.key) || undefined}><legend>{editableFlag}</legend><FieldRow single>
                    <Field label={label}>
                      {parameter.kind === 'number' ? (
                        <NumberField value={Number(value)} unit={parameter.unit === 'length' ? workspace.unit : undefined} precision={workspace.precision} onCommit={(next) => set(parameter.key, next)} ariaLabel={parameter.label} />
                      ) : (
                        <SelectField value={String(value)} options={[...(parameter.options ?? [])]} onChange={(next) => set(parameter.key, next)} ariaLabel={parameter.label} />
                      )}
                    </Field>
                  </FieldRow></fieldset>
                );
              })}
            </div>
          </aside>
        </div>
        <footer className={styles.footer}>
          <span className={styles.previewHint}>Schematic preview · current instance + pending type edits.</span>
          {incompleteProfile && <span className={styles.dirtyState}>Profile needs at least 3 points</span>}
          {dirty && <span className={styles.dirtyState}>Unapplied changes</span>}
          <TextButton onClick={requestClose}>Close</TextButton>
          <TextButton primary disabled={applying || !dirty || incompleteProfile} onClick={() => void apply()}>{applying ? 'Applying…' : 'Apply'}</TextButton>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
