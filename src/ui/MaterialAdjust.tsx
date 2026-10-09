/**
 * Quick material controls for the material picked in a scene (3D workspace and ArchAI Render), in
 * the spirit of D5's material panel: real-world scale, rotation, offset, tint, roughness, metal,
 * bump and opacity, with a live preview while dragging and one undo step on release, plus
 * "Make unique" to give the clicked face / object its own copy before changing it.
 */
import { Copy, Lock, SlidersHorizontal, Unlock, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Material } from '@/document';
import styles from './MaterialAdjust.module.css';

export type MaterialPatch = Partial<Pick<Material, 'tileWidth' | 'tileHeight' | 'rotation' | 'offsetX' | 'offsetY' | 'color' | 'roughness' | 'metalness' | 'normalStrength' | 'opacity'>>;

export interface MaterialAdjustProps {
  material: Material;
  /** Swatch image (data URL / URL), or null for a colour chip. */
  swatch: string | null;
  /** How many elements use it (shown so the user knows the edit is shared). */
  users: number;
  /** `commit: false` while a slider is dragged (preview), true on release. */
  onPatch(patch: MaterialPatch, commit: boolean): void;
  /** Copies the material for the picked face / object only (absent when nothing was picked). */
  onMakeUnique?: () => void;
  /** Opens the full material editor. */
  onMore?: () => void;
  onClose(): void;
  tone?: 'light' | 'dark';
  /** What the material was picked from ("Wall · side A"). */
  context?: string;
}

const log = (value: number) => Math.log10(Math.max(1, value));
const unlog = (value: number) => Math.round(10 ** value);

export function MaterialAdjust({ material, swatch, users, onPatch, onMakeUnique, onMore, onClose, tone = 'light', context }: MaterialAdjustProps) {
  // Local values follow the material until the user drags, so sliders never jump back.
  const [edit, setEdit] = useState<{ of: Material; patch: MaterialPatch }>({ of: material, patch: {} });
  const [lockAspect, setLockAspect] = useState(true);
  // The draft belongs to one version of the material: a new version (the edit landed) resets it.
  const draft = edit.of === material ? edit.patch : {};
  const value = <K extends keyof MaterialPatch>(key: K): NonNullable<MaterialPatch[K]> => (draft[key] ?? material[key]) as NonNullable<MaterialPatch[K]>;
  const change = (patch: MaterialPatch, commit: boolean) => {
    setEdit((e) => ({ of: material, patch: { ...(e.of === material ? e.patch : {}), ...patch } }));
    onPatch(patch, commit);
  };
  const aspect = material.tileHeight / Math.max(1, material.tileWidth);
  const textured = Boolean(material.map);

  const slider = (label: string, key: keyof MaterialPatch, min: number, max: number, step: number, format: (v: number) => string, map?: { to: (v: number) => number; from: (v: number) => number; patch?: (v: number) => MaterialPatch }) => {
    const current = Number(value(key));
    const shown = map ? map.to(current) : current;
    const patchOf = (raw: number): MaterialPatch => {
      const real = map ? map.from(raw) : raw;
      return map?.patch ? map.patch(real) : ({ [key]: real } as MaterialPatch);
    };
    return (
      <label className={styles.slider}>
        <span>
          {label}
          <em>{format(current)}</em>
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={shown}
          onChange={(e) => change(patchOf(Number(e.target.value)), false)}
          onPointerUp={(e) => change(patchOf(Number((e.target as HTMLInputElement).value)), true)}
          onKeyUp={(e) => change(patchOf(Number((e.target as HTMLInputElement).value)), true)}
        />
      </label>
    );
  };

  const metres = (mm: number) => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`);
  const sizeMap = (other: 'tileHeight' | 'tileWidth') => ({
    to: log,
    from: unlog,
    patch: (v: number): MaterialPatch => (lockAspect ? (other === 'tileHeight' ? { tileWidth: v, tileHeight: Math.max(10, Math.round(v * aspect)) } : { tileHeight: v, tileWidth: Math.max(10, Math.round(v / aspect)) }) : other === 'tileHeight' ? { tileWidth: v } : { tileHeight: v }),
  });

  return (
    <div className={styles.panel} data-tone={tone} data-testid="material-adjust" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <span className={styles.swatch} style={swatch ? { backgroundImage: `url(${swatch})` } : { background: material.color }} />
        <div>
          <strong title={material.name}>{material.name}</strong>
          <small>{context ? `${context} · ` : ''}{material.id.startsWith('default:') ? 'built-in default: every part that shows it' : users === 1 ? 'used once' : `used by ${users} elements`}</small>
        </div>
        <button type="button" className={styles.icon} onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </header>
      <div className={styles.actions}>
        {onMakeUnique && (
          <button type="button" onClick={onMakeUnique} title="Give the picked face / object its own copy of this material, so changes apply to it only">
            <Copy size={13} /> Make unique
          </button>
        )}
        {onMore && (
          <button type="button" onClick={onMore} title="Textures, pattern, glass, emission and section hatch">
            <SlidersHorizontal size={13} /> All settings
          </button>
        )}
      </div>
      {textured ? (
        <Group title="Texture">
          <div className={styles.sizeRow}>
            {slider('Width', 'tileWidth', 1, 4.3, 0.01, metres, sizeMap('tileHeight'))}
            <button type="button" className={styles.icon} onClick={() => setLockAspect((l) => !l)} title={lockAspect ? 'Width and height scale together' : 'Width and height scale separately'} aria-pressed={lockAspect}>
              {lockAspect ? <Lock size={13} /> : <Unlock size={13} />}
            </button>
          </div>
          {!lockAspect && slider('Height', 'tileHeight', 1, 4.3, 0.01, metres, sizeMap('tileWidth'))}
          {slider('Rotation', 'rotation', -180, 180, 1, (v) => `${Math.round(v)}°`)}
          {slider('Offset X', 'offsetX', -material.tileWidth, material.tileWidth, 1, metres)}
          {slider('Offset Y', 'offsetY', -material.tileHeight, material.tileHeight, 1, metres)}
        </Group>
      ) : null}
      <Group title="Surface">
        <label className={styles.colour}>
          <span>{textured ? 'Tint' : 'Colour'}</span>
          <input type="color" value={value('color')} onChange={(e) => change({ color: e.target.value }, false)} onBlur={(e) => change({ color: e.target.value }, true)} />
          <em>{value('color')}</em>
        </label>
        {slider('Roughness', 'roughness', 0, 1, 0.01, (v) => v.toFixed(2))}
        {slider('Metal', 'metalness', 0, 1, 0.01, (v) => v.toFixed(2))}
        {(material.normalMap || material.map) && slider('Bump', 'normalStrength', 0, 4, 0.05, (v) => v.toFixed(2))}
        {slider('Opacity', 'opacity', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group}>
      <h5>{title}</h5>
      {children}
    </section>
  );
}
